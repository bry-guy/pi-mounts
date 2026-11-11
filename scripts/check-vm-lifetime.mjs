#!/usr/bin/env node
// Host check that sandbox VMs don't outlive their pi process. Boots real VMs through src/vm.ts (the extension's path),
// using ~/.pi/agent/pi-mounts.json. Prints PASS/FAIL per case; exit code 1 on any FAIL.
//   (a) owner quits (release(true), as session_shutdown "quit" does)  -> runner gone when the owner has exited
//   (b) owner exits with the 30 s delayed close still pending          -> runner gone (exit hook)
//   (c) owner is SIGKILLed                                              -> runner left over, then killed by the next start's sweep
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const v = await import("../src/vm.ts");
const cfg = v.loadConfig();
const policy = () => ({ projectPath: realpathSync(mkdtempSync(join(tmpdir(), "pm-life-"))), egress: [], secrets: {} });

if (process.argv[2] === "owner") {
	const mode = process.argv[3];
	const { vm, release } = v.acquire(cfg, policy());
	const pid = (await vm).getHostPid();
	console.log(pid);
	if (mode === "quit") await release(true);
	if (mode === "pending") release();
	if (mode === "kill") setInterval(() => {}, 1 << 30); // wait for SIGKILL
	else process.exit(0);
} else {
	const running = (pid) => {
		try {
			return !!execFileSync("ps", ["-o", "pid=", "-p", String(pid)], { encoding: "utf8" }).trim();
		} catch {
			return false;
		}
	};
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
	let failed = false;
	const check = (name, ok) => (console.log(`${ok ? "PASS" : "FAIL"}  ${name}`), (failed ||= !ok));
	const owner = async (mode) => {
		const child = spawn(process.execPath, [process.argv[1], "owner", mode], { stdio: ["ignore", "pipe", "inherit"] });
		const pid = Number(await new Promise((r) => (child.stdout.once("data", (d) => r(String(d).trim())), child.once("exit", () => r("")))));
		const exited = new Promise((r) => child.once("exit", r));
		if (mode === "kill") child.kill("SIGKILL");
		await exited;
		await sleep(2000); // let a SIGTERMed/SIGKILLed runner finish dying
		return pid;
	};

	for (const mode of ["quit", "pending"]) {
		const pid = await owner(mode);
		check(`(${mode === "quit" ? "a" : "b"}) ${mode}: runner ${pid} gone after the owner exits`, pid > 0 && !running(pid));
	}
	const pid = await owner("kill");
	check(`(c) SIGKILL: runner ${pid} outlives its owner (the leak the sweep cleans up)`, running(pid));
	const vm = await v.createVm(cfg, policy()); // sweeps first
	await sleep(1000);
	check(`(c) SIGKILL: runner ${pid} killed by the next start's sweep`, !running(pid));
	await vm.close();
	process.exit(failed ? 1 : 0);
}
