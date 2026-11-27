#!/usr/bin/env node
// vm-exec <command> [args...]: in a pi process pi-mounts sandboxes, runs the command inside the session's VM through
// pi-mounts' exec relay (PI_MOUNTS_EXEC_SOCKET); elsewhere it runs the command on the host. A sandboxed process
// without the relay never falls back to the host. From a terminal it runs interactively (pty): /vm-exec in pi prints
// the command line.
//
// A host extension that starts a CLI from a configurable path can point that path at a two-line shim calling
// run("<command>", argv), like bin/agy-vm.mjs.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { frame, frameReader } from "../src/frames.mjs";

export function run(cmd, argv) {
	const sock = process.env.PI_MOUNTS_EXEC_SOCKET;
	if (!sock) {
		if (process.env.PI_ROLE || process.env.PI_MOUNTS_SANDBOXED === "1") {
			process.stderr.write(`vm-exec: this pi process is sandboxed but pi-mounts' exec relay is not up; refusing to run ${cmd} on the host\n`);
			process.exit(1);
		}
		const child = spawn(cmd, argv, { stdio: "inherit" });
		child.on("error", (e) => {
			process.stderr.write(`vm-exec: ${e.message}\n`);
			process.exit(127);
		});
		child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
		for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
		return;
	}
	const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
	const c = net.connect(sock);
	let code = 1;
	c.on("connect", () => {
		c.write(frame("H", { cmd, argv, cwd: process.cwd(), pty: tty, rows: process.stdout.rows, cols: process.stdout.columns }));
		if (tty) {
			process.stdin.setRawMode(true);
			process.stdout.on("resize", () => c.write(frame("R", { rows: process.stdout.rows, cols: process.stdout.columns })));
		}
		process.stdin.on("data", (d) => c.write(frame("I", d)));
		process.stdin.on("end", () => c.write(frame("E")));
	});
	c.on(
		"data",
		frameReader((type, payload) => {
			if (type === "O") process.stdout.write(payload);
			else if (type === "Z") process.stderr.write(payload);
			else if (type === "X") code = JSON.parse(payload.toString("utf8")).code;
		}),
	);
	c.on("error", (e) => process.stderr.write(`vm-exec: ${e.message}\n`));
	c.on("close", () => {
		if (tty) process.stdin.setRawMode(false);
		// Let pending stdout/stderr writes drain instead of process.exit().
		process.exitCode = code;
		process.stdin.destroy();
	});
	for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) if (!tty || s !== "SIGINT") process.on(s, () => c.destroy());
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
	const [cmd, ...argv] = process.argv.slice(2);
	if (!cmd) {
		process.stderr.write("usage: vm-exec <command> [args...]\n");
		process.exit(2);
	}
	run(cmd, argv);
}
