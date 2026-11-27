import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http from "node:http";
import { test } from "node:test";
import { hostPortRelay, openHostPort, registerHostPorts } from "../src/host-ports.ts";
import { fakeVm, forwarderOn127002, listen } from "./helpers/fake-vm.ts";

const get = (port: number) => execFileSync("curl", ["-s", "--max-time", "3", `http://127.0.0.2:${port}/x`], { encoding: "utf8" });

test("an opened host port is reachable in the VM through the forwarder and the relay; others are not", async () => {
	const server = http.createServer((req, res) => res.end(`host ${req.url}`));
	const port = await listen(server);
	const other = http.createServer((_q, res) => res.end("secret"));
	const otherPort = await listen(other);
	const relay = await hostPortRelay();
	const vm = fakeVm(forwarderOn127002(relay.port));
	try {
		await assert.rejects(openHostPort(fakeVm(), port), /no host ports/);
		registerHostPorts(vm, relay);
		await openHostPort(vm, port);
		await openHostPort(vm, port); // one forwarder per port
		assert.equal(get(port), "host /x");
		// A forwarder for a port the relay wasn't told about gets nothing.
		relay.allowed.delete(port);
		assert.equal(get(port), "");
		relay.allowed.add(port);
		assert.equal(get(otherPort), "");
	} finally {
		vm.killAll();
		relay.close();
		server.close();
		other.close();
	}
});
