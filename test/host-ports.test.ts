import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import http from "node:http";
import { test } from "node:test";
import { hostPortRelay, openHostPort, registerHostPorts } from "../src/host-ports.ts";
import { fakeVm, GUEST_SHIFT, guestForwarder, listen } from "./helpers/fake-vm.ts";

// Async: the host relay runs in this process.
const get = (port: number) => new Promise<string>((res) => execFile("curl", ["-s", "--max-time", "3", `http://127.0.0.1:${port - GUEST_SHIFT}/x`], (_e, out) => res(out)));

test("an opened host port is reachable in the VM through the forwarder and the relay; others are not", async () => {
	const server = http.createServer((req, res) => res.end(`host ${req.url}`));
	const port = await listen(server);
	const other = http.createServer((_q, res) => res.end("secret"));
	const otherPort = await listen(other);
	const relay = await hostPortRelay();
	const vm = fakeVm(guestForwarder(relay.port));
	try {
		await assert.rejects(openHostPort(fakeVm(), port), /no host ports/);
		registerHostPorts(vm, relay);
		await openHostPort(vm, port);
		await openHostPort(vm, port); // one forwarder per port
		assert.equal(await get(port), "host /x");
		// A forwarder for a port the relay wasn't told about gets nothing.
		relay.allowed.delete(port);
		assert.equal(await get(port), "");
		relay.allowed.add(port);
		assert.equal(await get(otherPort), "");
	} finally {
		vm.killAll();
		relay.close();
		server.close();
		other.close();
	}
});
