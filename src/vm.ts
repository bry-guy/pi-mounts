// One Gondolin VM per project + role, shared by every session of this pi process (subagent children included).
// Host paths are mounted at the same absolute paths, so pi's tools keep their paths.
import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { hostPortRelay, hostPortVmOptions, openHostPort, registerHostPorts } from "./host-ports.ts";
import { type OAuthLogin, pathsAllowed, tokenFacade } from "./oauth.ts";

export interface Config {
	/** Gondolin host module (dist/src/index.js); a locally patched build until upstream has the fix */
	gondolin?: string;
	/** Gondolin assets dir built from image/pi-local-sandbox (scripts/setup.sh) */
	image?: string;
	memory?: string;
	cpus?: number;
}

export interface Policy {
	projectPath: string;
	/** Extra paths the project folder is also reached by (e.g. the session cwd before realpath) */
	aliases?: string[];
	/** Role id, or undefined for a sandbox with no grants */
	roleId?: string;
	egress: string[];
	/** Secret name -> { hosts, value } */
	secrets: Record<string, { hosts: string[]; value: string }>;
	/** Re-reads secret values (short-lived tokens); called every 30 min while the VM runs. */
	refresh?: () => Record<string, string>;
	/** Commit identity inside the VM (the role's GitHub App bot). */
	git?: { name: string; email: string };
	/** The host user's git identity: commit author inside the VM (the role stays committer). */
	author?: { name: string; email: string };
	/** OAuth logins kept on the host (role secrets of kind "oauth2"); see src/oauth.ts */
	oauth?: OAuthLogin[];
	/** Hosts reachable only under these path prefixes (role "egressPaths") */
	egressPaths?: Record<string, string[]>;
	/** Host loopback ports reachable in the VM (role "hostPorts"); set (even empty) to let pi-mounts open more at run
	 *  time. See src/host-ports.ts */
	hostPorts?: number[];
}

export const CACHE = join(homedir(), ".cache", "pi-mounts");

/** Hosts every sandbox may reach: package registries and tool downloads. Roles add their own. */
export const DEFAULT_EGRESS = [
	"registry.npmjs.org",
	"github.com",
	"api.github.com",
	"codeload.github.com",
	"objects.githubusercontent.com",
	"release-assets.githubusercontent.com",
	"raw.githubusercontent.com",
	"nodejs.org",
	"unofficial-builds.nodejs.org",
	"mise.jdx.dev",
	"mise-versions.jdx.dev",
	"dl-cdn.alpinelinux.org",
	"pypi.org",
	"files.pythonhosted.org",
];

/** Names never visible to the agent, at any depth: role files, env files, local secret config. */
const HIDDEN = new Set([".pi", ".envrc", "fnox.local.toml"]);
export const isHidden = (p: string) => p.split("/").some((n) => HIDDEN.has(n) || n.startsWith(".env")) || p === "/project.json";

const trackedCache = new Map<string, { at: number; tracked: boolean }>();

/** Whether git tracks this host path (or files under it). Tracked files are already in the repo, so they stay
 *  visible: hiding them would show as deletions that an agent could commit. */
export function isTracked(hostPath: string): boolean {
	const hit = trackedCache.get(hostPath);
	if (hit && Date.now() - hit.at < 10_000) return hit.tracked;
	let tracked = false;
	try {
		const dir = dirname(hostPath);
		tracked = !!execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, "ls-files", "--", basename(hostPath)], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 5_000,
		}).trim();
	} catch {} // not in a repo
	trackedCache.set(hostPath, { at: Date.now(), tracked });
	return tracked;
}

export function loadConfig(): Config {
	const file = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "pi-mounts.json");
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return {};
	}
}

let gondolin: any;
export async function loadGondolin(cfg: Config): Promise<any> {
	gondolin ??= await import(cfg.gondolin || "@earendil-works/gondolin");
	return gondolin;
}

export const roleKey = (roleId?: string) => (roleId ?? "none").replace("/", "--");

/** Paths under `dir` (as mount paths, "/a/.env") that the sandbox must not see. In a code checkout, what git tracks
 *  stays visible. `.git` and `node_modules` are not searched: neither holds local secrets. */
export function hiddenPaths(dir: string, code: boolean, skip: string[] = []): string[] {
	const out: string[] = [];
	const walk = (rel: string) => {
		let entries: Dirent[];
		try {
			entries = readdirSync(join(dir, rel), { withFileTypes: true });
		} catch {
			return; // unreadable: nothing below it reaches the guest either
		}
		for (const e of entries) {
			const p = `${rel}/${e.name}`;
			const abs = join(dir, p);
			if (e.name === ".git" || e.name === "node_modules" || skip.includes(abs)) continue;
			if (isHidden(p) && !(code && isTracked(abs))) out.push(p);
			else if (e.isDirectory()) walk(p);
		}
	};
	walk("");
	return out;
}

interface Tree {
	/** Guest path */
	at: string;
	/** Host folder served there */
	dir: string;
	/** "code": a checkout, where files git tracks stay visible. "plain": nothing is hidden. */
	kind: "project" | "code" | "plain";
	readonly?: boolean;
}

/** What the guest sees of the project: the project read-only, repos' .git, worktrees/ and artifacts/ writable. */
function trees(p: Policy): Tree[] {
	const real = realpathSync(p.projectPath);
	const out: Tree[] = [];
	for (const base of new Set([real, ...(p.aliases ?? [])])) {
		// The project folder itself sits in the pi-projects state repo, whose tracked project.json must stay hidden.
		out.push({ at: base, dir: real, kind: "project", readonly: true });
		const repos = join(real, "repos");
		if (existsSync(repos)) {
			for (const r of readdirSync(repos)) {
				out.push({ at: join(base, "repos", r), dir: join(repos, r), kind: "code", readonly: true });
				if (existsSync(join(repos, r, ".git"))) out.push({ at: join(base, "repos", r, ".git"), dir: join(repos, r, ".git"), kind: "plain" });
			}
		}
		for (const d of ["worktrees", "artifacts"]) {
			mkdirSync(join(real, d), { recursive: true });
			out.push({ at: join(base, d), dir: join(real, d), kind: d === "worktrees" ? "code" : "project" });
		}
	}
	return out;
}

/** The VFS mounts. Hidden paths are a fixed list, not a callback: Gondolin serves a mount straight from the host disk
 *  only when it knows them up front. With a callback every file goes through this process, which is 2-3x slower.
 *  `hiddenGuard` covers paths that appear later. */
export function mounts(G: any, p: Policy): Record<string, unknown> {
	const all = trees(p);
	const out: Record<string, unknown> = {};
	for (const t of all) {
		let prov: unknown = new G.RealFSProvider(t.dir);
		if (t.kind !== "plain") {
			if (t.readonly) prov = new G.ReadonlyProvider(prov);
			// Folders mounted on their own are searched as their own tree.
			const nested = all.filter((o) => o.dir !== t.dir && o.dir.startsWith(`${t.dir}/`)).map((o) => o.dir);
			prov = new G.ShadowProvider(prov, { shouldShadow: G.createShadowPathPredicate(hiddenPaths(t.dir, t.kind === "code", nested)), writeMode: "deny" });
		}
		out[t.at] = prov;
	}
	const home = join(CACHE, "home", roleKey(p.roleId));
	mkdirSync(home, { recursive: true });
	out["/root"] = new G.RealFSProvider(home); // mise tools, npm cache; only placeholders ever reach it
	return out;
}

const CREATES = new Set(["mkdir", "symlink", "link", "rename", "mknod", "create"]);

/** A Gondolin `before` hook: refuses guest file operations on hidden paths. `mounts` already hides the ones that
 *  existed when the VM started; this covers a `.env` dropped into a worktree later, and keeps hidden names from
 *  being created. One round trip to this process per file operation (about 5% on an npm ci or a test run). */
export function hiddenGuard(p: Policy): (ctx: { op: string; path?: string; oldPath?: string; newPath?: string; flags?: string }) => void {
	const all = trees(p).sort((a, b) => b.at.length - a.at.length);
	return (ctx) => {
		for (const path of [ctx.path, ctx.oldPath, ctx.newPath]) {
			const t = path && all.find((o) => path === o.at || path.startsWith(`${o.at}/`));
			if (!path || !t || t.kind === "plain") continue;
			const rel = path.slice(t.at.length) || "/";
			const host = join(t.dir, rel);
			if (!isHidden(rel) || (t.kind === "code" && isTracked(host))) continue;
			// A hidden file reads as absent. One that isn't there stays absent too, but can't be created.
			if (existsSync(host)) throw Object.assign(new Error(`${path}: hidden from the sandbox`), { code: "ENOENT" });
			if (path !== ctx.oldPath && (CREATES.has(ctx.op) || (ctx.op === "open" && /[wa+]/.test(ctx.flags ?? "")))) throw Object.assign(new Error(`${path}: can't be created in the sandbox`), { code: "EACCES" });
		}
	};
}

export function guestEnv(p: Policy, placeholders: Record<string, string>): Record<string, string> {
	const git: [string, string][] = [["safe.directory", "*"]];
	if (placeholders.GH_TOKEN) {
		// Remotes cloned over SSH push over HTTPS with the token (no SSH keys in the VM).
		git.push(["url.https://github.com/.insteadOf", "ssh://git@github.com/"], ["url.https://github.com/.pushInsteadOf", "git@github.com:"]);
		git.push(["credential.https://github.com.helper", '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f']);
	}
	if (p.git) {
		const a = p.author ?? p.git;
		git.push(["user.name", p.git.name], ["user.email", p.git.email]);
		git.push(["committer.name", p.git.name], ["committer.email", p.git.email]);
		git.push(["author.name", a.name], ["author.email", a.email]);
	}
	const env: Record<string, string> = {
		...placeholders,
		HOME: "/root",
		PATH: "/root/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		MISE_YES: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_CONFIG_COUNT: String(git.length),
		PI_SANDBOX: p.roleId ?? "none",
	};
	git.forEach(([k, v], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = k;
		env[`GIT_CONFIG_VALUE_${i}`] = v;
	});
	return env;
}

/** The host user's git identity, or undefined if either part is unset or git fails. */
export function hostGitIdentity(): { name: string; email: string } | undefined {
	const get = (k: string) => {
		try {
			return execFileSync("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "config", "--get", k], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim();
		} catch {
			return "";
		}
	};
	const name = get("user.name");
	const email = get("user.email");
	return name && email ? { name, email } : undefined;
}

export async function createVm(cfg: Config, p: Policy): Promise<any> {
	const G = await loadGondolin(cfg);
	const image = cfg.image || join(CACHE, "pi-local-sandbox");
	if (!existsSync(join(image, "manifest.json"))) throw new Error(`No sandbox image at ${image}. Run scripts/setup.sh in pi-mounts.`);
	const oauth = p.oauth ?? [];
	const setAccess: Record<string, (token: string) => void> = {};
	const facades = oauth.map((l) => tokenFacade(l, (t) => setAccess[l.name]?.(t)));
	const { httpHooks, env, secretManager } = G.createHttpHooks({
		allowedHosts: [...new Set([...DEFAULT_EGRESS, ...p.egress])],
		// An OAuth access token's real value is known only after the CLI's first token call goes through its facade.
		secrets: { ...p.secrets, ...Object.fromEntries(oauth.map((l) => [l.name, { hosts: l.hosts, value: "", placeholder: l.access }])) },
		...(facades.length
			? {
					onRequest: async (req: Request) => {
						for (const f of facades) {
							const res = await f(req);
							if (res) return res;
						}
					},
				}
			: {}),
		...(p.egressPaths ? { isRequestAllowed: pathsAllowed(p.egressPaths) } : {}),
	});
	for (const l of oauth) setAccess[l.name] = (t) => secretManager.updateSecret(l.name, { value: t });
	const ports = p.hostPorts ? await hostPortRelay(p.hostPorts) : undefined;
	let vm: any;
	try {
		vm = await G.VM.create({
			sandbox: { imagePath: image },
			memory: cfg.memory ?? "4G",
			cpus: cfg.cpus ?? 4,
			vfs: { mounts: mounts(G, p), hooks: { before: hiddenGuard(p) } },
			httpHooks,
			env: guestEnv(p, env),
			...(ports ? hostPortVmOptions(ports) : {}),
		});
	} catch (e) {
		ports?.close();
		throw e;
	}
	if (ports) {
		registerHostPorts(vm, ports);
		for (const port of ports.allowed) openHostPort(vm, port).catch(() => {}); // best effort: the port stays closed
		const close = vm.close.bind(vm);
		vm.close = () => (ports.close(), close());
	}
	if (p.refresh && Object.keys(p.secrets).length) {
		const timer = setInterval(() => {
			try {
				for (const [name, value] of Object.entries(p.refresh!())) secretManager.updateSecret(name, { value });
			} catch {} // keep the old value; the next tick retries
		}, 30 * 60_000);
		timer.unref();
		const close = vm.close.bind(vm);
		vm.close = () => (clearInterval(timer), close());
	}
	return vm;
}

interface Entry {
	vm: Promise<any>;
	users: number;
	timer?: NodeJS.Timeout;
}
const vms = new Map<string, Entry>();

/** Shared VM for a project + role; release() closes it 30 s after the last user. */
export function acquire(cfg: Config, p: Policy): { vm: Promise<any>; release: () => void } {
	const key = `${realpathSync(p.projectPath)}::${p.roleId ?? ""}`;
	let e = vms.get(key);
	if (!e) {
		e = { vm: createVm(cfg, p), users: 0 };
		e.vm.catch(() => vms.delete(key)); // a failed boot is retried by the next session
		vms.set(key, e);
	}
	clearTimeout(e.timer);
	e.users++;
	const entry = e;
	let released = false;
	return {
		vm: entry.vm,
		release: () => {
			if (released) return;
			released = true;
			if (--entry.users > 0) return;
			entry.timer = setTimeout(() => {
				vms.delete(key);
				entry.vm.then((vm) => vm.close()).catch(() => {});
			}, 30_000);
			entry.timer.unref();
		},
	};
}
