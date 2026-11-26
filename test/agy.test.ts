import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const a = await import("../src/agy.ts");
const WRAPPER = fileURLToPath(new URL("../bin/agy-vm.mjs", import.meta.url));

test("guestArgs drops the bridge's host --gemini-dir in every spelling", () => {
	assert.deepEqual(a.guestArgs(["--gemini-dir", "/h/x", "acp"]), ["acp"]);
	assert.deepEqual(a.guestArgs(["--gemini_dir", "/h/x", "--version"]), ["--version"]);
	assert.deepEqual(a.guestArgs(["--gemini-dir=/h/x", "models", "--json"]), ["models", "--json"]);
});

test("bridgePort reads loopback MCP servers from session/new and session/load only", () => {
	const msg = (method: string, url: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { cwd: "/p", mcpServers: [{ name: "pi", type: "http", url, headers: [] }] } });
	assert.equal(a.bridgePort(msg("session/new", "http://127.0.0.1:4321/mcp")), 4321);
	assert.equal(a.bridgePort(msg("session/load", "http://localhost:99/mcp")), 99);
	assert.equal(a.bridgePort(msg("session/prompt", "http://127.0.0.1:4321/mcp")), undefined);
	assert.equal(a.bridgePort(msg("session/new", "http://10.0.0.1:4321/mcp")), undefined);
	assert.equal(a.bridgePort("not json"), undefined);
});

test("placeholders are created once and kept", () => {
	const f = join(mkdtempSync(join(tmpdir(), "ph-")), "agy", "r.json");
	const p = a.placeholders(f);
	assert.match(p.access, /^ya29\.pimounts-/);
	assert.match(p.refresh, /^1\/\/pimounts-/);
	assert.deepEqual(a.placeholders(f), p);
});

test("googlePathAllowed keeps www.googleapis.com to /oauth2/", () => {
	const r = (u: string) => new Request(u);
	assert.ok(a.googlePathAllowed(r("https://www.googleapis.com/oauth2/v2/userinfo")));
	assert.ok(!a.googlePathAllowed(r("https://www.googleapis.com/storage/v1/b")));
	assert.ok(a.googlePathAllowed(r("https://cloudcode-pa.googleapis.com/v1internal:generateContent")));
});

function login(over = {}) {
	const stored: string[] = [];
	const g = { name: "AGY", hosts: ["cloudcode-pa.googleapis.com"], access: "ya29.PH", refresh: "1//PH", real: "1//REAL", store: (v: string) => stored.push(v), ...over };
	return { g, stored };
}
const tokenReq = (body: string, type = "application/x-www-form-urlencoded") =>
	new Request(a.TOKEN_URL, { method: "POST", headers: { "content-type": type, host: "oauth2.googleapis.com" }, body });

test("facade: other requests pass through untouched", async () => {
	const { g } = login();
	const f = a.googleTokenFacade(g, () => {}, async () => assert.fail("no fetch"));
	assert.equal(await f(new Request("https://cloudcode-pa.googleapis.com/v1internal:generateContent", { method: "POST", body: "{}" })), undefined);
	assert.equal(await f(new Request(a.TOKEN_URL)), undefined);
});

test("facade: refresh swaps the real token in, hands back placeholders, keeps the real access token on the host", async () => {
	const { g, stored } = login();
	let access = "";
	let sent: URLSearchParams | undefined;
	const f = a.googleTokenFacade(
		g,
		(t) => (access = t),
		(async (_u: string, init: RequestInit) => {
			sent = new URLSearchParams(String(init.body));
			assert.equal(new Headers(init.headers).get("host"), null);
			return new Response(JSON.stringify({ access_token: "ya29.REAL", expires_in: 3599, token_type: "Bearer", id_token: "eyJ.x.y" }), { status: 200 });
		}) as typeof fetch,
	);
	const res = (await f(tokenReq("grant_type=refresh_token&refresh_token=1%2F%2FPH&client_id=cid&client_secret=cs")))!;
	assert.equal(sent!.get("refresh_token"), "1//REAL");
	assert.equal(sent!.get("client_id"), "cid");
	const body = await res.json();
	assert.equal(body.access_token, "ya29.PH");
	assert.equal(body.expires_in, 3599);
	assert.equal(access, "ya29.REAL");
	assert.deepEqual(stored, []);
});

test("facade: the login exchange stores the refresh token through the broker and returns placeholders", async () => {
	const { g, stored } = login({ real: undefined });
	const f = a.googleTokenFacade(g, () => {}, (async () => new Response(JSON.stringify({ access_token: "ya29.REAL", refresh_token: "1//NEW" }))) as typeof fetch);
	const res = (await f(tokenReq(JSON.stringify({ grant_type: "authorization_code", code: "c", code_verifier: "v" }), "application/json")))!;
	const text = await res.text();
	assert.ok(!text.includes("REAL") && !text.includes("NEW"), text);
	assert.deepEqual(JSON.parse(text), { access_token: "ya29.PH", refresh_token: "1//PH" });
	assert.deepEqual(stored, ["1//NEW"]);
	assert.equal(g.real, "1//NEW");
});

test("facade: no login, a failed store or an unreadable reply never leaks or forwards a placeholder", async () => {
	const none = login({ real: undefined }).g;
	const r1 = (await a.googleTokenFacade(none, () => {}, async () => assert.fail("no fetch"))(tokenReq("grant_type=refresh_token&refresh_token=1%2F%2FPH")))!;
	assert.equal(r1.status, 400);
	assert.equal((await r1.json()).error, "invalid_grant");

	const failing = login({ store: () => { throw new Error("keychain locked"); } }).g;
	const r2 = (await a.googleTokenFacade(failing, () => {}, (async () => new Response(JSON.stringify({ access_token: "ya29.REAL", refresh_token: "1//NEW" }))) as typeof fetch)(tokenReq("grant_type=authorization_code&code=c")))!;
	assert.equal(r2.status, 502);
	assert.ok(!(await r2.text()).includes("NEW"));

	const r3 = (await a.googleTokenFacade(login().g, () => {}, (async () => new Response("access_token=ya29.REAL")) as typeof fetch)(tokenReq("grant_type=refresh_token&refresh_token=1%2F%2FPH")))!;
	assert.equal(r3.status, 502);
	assert.ok(!(await r3.text()).includes("REAL"));

	const r4 = (await a.googleTokenFacade(login().g, () => {}, (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch)(tokenReq("grant_type=refresh_token&refresh_token=1%2F%2FPH")))!;
	assert.equal(r4.status, 400);
});

// A stand-in for a Gondolin VM: exec runs the command on this machine, with the same interface pi-mounts uses.
// `rewrite` maps guest argv to host argv (agy -> a fake script; the forwarder's ports -> free local ports).
function fakeVm(rewrite: (argv: string[]) => string[]) {
	const children: ReturnType<typeof spawn>[] = [];
	return {
		killAll: () => children.forEach((c) => c.kill("SIGKILL")),
		exec(argv: string[], opts: any = {}) {
			const child = spawn(rewrite(argv)[0], rewrite(argv).slice(1), { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
			children.push(child);
			const chunks: { stream: string; data: Buffer }[] = [];
			let wake = () => {};
			let open = 2;
			for (const s of ["stdout", "stderr"] as const) {
				child[s].on("data", (data: Buffer) => (chunks.push({ stream: s, data }), wake()));
				child[s].on("end", () => (open--, wake()));
			}
			const done = new Promise<any>((resolve) => child.on("close", (code) => resolve({ exitCode: code ?? 137 })));
			return {
				write: (d: Buffer | string) => child.stdin.write(d),
				end: () => child.stdin.end(),
				resize: () => {},
				then: (f: any, r: any) => done.then(f, r),
				catch: (r: any) => done.catch(r),
				output: () => ({
					async *[Symbol.asyncIterator]() {
						for (;;) {
							while (chunks.length) yield chunks.shift();
							if (!open) return;
							await new Promise<void>((res) => (wake = res));
						}
					},
				}),
			};
		},
	};
}

const freePort = () =>
	new Promise<number>((res) => {
		const s = net.createServer().listen(0, "127.0.0.1", () => {
			const p = (s.address() as net.AddressInfo).port;
			s.close(() => res(p));
		});
	});

function runWrapper(socket: string, args: string[], input: string) {
	const child = spawn(process.execPath, [WRAPPER, ...args], { env: { ...process.env, PI_MOUNTS_AGY_SOCKET: socket }, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	child.stdin.end(input);
	return { child, done: new Promise<{ code: number | null; out: string; err: string }>((res) => child.on("close", (code) => res({ code, out, err }))) };
}

test("relay: agy runs through the wrapper with the host --gemini-dir dropped, stdio and exit code passed through", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agyrelay-"));
	const fake = join(dir, "agy");
	writeFileSync(fake, `#!/bin/sh\necho "argv:$*" >&2\nwhile IFS= read -r l; do echo "got:$l"; done\nexit 3\n`, { mode: 0o755 });
	const vm = fakeVm((argv) => argv.map((x) => (x === a.AGY_GUEST_BIN ? fake : x)));
	const relay = await a.startAgyRelay(async () => vm);
	try {
		const r = await runWrapper(relay.path, ["--gemini-dir", "/host/.pi/agent/antigravity-bridge/acp-homes/x", "acp"], "one\ntwo\n").done;
		assert.equal(r.code, 3);
		assert.equal(r.out, "got:one\ngot:two\n");
		assert.equal(r.err, "argv:acp\n");
	} finally {
		relay.close();
	}
});

test("relay: killing the wrapper kills agy in the VM", async () => {
	const dir = mkdtempSync(join(tmpdir(), "agykill-"));
	const fake = join(dir, "agy");
	const pidFile = join(dir, "pid");
	writeFileSync(fake, `#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`, { mode: 0o755 });
	const vm = fakeVm((argv) => argv.map((x) => (x === a.AGY_GUEST_BIN ? fake : x)));
	const relay = await a.startAgyRelay(async () => vm);
	try {
		const w = runWrapper(relay.path, ["acp"], "");
		for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
		const pid = Number(readFileSync(pidFile, "utf8"));
		w.child.kill("SIGKILL");
		await w.done;
		let alive = true;
		for (let i = 0; i < 100 && alive; i++) {
			await new Promise((r) => setTimeout(r, 50));
			try {
				process.kill(pid, 0);
			} catch {
				alive = false;
			}
		}
		assert.ok(!alive, "agy still running after the wrapper died");
	} finally {
		relay.close();
	}
});

test("relay: a session/new naming the bridge waits for the guest forwarder, which reaches the bridge through the host relay", async () => {
	const mcp = http.createServer((req, res) => res.end(`mcp ${req.url}`));
	await new Promise<void>((r) => mcp.listen(0, "127.0.0.1", () => r()));
	const mcpPort = (mcp.address() as net.AddressInfo).port;
	const host = await a.bridgeRelay();
	const guestPort = await freePort(); // where the VM's forwarder would listen (the guest's 127.0.0.1:<mcpPort>)
	const dir = mkdtempSync(join(tmpdir(), "agyfwd-"));
	const fake = join(dir, "agy");
	// The fake agy fetches the MCP URL through the forwarder as soon as it sees session/new.
	writeFileSync(fake, `#!/bin/sh\nread -r l\ncurl -s http://127.0.0.1:${guestPort}/mcp\n`, { mode: 0o755 });
	const vm = fakeVm((argv) => {
		if (argv[0] === "/usr/bin/python3") return ["python3", argv[1], argv[2], String(guestPort), "127.0.0.1", String(host.port)];
		return argv.map((x) => (x === a.AGY_GUEST_BIN ? fake : x));
	});
	const relay = await a.startAgyRelay(async () => vm);
	try {
		const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/p", mcpServers: [{ url: `http://127.0.0.1:${mcpPort}/mcp` }] } });
		const r = await runWrapper(relay.path, ["acp"], `${line}\n`).done;
		assert.equal(r.out, "mcp /mcp");
	} finally {
		relay.close();
		mcp.close();
		vm.killAll();
	}
});

test("wrapper: a sandboxed process without a relay never runs host agy", async () => {
	const child = spawn(process.execPath, [WRAPPER, "--version"], { env: { ...process.env, PI_MOUNTS_AGY_SOCKET: "", PI_MOUNTS_SANDBOXED: "1", PI_MOUNTS_HOST_AGY: "/bin/echo" }, stdio: ["ignore", "pipe", "pipe"] });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	const code = await new Promise((r) => child.on("close", r));
	assert.equal(code, 1);
	assert.equal(out, "");
	const host = spawn(process.execPath, [WRAPPER, "hello"], { env: { ...process.env, PI_MOUNTS_AGY_SOCKET: "", PI_MOUNTS_SANDBOXED: "", PI_ROLE: "", PI_MOUNTS_HOST_AGY: "/bin/echo" }, stdio: ["ignore", "pipe", "pipe"] });
	let hostOut = "";
	host.stdout.on("data", (d) => (hostOut += d));
	await new Promise((r) => host.on("close", r));
	assert.equal(hostOut, "hello\n");
});
