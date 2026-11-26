// agy (the Antigravity CLI, driven by @estebanforge/pi-antigravity-bridge) inside the role's VM, with the Google
// login kept on the host. Used only when the role declares a secret of kind "google-oauth".
//
// - The bridge starts `agy` through AGY_BIN = bin/agy-vm. The wrapper talks to pi-mounts over a host-only Unix socket
//   (PI_MOUNTS_AGY_SOCKET), and pi-mounts runs agy in the VM with stdio piped through, unchanged.
// - agy reaches the bridge's MCP server (http://127.0.0.1:<port>/mcp on the host) through a guest forwarder on the same
//   port, Gondolin's raw TCP mapping (pi-bridge.internal:7777) and a host relay to the bridge's port.
// - The VM only ever sees two placeholders. pi-mounts answers agy's own calls to Google's token endpoint: it swaps the
//   real refresh token (from pi-secret-broker) into agy's request, sends it from the host, keeps the real access token
//   in Gondolin's secret manager and returns placeholders. Gondolin swaps the access placeholder into the
//   Authorization header for the role's listed hosts only.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { frame, frameReader } from "./frames.mjs";

export const TOKEN_URL = "https://oauth2.googleapis.com/token";
export const BRIDGE_HOST = "pi-bridge.internal";
export const BRIDGE_GUEST_PORT = 7777;
export const AGY_GUEST_BIN = "/usr/local/bin/agy";

export interface GoogleLogin {
	/** Secret name in the role file */
	name: string;
	/** Hosts the access token is sent to */
	hosts: string[];
	/** Placeholders the guest holds */
	access: string;
	refresh: string;
	/** The real refresh token (host only); unset until the role has logged in */
	real?: string;
	/** Persists a new real refresh token (pi-secret-broker storeSecret) */
	store: (refreshToken: string) => void;
}

/** The role's two placeholders, stable across VM restarts because agy keeps them in its home in the VM. */
export function placeholders(file: string): { access: string; refresh: string } {
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
	const p = { access: `ya29.pimounts-${randomBytes(24).toString("hex")}`, refresh: `1//pimounts-${randomBytes(24).toString("hex")}` };
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
	return p;
}

const json = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Gondolin onRequest hook: answers POST https://oauth2.googleapis.com/token, ignores every other request. */
export function googleTokenFacade(login: GoogleLogin, setAccess: (token: string) => void, doFetch: typeof fetch = fetch) {
	return async (req: Request): Promise<Response | undefined> => {
		if (req.method !== "POST") return;
		const u = new URL(req.url);
		if (`${u.origin}${u.pathname}` !== TOKEN_URL) return;
		const isJson = (req.headers.get("content-type") ?? "").includes("json");
		const text = await req.text();
		let fields: Record<string, unknown>;
		try {
			fields = isJson ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
		} catch {
			return json(400, { error: "invalid_request", error_description: "pi-mounts: unreadable token request" });
		}
		if (fields.refresh_token === login.refresh) {
			if (!login.real) return json(400, { error: "invalid_grant", error_description: "pi-mounts: this role has no Google login yet; run /agy-login" });
			fields.refresh_token = login.real;
		}
		const headers = new Headers(req.headers);
		for (const h of ["host", "content-length", "accept-encoding", "connection"]) headers.delete(h);
		const body = isJson ? JSON.stringify(fields) : new URLSearchParams(fields as Record<string, string>).toString();
		const res = await doFetch(TOKEN_URL, { method: "POST", headers, body });
		const out = await res.text();
		if (!res.ok) return new Response(out, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
		let tokens: Record<string, unknown>;
		try {
			tokens = JSON.parse(out);
		} catch {
			// Never pass an unparsed body through: it may hold real tokens.
			return json(502, { error: "server_error", error_description: "pi-mounts: unexpected token response" });
		}
		if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== login.refresh) {
			try {
				login.store(tokens.refresh_token);
			} catch (e) {
				return json(502, { error: "server_error", error_description: `pi-mounts: could not store the Google login (${(e as Error).message})` });
			}
			login.real = tokens.refresh_token;
			tokens.refresh_token = login.refresh;
		}
		if (typeof tokens.access_token === "string") {
			setAccess(tokens.access_token);
			tokens.access_token = login.access;
		}
		return json(200, tokens);
	};
}

/** Gondolin isRequestAllowed: www.googleapis.com only for its OAuth paths (it also serves APIs the
 *  cloud-platform scope would open, like storage). */
export function googlePathAllowed(req: Request): boolean {
	const u = new URL(req.url);
	return u.hostname !== "www.googleapis.com" || u.pathname.startsWith("/oauth2/");
}

/** agy's argv for the guest: the bridge's --gemini-dir is a host folder linked to the host's own agy login, so agy
 *  uses the role's home in the VM instead. */
export function guestArgs(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--gemini-dir" || argv[i] === "--gemini_dir") i++;
		else if (!/^--gemini[-_]dir=/.test(argv[i])) out.push(argv[i]);
	}
	return out;
}

/** The bridge's MCP port from an ACP session/new or session/load frame, if it names a loopback server. */
export function bridgePort(line: string): number | undefined {
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg?.method !== "session/new" && msg?.method !== "session/load") return;
	for (const s of msg.params?.mcpServers ?? []) {
		const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//.exec(String(s?.url ?? ""));
		if (m) return Number(m[1]);
	}
}

let relay: Promise<{ port: number; setTarget: (port: number) => void }> | undefined;

/** Host end of pi-bridge.internal:7777. One per pi process, like the bridge's MCP listener. Forwards only to the port
 *  the bridge itself handed agy. */
export function bridgeRelay(): Promise<{ port: number; setTarget: (port: number) => void }> {
	relay ??= new Promise((resolve, reject) => {
		let target = 0;
		const server = net.createServer((c) => {
			if (!target) return c.destroy();
			const u = net.connect(target, "127.0.0.1");
			c.on("error", () => u.destroy());
			u.on("error", () => c.destroy());
			c.pipe(u).pipe(c);
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.unref();
			resolve({ port: (server.address() as net.AddressInfo).port, setTarget: (p) => (target = p) });
		});
	});
	return relay;
}

// Guest end: listens on 127.0.0.1:<bridge port> in the VM so the bridge's URL works unchanged.
const FORWARDER = `
import socket, sys, threading
port, host, gport = int(sys.argv[1]), sys.argv[2], int(sys.argv[3])
s = socket.socket()
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind(("127.0.0.1", port))
except OSError:
    print("ready (port in use)", flush=True)
    sys.exit(0)
s.listen(64)
print("ready", flush=True)
def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d:
                break
            b.sendall(d)
    except OSError:
        pass
    try:
        b.shutdown(socket.SHUT_WR)
    except OSError:
        pass
def handle(c):
    try:
        u = socket.create_connection((host, gport))
    except OSError:
        c.close()
        return
    t = threading.Thread(target=pump, args=(u, c), daemon=True)
    t.start()
    pump(c, u)
    t.join()
    c.close()
    u.close()
while True:
    c, _ = s.accept()
    threading.Thread(target=handle, args=(c,), daemon=True).start()
`;

const forwarders = new WeakMap<object, Map<number, Promise<void>>>();

export function ensureForwarder(vm: any, port: number): Promise<void> {
	let m = forwarders.get(vm);
	if (!m) forwarders.set(vm, (m = new Map()));
	let p = m.get(port);
	if (!p) {
		const map = m;
		p = (async () => {
			const proc = vm.exec(["/usr/bin/python3", "-c", FORWARDER, String(port), BRIDGE_HOST, String(BRIDGE_GUEST_PORT)], { stdout: "pipe", stderr: "pipe" });
			const it = proc.output()[Symbol.asyncIterator]();
			for (;;) {
				const r = await it.next();
				if (r.done) throw new Error("the guest forwarder exited before it was ready");
				if (r.value.stream === "stdout" && String(r.value.data).includes("ready")) break;
			}
			(async () => {
				while (!(await it.next()).done);
			})()
				.catch(() => {})
				.finally(() => map.delete(port));
			Promise.resolve(proc).catch(() => {});
		})();
		m.set(port, p);
		p.catch(() => map.delete(port));
	}
	return p;
}

/** Serves bin/agy-vm: each connection runs one agy in the VM. Closing the connection kills it. */
export async function startAgyRelay(getVm: () => Promise<any>): Promise<{ path: string; close: () => void }> {
	const dir = mkdtempSync(join(tmpdir(), "pi-mounts-agy-"));
	const path = join(dir, "s");
	const server = net.createServer((sock) => serve(sock, getVm));
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

function serve(sock: net.Socket, getVm: () => Promise<any>) {
	let vm: any;
	let proc: any;
	let pty = false;
	let exited = false;
	let pending = Buffer.alloc(0);
	let chain: Promise<unknown> = Promise.resolve();
	const pidFile = `/tmp/.pi-agy-${randomBytes(6).toString("hex")}`;
	const send = (type: string, payload: Buffer | string | object) => {
		if (!sock.destroyed) sock.write(frame(type, payload));
	};
	const fail = (msg: string) => {
		send("Z", `agy-vm: ${msg}\n`);
		send("X", { code: 1 });
		sock.end();
	};
	const kill = () => {
		if (!proc || exited) return;
		exited = true;
		// pty: agy's own pid; otherwise its process group (setsid). `kill -s KILL -<pgid>` works in bash and dash.
		const target = `${pty ? "" : "-"}$(cat ${pidFile} 2>/dev/null)`;
		vm.exec(["/bin/sh", "-c", `kill -s KILL ${target} 2>/dev/null; rm -f ${pidFile}`]).catch(() => {});
	};

	const start = async (hello: { argv?: string[]; cwd?: string; pty?: boolean; rows?: number; cols?: number }) => {
		vm = await getVm();
		pty = !!hello.pty;
		const launch = ["/bin/sh", "-c", `echo $$ > ${pidFile}; exec "$0" "$@"`, AGY_GUEST_BIN, ...guestArgs(hello.argv ?? [])];
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

	// ACP is newline-delimited JSON. Lines naming the bridge's MCP server wait until the guest forwarder for that port
	// is up, so agy's first connection finds it.
	const writeLine = async (line: Buffer) => {
		if (line.includes("mcpServers")) {
			const port = bridgePort(line.toString("utf8"));
			if (port) {
				(await bridgeRelay()).setTarget(port);
				await ensureForwarder(vm, port);
			}
		}
		proc.write(line);
	};
	const stdin = async (data: Buffer) => {
		if (!proc) return;
		if (pty) return proc.write(data);
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
