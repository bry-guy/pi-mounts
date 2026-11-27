# pi-mounts

Runs [pi](https://github.com/earendil-works/pi)'s built-in tools (`read`, `write`, `edit`, `bash`, `ls`, `find`,
`grep`) in a [Gondolin](https://github.com/earendil-works/gondolin) micro-VM for sandboxed
[pi-projects](https://github.com/bry-guy/pi-projects) sessions. macOS (HVF) first.

A session is sandboxed when it's a role run (`PI_ROLE`, started by `role_agent`) or its project's signed grant has
`sandbox: true` (`/project sandbox on`). Roles, grants and the threat model are in pi-projects
`docs/agent-roles.md`. Secrets come from [pi-secret-broker](https://github.com/bry-guy/pi-secret-broker).

## What the agent sees

Host paths are mounted at the same absolute paths, so tool paths don't change.

| Path | Access |
|---|---|
| project folder, `repos/<repo>` | read-only |
| `repos/<repo>/.git`, `worktrees/`, `artifacts/` | read-write |
| `project.json`, and at any depth `.pi/`, `.env*`, `.envrc`, `fnox.local.toml` | hidden; can't be created. Inside code checkouts, files git tracks stay visible (they're in the repo anyway; hiding them shows as deletions an agent could commit) |
| `/root` | per-role persistent home (`~/.cache/pi-mounts/home/<role>`): mise tools, npm cache |
| everything else on the Mac | not there |

Hidden paths that exist when the VM starts are handed to Gondolin as a fixed list, so it serves the mounts straight
from the host disk. A check on every guest file operation covers hidden names that appear later (a `.env` dropped
into a worktree) and refuses to create them. `.git` and `node_modules` are not searched for the list.

- **Network:** only package registries and tool downloads (`DEFAULT_EGRESS` in `src/vm.ts`) plus the role's `egress`.
  Anything else gets `403 blocked by policy`. Tailnet and private addresses are blocked too, so the k3s API goes
  through a broker action.
- **Secrets:** each role secret appears as a placeholder (e.g. `$GH_TOKEN`), which the host swaps for the real value
  only in requests to that secret's hosts. With `GH_TOKEN`, git over HTTPS to github.com just works.
- **Git identity:** commits are authored by the host user (their `user.name`/`user.email`) and committed by the
  role's `git` identity; with no host identity the role is both.
- **Host tools:** a sandboxed session may only use the VM tools plus `todo`, `ask_user_question`, `advisor`,
  subagents, `role_agent`, `broker_run`, `project_worktree`, `project_remember` and the role's `tools`.
  Other extension tools (MCP, pi-lens, pi-lsp, web search) are blocked, since they run on the host.
- **Fail closed:** if the VM can't start, every tool call is refused.
- Subagents (`@gotgenes/pi-subagents`) reload installed packages, so their tools run in the same VM. This holds only
  when pi-mounts is installed as a package; `pi -e` children don't load it.

## Setup

```bash
pi install npm:@bry-guy/pi-mounts
~/.pi/agent/npm/node_modules/@bry-guy/pi-mounts/scripts/setup.sh   # builds the VM image into ~/.cache/pi-mounts (needs docker)
```

From git instead:

```bash
pi install git:github.com/bry-guy/pi-mounts
~/.pi/agent/git/github.com/bry-guy/pi-mounts/scripts/setup.sh
```

Optional `~/.pi/agent/pi-mounts.json`:

```json
{ "gondolin": "/path/to/gondolin/host/dist/src/index.js", "image": "~/.cache/pi-mounts/pi-local-sandbox", "memory": "4G", "cpus": 4 }
```

`gondolin` points at a local build of upstream `main` (`~/dev/gondolin`): the native engine pi-mounts runs on is
newer than the last npm release (0.14.0). Build the host (`pnpm run build` in `host/`) and the daemon in release mode
(`make release` in `native/`); a debug daemon is about 1.5x slower on a test run.

Set `GONDOLIN_CLI` for `setup.sh` to the same build.

The image is `pi-local-sandbox` (`image/pi-local-sandbox/Containerfile`): Fedora minimal with bash, git, gh, ripgrep,
fd, curl, jq, make, python and mise. It holds tools only; pi runs on the host, and node comes from mise per repo.
It also ships busybox's `udhcpc` and iproute's `ip`, which bring up the guest's network at boot: Gondolin's krun backend
boots without the initramfs that does this under qemu, so the rootfs has to. Rebuild the assets after changing the image.
`setup.sh` builds it with docker and turns it into Gondolin assets through Gondolin's `oci` rootfs. CI publishes it
multi-arch as `ghcr.io/bry-guy/pi-local-sandbox`, for building your own image `FROM` it.

## OAuth logins kept on the host

A role secret of kind `oauth2` lets a CLI in the VM sign in and refresh on its own while the VM only ever holds
placeholders. This works for logins that expire and refresh through a standard OAuth 2 token endpoint.

```json
"secrets": {
  "GOOGLE": {
    "kind": "oauth2",
    "tokenUrl": "https://oauth2.googleapis.com/token",
    "hosts": ["cloudcode-pa.googleapis.com"],
    "placeholderPrefix": { "access": "ya29.", "refresh": "1//" }
  }
}
```

- **The grants source** must be writable (`keychain:` or `file:`), e.g. `"GOOGLE": "keychain:agy-<role>"`. It holds the
  real refresh token, which pi-secret-broker's `storeSecret` writes.
- **Token calls.** pi-mounts answers the CLI's POSTs to `tokenUrl` itself (form or JSON bodies).
  - It swaps the real refresh token into the request and sends it from the host.
  - It keeps the new access token in Gondolin's secret manager and returns placeholders.
  - A new refresh token, issued at sign-in or on rotation, goes to the grants source.
  - Before sign-in, refreshes fail with `invalid_grant`.
- **Access tokens.** Gondolin swaps the access placeholder into request headers for the secret's `hosts` only.
- **Placeholders** are kept in `~/.cache/pi-mounts/oauth/<role>/<name>.json`. `placeholderPrefix` makes them look like
  the provider's tokens, for CLIs that check the shape.
- **Signing in.** Run the CLI's own login in the VM with `/vm-exec <cli> ...` (below); its code exchange goes through
  the same handler.
- **Limits.**
  - Code in the VM can use the access placeholder against the listed hosts while the VM runs, but can't take the token
    out.
  - Extra fields in token replies, such as an OpenID `id_token`, pass through as is.
  - Tokens sent in URLs or request bodies, rather than headers, aren't swapped.

`egressPaths` limits a host to path prefixes, for example `{ "www.googleapis.com": ["/oauth2/"] }`. It's useful when a
broad token would otherwise open other APIs on an allowed host.

## Running host-started programs in the VM

Every sandboxed pi process runs an exec relay on a host-only Unix socket (`PI_MOUNTS_EXEC_SOCKET`).

- `bin/vm-exec.mjs <command> [args]` runs the command in the session's VM. It passes through stdin, stdout, stderr and
  the exit code. From a terminal it runs in a pty. Killing `vm-exec` kills the command.
- Outside a sandboxed process it runs the command on the host. A sandboxed process without the relay refuses.
- For an extension that starts a CLI from a configurable path, point that path at a shim that calls
  `run("<command>", argv)`, like `bin/agy-vm.mjs`.
- `/vm-exec <command>` in pi prints the line to run in another terminal, for interactive steps such as a CLI's login.

## Host ports in the VM

`"hostPorts": [5432]` in the role file makes the host's `127.0.0.1:5432` reachable at the same address in the VM.

- A forwarder in the VM carries each connection over Gondolin's raw TCP mapping (`pi-host.internal:7777`) to a host
  relay. Replies stream.
- The relay connects only to ports opened for that VM.
- Setting `hostPorts`, even to `[]`, also lets pi-mounts open ports at run time (the agy recipe below does this).

## Recipe: Antigravity (agy)

[`@estebanforge/pi-antigravity-bridge`](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge) drives the `agy`
CLI. The three features above run it in the role's VM with the Google login kept on the host.

**Status:** unit-tested only. Before relying on it, check against a live account:

- `agy` accepts the placeholder tokens;
- it works through Gondolin's HTTP/1.1 interception;
- the exact list of Google hosts it needs.

```json
"secrets": { "GOOGLE": { "kind": "oauth2", "tokenUrl": "https://oauth2.googleapis.com/token",
                         "hosts": ["cloudcode-pa.googleapis.com"], "placeholderPrefix": { "access": "ya29.", "refresh": "1//" } } },
"egress": ["oauth2.googleapis.com", "cloudcode-pa.googleapis.com", "www.googleapis.com"],
"egressPaths": { "www.googleapis.com": ["/oauth2/"] },
"hostPorts": []
```

1. Start pi with `AGY_BIN=<pi-mounts>/bin/agy-vm.mjs` and `AGY_APPROVALS=off`. The bridge's approval gate would
   replace pi-mounts' VM `bash`/`edit`/`write` with host ones.
2. Sign in once with `/vm-exec agy` and pick Google sign-in.

What the `agy` adapter (`src/agy.ts`) adds:

- It drops the bridge's `--gemini-dir`, a host folder linked to the host's own agy login. `agy` uses the role's home
  in the VM instead.
- When the bridge hands `agy` its MCP server (pi's tools) in `session/new`, it opens that host port in the VM first.

The image carries a pinned `agy` build, checked by sha512. It can't update itself in the VM, so bump `AGY_BUILD` in the
Containerfile to update it.

The bridge's artifact list and background-task watcher read the host's `~/.gemini`, so they show nothing for VM runs.

## Checks

`npm test` (unit + one VM test) and `npm run spike` (the full M1 check list, prints PASS/FAIL; `PUSH_REPO=owner/repo`
also tests a push with an injected token).

## Limits

- Code the agent writes in `.git` (hooks) is never run by host git in pi-projects or pi-sync, which pass
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Other host tools that run git in a worktree may still run them.
- Aborting a command kills its process group in the guest. A VM is shared by every session of one pi process for the
  same project and role, and closes 30 s after the last one ends.
