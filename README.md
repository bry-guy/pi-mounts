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

## Antigravity (agy) in the VM

This lets a role use Antigravity models through
[`@estebanforge/pi-antigravity-bridge`](https://pi.dev/packages/@estebanforge/pi-antigravity-bridge), with `agy` and
its own tools running in the role's VM. The Google login stays on the host, and the VM only holds placeholders.

**Status:** unit-tested only. Before relying on it, check against a live account: `agy` must accept the placeholder
tokens and work through Gondolin's HTTP/1.1 interception. You also need its exact list of Google hosts.

It turns on when the role file declares a secret of kind `google-oauth`:

```json
"secrets": { "AGY_GOOGLE": { "kind": "google-oauth", "hosts": ["cloudcode-pa.googleapis.com"] } },
"egress": ["oauth2.googleapis.com", "cloudcode-pa.googleapis.com", "www.googleapis.com"]
```

In the signed grants file, its source must be writable (`keychain:` or `file:`), for example
`"AGY_GOOGLE": "keychain:agy-<role>"`. It holds the real refresh token, written by pi-secret-broker's `storeSecret`.

- **Starting agy.** Set `AGY_BIN` to `bin/agy-vm.mjs` (for example in the shell that starts pi) and `AGY_APPROVALS=off`.
  The bridge's approval gate would replace pi-mounts' VM `bash`/`edit`/`write` with host ones.
  - In a sandboxed process, the wrapper reaches pi-mounts over a host-only socket (`PI_MOUNTS_AGY_SOCKET`).
    pi-mounts runs `agy` in the VM with stdio piped through, and closing the socket kills it.
  - The bridge's `--gemini-dir` (a host folder linked to the host's own agy login) is dropped. `agy` uses the role's
    home in the VM.
  - Elsewhere the wrapper runs host `agy` (`PI_MOUNTS_HOST_AGY`, default `agy` on `PATH`). A sandboxed process
    without the socket fails instead.
- **Reaching pi's tools.** `agy` reaches the bridge's MCP server (pi's tools) in two hops. A forwarder in the VM
  listens on the bridge's port. Gondolin's TCP mapping then carries `pi-bridge.internal:7777` to a host relay that
  forwards to that port.
- **The login.**
  - The VM holds two placeholders, kept in `~/.cache/pi-mounts/agy/<role>.json`.
  - pi-mounts answers `agy`'s own calls to `https://oauth2.googleapis.com/token`. It swaps the real refresh token into
    the request, sends it from the host, keeps the new access token in Gondolin's secret manager and returns
    placeholders. A refresh token Google issues (at login or on rotation) goes to the grants source.
  - Gondolin swaps the access placeholder into `Authorization` only for the secret's `hosts`.
  - `www.googleapis.com` is limited to `/oauth2/*`, since the `cloud-platform` scope would otherwise open other APIs
    there.
- **Signing in.**
  1. Start pi as the role in the project (`PI_ROLE=<repo>/<role> pi`) and run `/agy-login`.
  2. It prints a command for another terminal. That command runs `agy` interactively in the VM, where you pick Google
     sign-in.
  3. The code exchange goes through the token handler, so the real tokens land only in the grants source.
- **The image** carries a pinned `agy` build, checked by sha512. It can't update itself in the VM, so bump
  `AGY_BUILD` in the Containerfile to update it.
- **Limits.**
  - Code in the VM can use the access placeholder while the VM runs, but only against the listed hosts, and it can't
    take the token out.
  - The `id_token` in token replies passes through as is.
  - The bridge's artifact list and background-task watcher read the host's `~/.gemini`, so they show nothing for VM
    runs.

## Checks

`npm test` (unit + one VM test) and `npm run spike` (the full M1 check list, prints PASS/FAIL; `PUSH_REPO=owner/repo`
also tests a push with an injected token).

## Limits

- Code the agent writes in `.git` (hooks) is never run by host git in pi-projects or pi-sync, which pass
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Other host tools that run git in a worktree may still run them.
- Aborting a command kills its process group in the guest. A VM is shared by every session of one pi process for the
  same project and role, and closes 30 s after the last one ends.
