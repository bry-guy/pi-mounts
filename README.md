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

- **Network:** only package registries and tool downloads (`DEFAULT_EGRESS` in `src/vm.ts`) plus the role's `egress`.
  Anything else gets `403 blocked by policy`. Tailnet and private addresses are blocked too, so the k3s API goes
  through a broker action.
- **Secrets:** each role secret appears as a placeholder (e.g. `$GH_TOKEN`), which the host swaps for the real value
  only in requests to that secret's hosts. With `GH_TOKEN`, git over HTTPS to github.com just works.
- **Host tools:** a sandboxed session may only use the VM tools plus `todo`, `ask_user_question`, `advisor`,
  subagents, `role_agent`, `broker_run`, `project_worktree`, `project_remember` and the role's `tools`.
  Other extension tools (MCP, pi-lens, pi-lsp, web search) are blocked, since they run on the host.
- **Fail closed:** if the VM can't start, every tool call is refused.
- Subagents (`@gotgenes/pi-subagents`) reload installed packages, so their tools run in the same VM. This holds only
  when pi-mounts is installed as a package; `pi -e` children don't load it.

## Setup

```bash
pi install git:github.com/bry-guy/pi-mounts
~/.pi/agent/git/github.com/bry-guy/pi-mounts/scripts/setup.sh   # builds the VM image into ~/.cache/pi-mounts (needs docker)
```

Optional `~/.pi/agent/pi-mounts.json`:

```json
{ "gondolin": "/path/to/gondolin/host/dist/src/index.js", "image": "~/.cache/pi-mounts/pi-local-sandbox", "memory": "4G", "cpus": 4 }
```

`gondolin` points at a local build (branch `local` in `~/dev/gondolin`) while two fixes are upstream:
- `fix/undici-7`: on Node 22 hosts, undici 6's `fetch` passes zstd bodies through undecoded, so some downloads arrive
  corrupted ([bry-guy/gondolin](https://github.com/bry-guy/gondolin), PR pending);
- `fix/tls-resumption`: on Node 26 hosts, a guest's second HTTPS connection (TLS session resumption, as git and curl
  do) fails with `tlsv1 alert decrypt error`; picking the certificate from the parsed SNI fixes it.

Set `GONDOLIN_CLI` for `setup.sh` to the same build.

The image is `pi-local-sandbox` (`image/pi-local-sandbox/Containerfile`): Fedora minimal with bash, git, gh, ripgrep,
fd, curl, jq, make, python and mise. It holds tools only; pi runs on the host, and node comes from mise per repo.
It also ships busybox's `udhcpc` and iproute's `ip`, which bring up the guest's network at boot: Gondolin's krun backend
boots without the initramfs that does this under qemu, so the rootfs has to. Rebuild the assets after changing the image.
`setup.sh` builds it with docker and turns it into Gondolin assets through Gondolin's `oci` rootfs. CI publishes it
multi-arch as `ghcr.io/bry-guy/pi-local-sandbox`, for building your own image `FROM` it.

## Checks

`npm test` (unit + one VM test) and `npm run spike` (the full M1 check list, prints PASS/FAIL; `PUSH_REPO=owner/repo`
also tests a push with an injected token).

## Limits

- Code the agent writes in `.git` (hooks) is never run by host git in pi-projects or pi-sync, which pass
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Other host tools that run git in a worktree may still run them.
- Aborting a command kills its process group in the guest. A VM is shared by every session of one pi process for the
  same project and role, and closes 30 s after the last one ends.
