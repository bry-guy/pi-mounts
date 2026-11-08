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
~/.pi/agent/git/github.com/bry-guy/pi-mounts/scripts/setup.sh   # image + musl mise into ~/.cache/pi-mounts
```

Optional `~/.pi/agent/pi-mounts.json`:

```json
{ "gondolin": "/path/to/gondolin/host/dist/src/index.js", "image": "~/.cache/pi-mounts/pi-worker", "memory": "4G", "cpus": 4 }
```

`gondolin` points at a local build while a fix is upstream: Gondolin 0.14 forwards the guest's `Accept-Encoding: zstd`,
which the host's fetch can't decode, so some downloads arrive corrupted. Set `GONDOLIN_CLI` for `setup.sh` to the same build.

The image (`image/pi-worker.json`) is Alpine with git, gh, ripgrep, fd, node, python and build tools. mise is the
upstream musl binary (Alpine's package compiles node from source); node installs use musl builds.

## Checks

`npm test` (unit + one VM test) and `npm run spike` (the full M1 check list, prints PASS/FAIL; `PUSH_REPO=owner/repo`
also tests a push with an injected token).

## Limits

- Code the agent writes in `.git` (hooks) is never run by host git in pi-projects or pi-sync, which pass
  `core.hooksPath=/dev/null` and `core.fsmonitor=false`. Other host tools that run git in a worktree may still run them.
- Aborting a command kills its process group in the guest. A VM is shared by every session of one pi process for the
  same project and role, and closes 30 s after the last one ends.
