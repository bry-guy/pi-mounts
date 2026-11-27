// pi-mounts: run pi's built-in tools in a Gondolin VM for sandboxed project sessions.
// A session is sandboxed when PI_ROLE is set (role runs) or its project's signed grant says sandbox: true
// (pi-projects decides; see docs/agent-roles.md there). Sandboxed sessions fail closed: if the VM can't start,
// every tool call is refused, and only allowlisted host tools run.
import { join, posix } from "node:path";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ExtensionContext,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { agyAdapter } from "./agy.ts";
import { startExecRelay } from "./exec-relay.ts";
import { type OAuthLogin, placeholders } from "./oauth.ts";
import { acquire, CACHE, type Config, hostGitIdentity, loadConfig, type Policy, roleKey } from "./vm.ts";

const VM_EXEC = fileURLToPath(new URL("../bin/vm-exec.mjs", import.meta.url));

// One exec relay per pi process (its socket travels in process.env, which is process-wide). Sessions of one process
// share the VM of their project and role (subagent children included), so it serves the latest sandboxed session's VM.
const exec: { users: Set<symbol>; vm?: Promise<any>; relay?: Promise<{ path: string; close: () => void }> } = { users: new Set() };
async function execAttach(user: symbol, vm: Promise<any>) {
	exec.users.add(user);
	exec.vm = vm;
	exec.relay ??= startExecRelay(() => exec.vm ?? Promise.reject(new Error("no sandboxed session")), { agy: agyAdapter });
	process.env.PI_MOUNTS_EXEC_SOCKET = (await exec.relay).path;
}
function execDetach(user: symbol) {
	if (!exec.users.delete(user) || exec.users.size) return;
	const relay = exec.relay;
	exec.relay = exec.vm = undefined;
	delete process.env.PI_MOUNTS_EXEC_SOCKET;
	relay?.then((r) => r.close()).catch(() => {});
}

const BUILTINS = ["read", "write", "edit", "bash", "ls", "find", "grep"];
/** Host tools a sandboxed session may still use: they don't hand the agent host access or Bryan's credentials. */
const HOST_TOOLS = ["todo", "ask_user_question", "advisor", "subagent", "get_subagent_result", "steer_subagent", "role_agent", "broker_run", "project_worktree", "project_remember"];

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface Sandbox {
	policy?: Policy;
	vm?: Promise<any>;
	release?: () => void;
	/** Set when the session must be sandboxed but can't be */
	error?: string;
	allowed: Set<string>;
}

/** Runs a shell command in the guest; abort or timeout kills its whole process group. */
async function guestExec(vm: any, command: string, cwd: string, opts: { onData?: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }) {
	const id = Math.random().toString(36).slice(2);
	const pidFile = `/tmp/.pi-run-${id}`;
	const ac = new AbortController();
	let timedOut = false;
	const kill = () => {
		ac.abort();
		vm.exec(["/bin/sh", "-c", `kill -KILL -- -$(cat ${pidFile} 2>/dev/null) 2>/dev/null; rm -f ${pidFile}`]).catch(() => {});
	};
	const onAbort = () => kill();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = opts.timeout && opts.timeout > 0 ? setTimeout(() => ((timedOut = true), kill()), opts.timeout * 1000) : undefined;
	try {
		const proc = vm.exec(["/usr/bin/setsid", "-w", "/bin/bash", "-c", `echo $$ > ${pidFile}; eval "$PI_CMD"; s=$?; rm -f ${pidFile}; exit $s`], {
			cwd,
			env: { PI_CMD: command },
			signal: ac.signal,
			stdout: "pipe",
			stderr: "pipe",
		});
		for await (const chunk of proc.output()) opts.onData?.(chunk.data);
		const r = await proc;
		return { exitCode: r.exitCode as number | null };
	} catch (err) {
		if (opts.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${opts.timeout}`);
		throw err;
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

export default function (pi: ExtensionAPI) {
	const cfg: Config = loadConfig();
	let sb: Sandbox = { allowed: new Set() };
	const self = Symbol("pi-mounts session");

	pi.registerCommand("vm-exec", {
		description: "Print the command that runs a program interactively in this session's VM (e.g. /vm-exec agy, to sign agy in)",
		handler: async (args: string, ctx: ExtensionContext) => {
			if (!exec.users.has(self) || !process.env.PI_MOUNTS_EXEC_SOCKET) {
				ctx.ui.notify("vm-exec needs a sandboxed session (start pi with PI_ROLE=<repo>/<role>).", "warning");
				return;
			}
			ctx.ui.notify(`In another terminal, run:\n  PI_MOUNTS_EXEC_SOCKET=${process.env.PI_MOUNTS_EXEC_SOCKET} ${VM_EXEC} ${args.trim() || "<command> [args]"}`, "info");
		},
	});

	const vm = async () => {
		if (sb.error) throw new Error(`Sandbox unavailable: ${sb.error}`);
		return sb.vm!;
	};

	const ops = {
		read: {
			readFile: async (p: string) => (await vm()).fs.readFile(p),
			access: async (p: string) => (await vm()).fs.access(p, { mode: fsConstants.R_OK }),
		},
		write: {
			writeFile: async (p: string, content: string) => {
				const v = await vm();
				await v.fs.mkdir(posix.dirname(p), { recursive: true });
				await v.fs.writeFile(p, content);
			},
			mkdir: async (d: string) => (await vm()).fs.mkdir(d, { recursive: true }),
		},
		ls: {
			exists: async (p: string) => (await vm()).fs.access(p).then(() => true, () => false),
			stat: async (p: string) => (await vm()).fs.stat(p),
			readdir: async (p: string) => (await vm()).fs.listDir(p),
		},
		find: {
			exists: async (p: string) => (await vm()).fs.access(p).then(() => true, () => false),
			glob: async (pattern: string, searchCwd: string, o: { ignore: string[]; limit: number }) => {
				const ex = o.ignore.map((g) => `--exclude ${q(g)}`).join(" ");
				let out = "";
				await guestExec(await vm(), `fd --glob --hidden --absolute-path --type f ${ex} ${q(pattern)} . | head -n ${o.limit}`, searchCwd, {
					onData: (b) => (out += b.toString()),
				});
				return out.split("\n").filter(Boolean);
			},
		},
		bash: {
			exec: async (command: string, execCwd: string, o: { onData: (b: Buffer) => void; signal?: AbortSignal; timeout?: number }) =>
				guestExec(await vm(), command, execCwd, o),
		},
	};

	const local = {
		read: createReadToolDefinition(process.cwd()),
		write: createWriteToolDefinition(process.cwd()),
		edit: createEditToolDefinition(process.cwd()),
		bash: createBashToolDefinition(process.cwd()),
		ls: createLsToolDefinition(process.cwd()),
		find: createFindToolDefinition(process.cwd()),
		grep: createGrepToolDefinition(process.cwd()),
	};
	// Built per call: definitions resolve relative paths against the cwd they were made with.
	const sandboxed: Record<string, (c: string) => any> = {
		read: (c) => createReadToolDefinition(c, { operations: ops.read }),
		write: (c) => createWriteToolDefinition(c, { operations: ops.write }),
		edit: (c) => createEditToolDefinition(c, { operations: { ...ops.read, writeFile: ops.write.writeFile } }),
		bash: (c) => createBashToolDefinition(c, { operations: ops.bash }),
		ls: (c) => createLsToolDefinition(c, { operations: ops.ls }),
		find: (c) => createFindToolDefinition(c, { operations: ops.find }),
	};
	const hostTools: Record<string, (c: string) => any> = {
		read: (c) => createReadToolDefinition(c),
		write: (c) => createWriteToolDefinition(c),
		edit: (c) => createEditToolDefinition(c),
		bash: (c) => createBashToolDefinition(c),
		ls: (c) => createLsToolDefinition(c),
		find: (c) => createFindToolDefinition(c),
		grep: (c) => createGrepToolDefinition(c),
	};

	// grep: pi's tool spawns host rg on host paths, so the sandbox runs rg in the guest instead.
	const sandboxGrep = async (params: any, cwd: string, signal?: AbortSignal) => {
		const target = params.path ? posix.resolve(cwd, params.path) : cwd;
		const limit = params.limit ?? 100;
		const flags = [
			"--line-number",
			"--no-heading",
			"--color=never",
			"--hidden",
			"--glob '!.git'",
			params.ignoreCase ? "-i" : "",
			params.literal ? "-F" : "",
			params.context ? `-C ${Number(params.context)}` : "",
			params.glob ? `--glob ${q(params.glob)}` : "",
			`--max-count ${limit}`,
		].join(" ");
		let out = "";
		await guestExec(await vm(), `rg ${flags} -e ${q(params.pattern)} ${q(target)} | head -n ${limit * (1 + 2 * (params.context ?? 0))}`, cwd, {
			onData: (b) => (out += b.toString()),
			signal,
		});
		const t = truncateHead(out || "No matches found");
		return { content: [{ type: "text" as const, text: t.content }], details: { truncation: t.truncated ? t : undefined } };
	};

	for (const name of BUILTINS) {
		const base = (local as any)[name];
		pi.registerTool({
			...base,
			async execute(id: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: ExtensionContext) {
				if (!sb.policy && !sb.error) return hostTools[name](ctx.cwd).execute(id, params, signal, onUpdate, ctx);
				if (name === "grep") return sandboxGrep(params, ctx.cwd, signal);
				return sandboxed[name](ctx.cwd).execute(id, params, signal, onUpdate, ctx);
			},
		});
	}

	pi.on("tool_call", (event) => {
		if (!sb.policy && !sb.error) return;
		if (sb.error) return { block: true, reason: `Sandbox unavailable (${sb.error}); tools are disabled in this session.` };
		if (BUILTINS.includes(event.toolName) || sb.allowed.has(event.toolName)) return;
		return { block: true, reason: `${event.toolName} runs on the host, which this sandboxed session can't use.` };
	});

	pi.on("session_start", async (_e, ctx) => {
		const api = (globalThis as any)[Symbol.for("pi-projects.v1")];
		const project = api?.projectForCwd(ctx.cwd);
		const role = project ? api.sessionRole(project, process.env, { fetch: false }) : undefined;
		const required = !!process.env.PI_ROLE || !!role?.sandbox;
		if (!required) return;
		// bin/vm-exec refuses to run commands on the host in a sandboxed process.
		process.env.PI_MOUNTS_SANDBOXED = "1";
		const status = (s: string) => ctx.ui.setStatus("pi-mounts", s);
		if (!project) {
			sb = { error: "role runs need a pi project", allowed: new Set() };
			status("sandbox: unavailable");
			return;
		}
		let secrets: Policy["secrets"] = {};
		let refresh: Policy["refresh"];
		type Secret = { hosts: string[]; kind?: string; tokenUrl?: string; placeholderPrefix?: { access?: string; refresh?: string } };
		const declared = Object.entries(role?.role?.secrets ?? {}) as [string, Secret][];
		const wanted = declared.filter(([, s]) => s.kind !== "oauth2");
		const oauth: OAuthLogin[] = [];
		for (const [name, s] of declared.filter(([, s]) => s.kind === "oauth2")) {
			const broker = (globalThis as any)[Symbol.for("pi-secret-broker.v1")];
			if (!s.tokenUrl) {
				ctx.ui.notify(`pi-mounts: oauth2 secret ${name} has no tokenUrl; skipping it`, "warning");
				continue;
			}
			if (!broker?.storeSecret) {
				ctx.ui.notify(`pi-mounts: oauth2 secret ${name} needs pi-secret-broker with storeSecret; skipping it`, "warning");
				continue;
			}
			const sources = api.trustedGrants().grants.sources[role.roleId];
			let real: string | undefined;
			try {
				real = broker.resolveSecrets(sources, [name])[name];
			} catch {} // not signed in yet
			const ph = placeholders(join(CACHE, "oauth", roleKey(role.roleId), `${name}.json`), s.placeholderPrefix);
			oauth.push({ name, tokenUrl: s.tokenUrl, hosts: s.hosts ?? [], ...ph, real, store: (v) => broker.storeSecret(sources, name, v) });
		}
		if (wanted.length) {
			try {
				const broker = (globalThis as any)[Symbol.for("pi-secret-broker.v1")];
				if (!broker) throw new Error("pi-secret-broker is not installed");
				const sources = api.trustedGrants().grants.sources[role.roleId];
				refresh = () => broker.resolveSecrets(sources, wanted.map(([n]) => n));
				const values = refresh();
				secrets = Object.fromEntries(wanted.map(([n, s]) => [n, { hosts: s.hosts, value: values[n] }]));
			} catch (e) {
				ctx.ui.notify(`pi-mounts: role secrets unavailable (${(e as Error).message}); continuing without them`, "warning");
			}
		}
		const policy: Policy = {
			projectPath: project.path,
			aliases: ctx.cwd.startsWith(project.path) ? [] : [ctx.cwd.split("/").slice(0, project.path.split("/").length).join("/")],
			roleId: role?.roleId,
			refresh,
			git: role?.role?.git,
			author: role?.role?.git ? hostGitIdentity() : undefined,
			egress: role?.role?.egress ?? [],
			secrets,
			oauth,
			egressPaths: role?.role?.egressPaths,
			hostPorts: role?.role?.hostPorts,
		};
		const { vm: v, release } = acquire(cfg, policy);
		await execAttach(self, v);
		sb = { policy, vm: v, release, allowed: new Set([...HOST_TOOLS, ...(role?.role?.tools ?? [])]) };
		status(`sandbox: ${role?.roleId ?? "no role"}`);
		if (!role?.roleId) {
			ctx.ui.notify(
				`Sandboxed with no role${role?.problem ? ` (${role.problem})` : ""}: no secrets, default hosts only. ` +
					"Set one with /project grant <repo>/<role> --default, or leave the sandbox with /project sandbox off.",
				"warning",
			);
		}
		v.catch((e: Error) => {
			sb.error = e.message.split("\n")[0];
			status("sandbox: unavailable");
			ctx.ui.notify(`pi-mounts: sandbox VM failed to start (${sb.error}). Tools are disabled.`, "error");
		});
	});

	pi.on("session_shutdown", () => {
		execDetach(self);
		sb.release?.();
		sb = { allowed: new Set() };
	});
}
