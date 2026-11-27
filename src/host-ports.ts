// Host loopback ports inside the VM: the guest's 127.0.0.1:<port> reaches the host's 127.0.0.1:<port>, for ports the
// role lists in hostPorts or that pi-mounts opens at run time (openHostPort, e.g. the agy bridge's MCP server).
//
// guest 127.0.0.1:<port>  ->  forwarder in the VM (python3)  ->  pi-host.internal:7777 (Gondolin raw TCP mapping, so
// replies stream)  ->  host relay  ->  host 127.0.0.1:<port>
//
// The forwarder starts each connection with the port as 2 big-endian bytes. The host relay connects only to ports
// opened for that VM.
import net from "node:net";

export const HOST_PORTS_HOST = "pi-host.internal";
export const HOST_PORTS_GUEST_PORT = 7777;

export interface HostPortRelay {
	port: number;
	allowed: Set<number>;
	close: () => void;
}

/** The host end, one per VM. */
export function hostPortRelay(ports: number[] = []): Promise<HostPortRelay> {
	return new Promise((resolve, reject) => {
		const allowed = new Set(ports);
		const server = net.createServer((c) => {
			c.on("error", () => {});
			c.once("readable", function first() {
				const head = c.read(2) as Buffer | null;
				if (!head) return c.once("readable", first);
				const port = head.readUInt16BE(0);
				if (!allowed.has(port)) return c.destroy();
				const u = net.connect(port, "127.0.0.1");
				u.on("error", () => c.destroy());
				c.on("error", () => u.destroy());
				c.pipe(u).pipe(c);
			});
		});
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.unref();
			resolve({ port: (server.address() as net.AddressInfo).port, allowed, close: () => server.close() });
		});
	});
}

/** Gondolin VM options that route pi-host.internal:7777 to the relay. */
export const hostPortVmOptions = (relay: HostPortRelay) => ({
	dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
	tcp: { hosts: { [`${HOST_PORTS_HOST}:${HOST_PORTS_GUEST_PORT}`]: `127.0.0.1:${relay.port}` } },
});

// Guest end: listens on 127.0.0.1:<port> in the VM.
const FORWARDER = `
import socket, struct, sys, threading
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
        u.sendall(struct.pack(">H", port))
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

const vms = new WeakMap<object, { relay: HostPortRelay; forwarders: Map<number, Promise<void>> }>();

/** Called by createVm for a VM booted with hostPortVmOptions(relay). */
export function registerHostPorts(vm: any, relay: HostPortRelay) {
	vms.set(vm, { relay, forwarders: new Map() });
}

/** Makes the host's 127.0.0.1:<port> reachable in the VM at the same address; resolves once the forwarder listens. */
export function openHostPort(vm: any, port: number): Promise<void> {
	const v = vms.get(vm);
	if (!v) return Promise.reject(new Error(`host port ${port}: this role's VM has no host ports (set "hostPorts" in the role file)`));
	v.relay.allowed.add(port);
	let p = v.forwarders.get(port);
	if (!p) {
		const forwarders = v.forwarders;
		p = (async () => {
			const proc = vm.exec(["/usr/bin/python3", "-c", FORWARDER, String(port), HOST_PORTS_HOST, String(HOST_PORTS_GUEST_PORT)], { stdout: "pipe", stderr: "pipe" });
			const it = proc.output()[Symbol.asyncIterator]();
			for (;;) {
				const r = await it.next();
				if (r.done) throw new Error(`host port ${port}: the guest forwarder exited before it was ready`);
				if (r.value.stream === "stdout" && String(r.value.data).includes("ready")) break;
			}
			(async () => {
				while (!(await it.next()).done);
			})()
				.catch(() => {})
				.finally(() => forwarders.delete(port));
			Promise.resolve(proc).catch(() => {});
		})();
		forwarders.set(port, p);
		p.catch(() => forwarders.delete(port));
	}
	return p;
}
