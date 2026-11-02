// One Gondolin VM per project + role, shared by every session of this pi process (subagent children included).
// Host paths are mounted at the same absolute paths, so pi's tools keep their paths.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Config {
	/** Gondolin host module (dist/src/index.js); a locally patched build until upstream has the fix */
	gondolin?: string;
	/** Image assets dir built from image/pi-worker.json */
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
	const shadow = (prov: unknown) => new G.ShadowProvider(prov, { shouldShadow: ({ path }: { path: string }) => isHidden(path), writeMode: "deny" });
	const ro = (dir: string) => shadow(new G.ReadonlyProvider(new G.RealFSProvider(dir)));
	const rw = (dir: string) => shadow(new G.RealFSProvider(dir));
	const real = realpathSync(p.projectPath);
	const out: Record<string, unknown> = {};
	for (const base of new Set([real, ...(p.aliases ?? [])])) {
		out[base] = ro(real);
		const repos = join(real, "repos");
		if (existsSync(repos)) {
			for (const r of readdirSync(repos)) {
				out[join(base, "repos", r)] = ro(join(repos, r));
				if (existsSync(join(repos, r, ".git"))) out[join(base, "repos", r, ".git")] = new G.RealFSProvider(join(repos, r, ".git"));
			}
		}
		for (const d of ["worktrees", "artifacts"]) {
			mkdirSync(join(real, d), { recursive: true });
			out[join(base, d)] = rw(join(real, d));
		}
	}
	const home = join(CACHE, "home", roleKey(p.roleId));
	mkdirSync(home, { recursive: true });
	out["/root"] = new G.RealFSProvider(home); // mise tools, npm cache; only placeholders ever reach it
	mkdirSync(join(CACHE, "bin"), { recursive: true });
	out["/opt/pi/bin"] = new G.ReadonlyProvider(new G.RealFSProvider(join(CACHE, "bin")));
	return out;
}

export function guestEnv(p: Policy, placeholders: Record<string, string>): Record<string, string> {
	const git: [string, string][] = [["safe.directory", "*"]];
	if (placeholders.GH_TOKEN) {
		git.push(["credential.https://github.com.helper", '!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f']);
	}
	const env: Record<string, string> = {
		...placeholders,
		HOME: "/root",
		PATH: "/opt/pi/bin:/root/.local/share/mise/shims:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
		MISE_NODE_FLAVOR: "musl",
		MISE_NODE_COMPILE: "false",
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

export async function createVm(cfg: Config, p: Policy): Promise<any> {
	const G = await loadGondolin(cfg);
	const image = cfg.image || join(CACHE, "pi-worker");
	if (!existsSync(join(image, "manifest.json"))) throw new Error(`No sandbox image at ${image}. Run scripts/setup.sh in pi-mounts.`);
	const { httpHooks, env } = G.createHttpHooks({
		allowedHosts: [...new Set([...DEFAULT_EGRESS, ...p.egress])],
		secrets: p.secrets,
	});
	return G.VM.create({
		sandbox: { imagePath: image },
		memory: cfg.memory ?? "4G",
		cpus: cfg.cpus ?? 4,
		vfs: { mounts: mounts(G, p) },
		httpHooks,
		env: guestEnv(p, env),
	});
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
