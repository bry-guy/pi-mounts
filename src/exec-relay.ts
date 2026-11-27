// Runs commands in the session's VM for host processes: bin/vm-exec connects to this host-only Unix socket
// (PI_MOUNTS_EXEC_SOCKET), and pi-mounts runs the command in the VM with stdio, exit code and (from a terminal) a pty
// passed through. Closing the connection kills the command. Lets a host extension that starts a CLI itself (the
// antigravity bridge's agy, a language server, ...) run it inside the sandbox.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { frame, frameReader } from "./frames.mjs";

/** Per-command tweaks, keyed by the command's base name. */
export interface Adapter {
	/** Rewrites the host argv for the guest */
	args?: (argv: string[]) => string[];
	/** Sees each stdin line (non-pty only) before the command gets it; the line waits for the returned promise. */
	onLine?: (line: string, vm: any) => Promise<void> | void;
}

export async function startExecRelay(getVm: () => Promise<any>, adapters: Record<string, Adapter> = {}): Promise<{ path: string; close: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-mounts-exec-"));
	const path = join(dir, "s");
	const server = net.createServer((sock) => serve(sock, getVm, adapters));
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(path, () => resolve());
	});
	server.unref();
	return {
		path,
		close: () => {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

interface Hello {
	cmd: string;
	argv?: string[];
	cwd?: string;
	pty?: boolean;
	rows?: number;
	cols?: number;
}

function serve(sock: net.Socket, getVm: () => Promise<any>, adapters: Record<string, Adapter>) {
	let vm: any;
	let proc: any;
	let pty = false;
	let exited = false;
	let adapter: Adapter = {};
	let pending = Buffer.alloc(0);
	let chain: Promise<unknown> = Promise.resolve();
	const pidFile = `/tmp/.pi-exec-${randomBytes(6).toString("hex")}`;
	const send = (type: string, payload: Buffer | string | object) => {
		if (!sock.destroyed) sock.write(frame(type, payload));
	};
	const fail = (msg: string) => {
		send("Z", `vm-exec: ${msg}\n`);
		send("X", { code: 1 });
		sock.end();
	};
	const kill = () => {
		if (!proc || exited) return;
		exited = true;
		// pty: the command's own pid; otherwise its process group (setsid). `kill -KILL -<pgid>` works in bash and dash.
		const target = `${pty ? "" : "-"}$(cat ${pidFile} 2>/dev/null)`;
		vm.exec(["/bin/sh", "-c", `kill -KILL ${target} 2>/dev/null; rm -f ${pidFile}`]).catch(() => {});
	};

	const start = async (hello: Hello) => {
		if (!hello.cmd) throw new Error("no command");
		vm = await getVm();
		pty = !!hello.pty;
		adapter = adapters[basename(hello.cmd)] ?? {};
		const argv = adapter.args ? adapter.args(hello.argv ?? []) : (hello.argv ?? []);
		// sh's exec looks the command up on the guest PATH.
		const launch = ["/bin/sh", "-c", `echo $$ > ${pidFile}; exec "$0" "$@"`, hello.cmd, ...argv];
		proc = vm.exec(pty ? launch : ["/usr/bin/setsid", "-w", ...launch], { cwd: hello.cwd, stdin: true, stdout: "pipe", stderr: "pipe", ...(pty ? { pty: true } : {}) });
		if (pty && hello.rows && hello.cols) proc.resize(hello.rows, hello.cols);
		(async () => {
			for await (const c of proc.output()) send(c.stream === "stderr" ? "Z" : "O", c.data);
			const r = await proc;
			if (exited) return;
			exited = true;
			vm.exec(["/bin/rm", "-f", pidFile]).catch(() => {});
			send("X", { code: r.exitCode ?? 1 });
			sock.end();
		})().catch((e) => {
			if (!exited) fail((e as Error).message);
			exited = true;
		});
	};

	const writeLine = async (line: Buffer) => {
		await adapter.onLine!(line.toString("utf8"), vm);
		proc.write(line);
	};
	const stdin = async (data: Buffer) => {
		if (!proc) return;
		if (pty || !adapter.onLine) return proc.write(data);
		pending = pending.length ? Buffer.concat([pending, data]) : data;
		let nl: number;
		while ((nl = pending.indexOf(10)) >= 0) {
			const line = pending.subarray(0, nl + 1);
			pending = pending.subarray(nl + 1);
			await writeLine(line);
		}
	};
	const end = async () => {
		if (!proc) return;
		if (pending.length) await writeLine(pending);
		pending = Buffer.alloc(0);
		proc.end();
	};

	const queue = (fn: () => Promise<unknown> | unknown) => {
		chain = chain.then(fn).catch((e) => {
			fail((e as Error).message);
			kill();
		});
	};
	sock.on(
		"data",
		frameReader((type: string, payload: Buffer) => {
			if (type === "H") queue(() => start(JSON.parse(payload.toString("utf8"))));
			else if (type === "I") queue(() => stdin(Buffer.from(payload)));
			else if (type === "E") queue(end);
			else if (type === "R" && proc && pty) {
				const r = JSON.parse(payload.toString("utf8"));
				proc.resize(r.rows, r.cols);
			}
		}),
	);
	sock.on("close", kill);
	sock.on("error", () => {});
}
