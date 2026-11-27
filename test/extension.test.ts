import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// The extension's caches live under $HOME; keep them in a scratch dir. No VM image here, so the VM fails to start.
process.env.HOME = mkdtempSync(join(tmpdir(), "pimounts-home-"));
process.env.PI_CODING_AGENT_DIR = join(process.env.HOME, "agent");
const { default: extension } = await import("../src/extension.ts");

test("a sandboxed role: oauth2 login resolved apart from other secrets, exec relay up and torn down", async () => {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, any> = {};
	const notes: string[] = [];
	const pi: any = {
		registerTool: () => {},
		registerCommand: (n: string, c: any) => (commands[n] = c),
		on: (e: string, f: Function) => (handlers[e] ??= []).push(f),
	};
	const resolved: string[][] = [];
	(globalThis as any)[Symbol.for("pi-secret-broker.v1")] = {
		resolveSecrets: (_s: unknown, names: string[]) => {
			resolved.push(names);
			if (names.includes("AGY")) throw new Error("no keychain item");
			return Object.fromEntries(names.map((n) => [n, `v-${n}`]));
		},
		storeSecret: () => {},
	};
	const role = { secrets: { GH_TOKEN: { hosts: ["github.com"] }, AGY: { kind: "oauth2", tokenUrl: "https://oauth2.googleapis.com/token", placeholderPrefix: { access: "ya29." }, hosts: ["cloudcode-pa.googleapis.com"] }, BAD: { kind: "oauth2", hosts: [] } } };
	(globalThis as any)[Symbol.for("pi-projects.v1")] = {
		projectForCwd: () => ({ path: process.env.HOME, name: "p" }),
		sessionRole: () => ({ roleId: "app/agy-dev", role }),
		trustedGrants: () => ({ grants: { sources: { "app/agy-dev": { GH_TOKEN: "value:x", AGY: "keychain:agy" } } } }),
	};
	process.env.PI_ROLE = "app/agy-dev";
	extension(pi);
	const ctx: any = { cwd: process.env.HOME, ui: { setStatus: () => {}, notify: (m: string) => notes.push(m) } };
	for (const f of handlers.session_start) await f({}, ctx);

	assert.deepEqual(resolved, [["AGY"], ["GH_TOKEN"]]);
	assert.equal(process.env.PI_MOUNTS_SANDBOXED, "1");
	assert.ok(notes.some((n) => /BAD has no tokenUrl/.test(n)));
	assert.ok(process.env.PI_MOUNTS_EXEC_SOCKET && existsSync(process.env.PI_MOUNTS_EXEC_SOCKET));
	assert.match(process.env.AGY_BIN ?? "", /bin\/agy-vm\.mjs$/);
	const ph = JSON.parse(readFileSync(join(process.env.HOME!, ".cache", "pi-mounts", "oauth", "app--agy-dev", "AGY.json"), "utf8"));
	assert.match(ph.access, /^ya29\.pimounts-/);
	await commands["vm-exec"].handler("agy", ctx);
	assert.match(notes.at(-1)!, /PI_MOUNTS_EXEC_SOCKET=\S+ \S+vm-exec\.mjs agy$/);

	for (const f of handlers.session_shutdown) await f({}, ctx);
	assert.equal(process.env.PI_MOUNTS_EXEC_SOCKET, undefined);
});
