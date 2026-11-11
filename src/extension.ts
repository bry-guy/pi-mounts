// pi-mounts: run pi's built-in tools in a Gondolin VM for sandboxed project sessions.
// A session is sandboxed when PI_ROLE is set (role runs) or its project's signed grant says sandbox: true
// (pi-projects decides; see docs/agent-roles.md there). Sandboxed sessions fail closed: if the VM can't start,
// every tool call is refused, and only allowlisted host tools run.
import { posix } from "node:path";
import { constants as fsConstants } from "node:fs";
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
import { acquire, type Config, hostGitIdentity, loadConfig, type Policy } from "./vm.ts";

const BUILTINS = ["read", "write", "edit", "bash", "ls", "find", "grep"];
/** Host tools a sandboxed session may still use: they don't hand the agent host access or Bryan's credentials. */
const HOST_TOOLS = ["todo", "ask_user_question", "advisor", "subagent", "get_subagent_result", "steer_subagent", "role_agent", "broker_run", "project_worktree", "project_remember"];

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

interface Sandbox {
	policy?: Policy;
	vm?: Promise<any>;
	release?: (now?: boolean) => Promise<void> | undefined;
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
		const status = (s: string) => ctx.ui.setStatus("pi-mounts", s);
		if (!project) {
			sb = { error: "role runs need a pi project", allowed: new Set() };
			status("sandbox: unavailable");
			return;
		}
		let secrets: Policy["secrets"] = {};
		let refresh: Policy["refresh"];
		const wanted = Object.entries(role?.role?.secrets ?? {}) as [string, { hosts: string[] }][];
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
		};
		const { vm: v, release } = acquire(cfg, policy);
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

	pi.on("session_shutdown", async (e) => {
		const release = sb.release;
		sb = { allowed: new Set() };
		// On quit pi exits right after this, so the 30 s delayed close would never run.
		await release?.(e.reason === "quit");
	});
}
