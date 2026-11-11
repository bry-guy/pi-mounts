// VM lifetime with a fake Gondolin and a fake process table: no VM boots here.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const v = await import("../src/vm.ts");

const tmp = mkdtempSync(join(tmpdir(), "pm-life-"));
const image = join(tmp, "image");
mkdirSync(image);
writeFileSync(join(image, "manifest.json"), "{}");
const fake = join(tmp, "gondolin.mjs");
writeFileSync(
	fake,
	`class P { constructor(...a) { this.a = a; } }
export const ShadowProvider = P, ReadonlyProvider = P, RealFSProvider = P;
export const createHttpHooks = () => ({ httpHooks: {}, env: {}, secretManager: { updateSecret() {} } });
export const VM = { async create() { return globalThis.fakeVm(); } };`,
);
const cfg = { gondolin: fake, image };

// Fake process table: pid -> command line; owners alive by pid.
const procs = new Map<number, string>();
const alive = new Set<number>();
const killed: number[] = [];
let nextPid = 1000;
let creates = 0;
let closes = 0;
(globalThis as any).fakeVm = () => {
	creates++;
	const pid = nextPid++;
	return {
		async start() {
			procs.set(pid, `qemu-system-aarch64 -kernel ${image}/vmlinuz -qmp unix:/tmp/gondolin-qmp-${pid}.sock`);
		},
		getHostPid: () => pid,
		async close() {
			closes++;
			procs.delete(pid);
		},
	};
};
v.host.dir = join(tmp, "vms");
v.host.pid = 1;
v.host.alive = (pid) => pid === v.host.pid || alive.has(pid);
v.host.command = (pid) => procs.get(pid);
v.host.kill = (pid) => (killed.push(pid), procs.delete(pid));

const project = () => {
	const d = mkdtempSync(join(tmp, "proj-"));
	return { projectPath: d, egress: [], secrets: {} };
};
const record = (pid: number, owner: number, command: string) => {
	mkdirSync(v.host.dir, { recursive: true });
	writeFileSync(join(v.host.dir, `${pid}.json`), JSON.stringify({ pid, owner, command }));
};

test("sessions in one process share the VM; quit closes it at once, not after 30 s", async () => {
	const p = project();
	const a = v.acquire(cfg, p);
	const b = v.acquire(cfg, p);
	assert.equal(await a.vm, await b.vm);
	assert.equal(creates, 1);
	assert.ok(existsSync(join(v.host.dir, `${(await a.vm).getHostPid()}.json`)), "runner recorded");
	await a.release(true);
	assert.equal(closes, 0, "another session still uses it");
	await b.release(true);
	assert.equal(closes, 1);
	assert.deepEqual(readdirSync(v.host.dir), [], "record removed on close");
});

test("process exit kills this process's VMs even with the delayed close pending", async () => {
	const s = v.acquire(cfg, project());
	const pid = (await s.vm).getHostPid();
	s.release(); // 30 s timer, which exit never waits for
	assert.ok(process.listeners("exit").includes(v.reapOwn));
	v.reapOwn();
	assert.deepEqual(killed, [pid]);
	assert.ok(!procs.has(pid));
	assert.deepEqual(readdirSync(v.host.dir), []);
	killed.length = 0;
});

test("sweep kills an orphan, spares a live owner's VM and a reused pid", () => {
	procs.set(50, "qemu orphan qmp-50");
	record(50, 900, "qemu orphan qmp-50"); // owner 900 is dead
	procs.set(51, "qemu live qmp-51");
	alive.add(901);
	record(51, 901, "qemu live qmp-51");
	procs.set(52, "/usr/bin/some-other-process");
	record(52, 902, "qemu old qmp-52"); // owner dead, pid now reused by something else
	v.sweep();
	assert.deepEqual(killed, [50]);
	assert.ok(procs.has(51) && procs.has(52));
	assert.deepEqual(readdirSync(v.host.dir), ["51.json"]);
});

test("starting a VM sweeps first", async () => {
	killed.length = 0;
	procs.set(60, "qemu orphan qmp-60");
	record(60, 903, "qemu orphan qmp-60");
	const s = v.acquire(cfg, project());
	await s.vm;
	assert.deepEqual(killed, [60]);
	await s.release(true);
});
