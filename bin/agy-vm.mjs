#!/usr/bin/env node
// agy-vm: set AGY_BIN to this file. In a pi process pi-mounts sandboxes, it runs agy inside the role's VM through
// pi-mounts' relay socket; elsewhere it runs the host's agy (PI_MOUNTS_HOST_AGY, default "agy" on PATH).
// A sandboxed process without a relay never falls back to the host.
// Run it yourself (no arguments) from a terminal holding the relay's PI_MOUNTS_AGY_SOCKET to sign agy in: /agy-login
// prints the exact command.
import { spawn } from "node:child_process";
import net from "node:net";
import { frame, frameReader } from "../src/frames.mjs";

const argv = process.argv.slice(2);
const sock = process.env.PI_MOUNTS_AGY_SOCKET;

if (!sock) {
	if (process.env.PI_ROLE || process.env.PI_MOUNTS_SANDBOXED === "1") {
		process.stderr.write("agy-vm: this pi process is sandboxed but pi-mounts' agy relay is not up; refusing to run agy on the host\n");
		process.exit(1);
	}
	const child = spawn(process.env.PI_MOUNTS_HOST_AGY || "agy", argv, { stdio: "inherit" });
	child.on("error", (e) => {
		process.stderr.write(`agy-vm: ${e.message}\n`);
		process.exit(127);
	});
	child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 1)));
	for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(s, () => child.kill(s));
} else {
	const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
	const c = net.connect(sock);
	let code = 1;
	c.on("connect", () => {
		c.write(frame("H", { argv, cwd: process.cwd(), pty: tty, rows: process.stdout.rows, cols: process.stdout.columns }));
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
	c.on("error", (e) => process.stderr.write(`agy-vm: ${e.message}\n`));
	c.on("close", () => {
		if (tty) process.stdin.setRawMode(false);
		// Let pending stdout/stderr writes drain instead of process.exit().
		process.exitCode = code;
		process.stdin.destroy();
	});
	for (const s of ["SIGTERM", "SIGINT", "SIGHUP"]) if (!tty || s !== "SIGINT") process.on(s, () => c.destroy());
}
