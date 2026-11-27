import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agyAdapter, bridgePort, guestArgs } from "../src/agy.ts";
import { startExecRelay } from "../src/exec-relay.ts";
import { hostPortRelay, registerHostPorts } from "../src/host-ports.ts";
import { fakeVm, forwarderOn127002, listen } from "./helpers/fake-vm.ts";

const bin = (f: string) => fileURLToPath(new URL(`../bin/${f}`, import.meta.url));

function run(script: string, args: string[], env: Record<string, string>, input = "") {
	const child = spawn(process.execPath, [bin(script), ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
	let out = "";
	let err = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (err += d));
	child.stdin.end(input);
	return { child, done: new Promise<{ code: number | null; out: string; err: string }>((res) => child.on("close", (code) => res({ code, out, err }))) };
}

function script(body: string) {
	const f = join(mkdtempSync(join(tmpdir(), "vmexec-")), "cmd");
	writeFileSync(f, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
	return f;
}

test("vm-exec runs the command in the VM with stdio and the exit code passed through", async () => {
	const relay = await startExecRelay(async () => fakeVm());
	try {
		const cmd = script(`echo "argv:$*" >&2\nwhile IFS= read -r l; do echo "got:$l"; done\nexit 3`);
		const r = await run("vm-exec.mjs", [cmd, "a", "b c"], { PI_MOUNTS_EXEC_SOCKET: relay.path }, "one\ntwo\n").done;
		assert.deepEqual(r, { code: 3, out: "got:one\ngot:two\n", err: "argv:a b c\n" });
	} finally {
		relay.close();
	}
});

test("killing vm-exec kills the command in the VM", async () => {
	const pidFile = join(mkdtempSync(join(tmpdir(), "vmexec-")), "pid");
	const relay = await startExecRelay(async () => fakeVm());
	try {
		const w = run("vm-exec.mjs", [script(`echo $$ > ${pidFile}\nexec sleep 60`)], { PI_MOUNTS_EXEC_SOCKET: relay.path });
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
		assert.ok(!alive, "the command still runs after vm-exec died");
	} finally {
		relay.close();
	}
});

test("vm-exec outside a sandbox runs on the host; a sandboxed process without the relay refuses", async () => {
	const host = await run("vm-exec.mjs", ["echo", "hello"], { PI_MOUNTS_EXEC_SOCKET: "", PI_MOUNTS_SANDBOXED: "", PI_ROLE: "" }).done;
	assert.deepEqual([host.code, host.out], [0, "hello\n"]);
	const refused = await run("vm-exec.mjs", ["echo", "hello"], { PI_MOUNTS_EXEC_SOCKET: "", PI_MOUNTS_SANDBOXED: "1" }).done;
	assert.deepEqual([refused.code, refused.out], [1, ""]);
});

test("agy: guestArgs drops the bridge's host --gemini-dir in every spelling", () => {
	assert.deepEqual(guestArgs(["--gemini-dir", "/h/x", "acp"]), ["acp"]);
	assert.deepEqual(guestArgs(["--gemini_dir", "/h/x", "--version"]), ["--version"]);
	assert.deepEqual(guestArgs(["--gemini-dir=/h/x", "models", "--json"]), ["models", "--json"]);
});

test("agy: bridgePort reads loopback MCP servers from session/new and session/load only", () => {
	const msg = (method: string, url: string) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { cwd: "/p", mcpServers: [{ name: "pi", type: "http", url, headers: [] }] } });
	assert.equal(bridgePort(msg("session/new", "http://127.0.0.1:4321/mcp")), 4321);
	assert.equal(bridgePort(msg("session/load", "http://localhost:99/mcp")), 99);
	assert.equal(bridgePort(msg("session/prompt", "http://127.0.0.1:4321/mcp")), undefined);
	assert.equal(bridgePort(msg("session/new", "http://10.0.0.1:4321/mcp")), undefined);
	assert.equal(bridgePort("not json mcpServers"), undefined);
});

test("agy-vm: the bridge's session/new opens its MCP port in the VM before agy sees it", async () => {
	const mcp = http.createServer((req, res) => res.end(`mcp ${req.url}`));
	const mcpPort = await listen(mcp);
	const ports = await hostPortRelay();
	const vm = fakeVm((argv) => {
		const a = forwarderOn127002(ports.port)(argv);
		// "agy" in the VM: fetch the MCP URL (as the forwarder serves it) once session/new arrives, echo its argv.
		return a[3] === "agy" ? [...a.slice(0, 3), agy, ...a.slice(4)] : a;
	});
	const agy = script(`echo "argv:$*" >&2\nread -r l\ncurl -s --max-time 3 http://127.0.0.2:${mcpPort}/mcp`);
	registerHostPorts(vm, ports);
	const relay = await startExecRelay(async () => vm, { agy: agyAdapter });
	try {
		const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/p", mcpServers: [{ url: `http://127.0.0.1:${mcpPort}/mcp` }] } });
		const r = await run("agy-vm.mjs", ["--gemini-dir", "/host/acp-home", "acp"], { PI_MOUNTS_EXEC_SOCKET: relay.path }, `${line}\n`).done;
		assert.deepEqual(r, { code: 0, out: "mcp /mcp", err: "argv:acp\n" });
	} finally {
		relay.close();
		vm.killAll();
		ports.close();
		mcp.close();
	}
});
