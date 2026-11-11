// One Gondolin VM per project + role, shared by every session of this pi process (subagent children included).
// Host paths are mounted at the same absolute paths, so pi's tools keep their paths.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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

const roleKey = (roleId?: string) => (roleId ?? "none").replace("/", "--");

/** The VFS mounts: project read-only, repos' .git, worktrees/ and artifacts/ writable, hidden names shadowed. */
export function mounts(G: any, p: Policy): Record<string, unknown> {
	// `root` is set only for code checkouts; the project folder itself sits in the pi-projects state repo, whose
	// tracked project.json must stay hidden.
	const shadow = (prov: unknown, root?: string) =>
		new G.ShadowProvider(prov, {
			shouldShadow: ({ path }: { path: string }) => isHidden(path) && !(root && isTracked(join(root, path))),
			writeMode: "deny",
		});
	const ro = (dir: string, code = true) => shadow(new G.ReadonlyProvider(new G.RealFSProvider(dir)), code ? dir : undefined);
	const rw = (dir: string, code = true) => shadow(new G.RealFSProvider(dir), code ? dir : undefined);
	const real = realpathSync(p.projectPath);
	const out: Record<string, unknown> = {};
	for (const base of new Set([real, ...(p.aliases ?? [])])) {
		out[base] = ro(real, false);
		const repos = join(real, "repos");
		if (existsSync(repos)) {
			for (const r of readdirSync(repos)) {
				out[join(base, "repos", r)] = ro(join(repos, r));
				if (existsSync(join(repos, r, ".git"))) out[join(base, "repos", r, ".git")] = new G.RealFSProvider(join(repos, r, ".git"));
			}
		}
		for (const d of ["worktrees", "artifacts"]) {
			mkdirSync(join(real, d), { recursive: true });
			out[join(base, d)] = rw(join(real, d), d === "worktrees");
		}
	}
	const home = join(CACHE, "home", roleKey(p.roleId));
	mkdirSync(home, { recursive: true });
	out["/root"] = new G.RealFSProvider(home); // mise tools, npm cache; only placeholders ever reach it
	return out;
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

/** Process table access; tests swap these out. */
export const host = {
	dir: join(CACHE, "vms"),
	pid: process.pid,
	alive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code === "EPERM";
		}
	},
	command(pid: number): string | undefined {
		try {
			return execFileSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
		} catch {
			return undefined; // no such process
		}
	},
	kill(pid: number) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	},
};

/** A VM runner (qemu) this machine started: its full command line holds a per-VM QMP socket, so it tells a reused pid apart. */
interface VmRecord {
	pid: number;
	owner: number;
	command: string;
}

function records(): VmRecord[] {
	let files: string[];
	try {
		files = readdirSync(host.dir);
	} catch {
		return [];
	}
	return files.flatMap((f) => {
		try {
			return [JSON.parse(readFileSync(join(host.dir, f), "utf8"))];
		} catch {
			return [];
		}
	});
}

function reap(r: VmRecord) {
	if (host.command(r.pid) === r.command) host.kill(r.pid);
	rmSync(join(host.dir, `${r.pid}.json`), { force: true });
}

/** Kills VMs whose pi process died without closing them (SIGKILL, crash): no handler ran there. */
export function sweep() {
	for (const r of records()) if (!host.alive(r.owner)) reap(r);
}

/** Kills this process's VMs; runs on process exit, where the async close (and the 30 s timer) can't. */
export function reapOwn() {
	for (const r of records()) if (r.owner === host.pid) reap(r);
}

let exitHook = false;
function track(vm: any): () => void {
	const pid = vm.getHostPid?.();
	const command = pid && host.command(pid);
	if (!command) return () => {};
	const r: VmRecord = { pid, owner: host.pid, command };
	mkdirSync(host.dir, { recursive: true });
	writeFileSync(join(host.dir, `${pid}.json`), JSON.stringify(r));
	if (!exitHook) process.once("exit", reapOwn);
	exitHook = true;
	return () => reap(r);
}

export async function createVm(cfg: Config, p: Policy): Promise<any> {
	const G = await loadGondolin(cfg);
	const image = cfg.image || join(CACHE, "pi-local-sandbox");
	if (!existsSync(join(image, "manifest.json"))) throw new Error(`No sandbox image at ${image}. Run scripts/setup.sh in pi-mounts.`);
	sweep();
	const { httpHooks, env, secretManager } = G.createHttpHooks({
		allowedHosts: [...new Set([...DEFAULT_EGRESS, ...p.egress])],
		secrets: p.secrets,
	});
	const vm = await G.VM.create({
		sandbox: { imagePath: image },
		memory: cfg.memory ?? "4G",
		cpus: cfg.cpus ?? 4,
		vfs: { mounts: mounts(G, p) },
		httpHooks,
		env: guestEnv(p, env),
	});
	// Boot now so the runner's pid can be recorded before anything can kill this process.
	try {
		await vm.start();
	} catch (e) {
		await vm.close().catch(() => {});
		throw e;
	}
	const untrack = track(vm);
	let timer: NodeJS.Timeout | undefined;
	if (p.refresh && Object.keys(p.secrets).length) {
		timer = setInterval(() => {
			try {
				for (const [name, value] of Object.entries(p.refresh!())) secretManager.updateSecret(name, { value });
			} catch {} // keep the old value; the next tick retries
		}, 30 * 60_000);
		timer.unref();
	}
	const close = vm.close.bind(vm);
	vm.close = async () => {
		clearInterval(timer);
		try {
			return await close();
		} finally {
			untrack(); // kills the runner if close left it running
		}
	};
	return vm;
}

interface Entry {
	vm: Promise<any>;
	users: number;
	timer?: NodeJS.Timeout;
}
const vms = new Map<string, Entry>();

/** Shared VM for a project + role; release() closes it 30 s after the last user, release(true) at once (pi is quitting). */
export function acquire(cfg: Config, p: Policy): { vm: Promise<any>; release: (now?: boolean) => Promise<void> | undefined } {
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
	const close = () => {
		vms.delete(key);
		return entry.vm.then((vm) => vm.close()).catch(() => {});
	};
	return {
		vm: entry.vm,
		release: (now = false) => {
			if (released) return;
			released = true;
			if (--entry.users > 0) return;
			if (now) return close();
			entry.timer = setTimeout(close, 30_000);
			entry.timer.unref();
		},
	};
}
