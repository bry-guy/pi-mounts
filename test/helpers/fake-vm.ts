import { spawn } from "node:child_process";
import net from "node:net";

/** A stand-in for a Gondolin VM: exec runs the command on this machine, with the interface pi-mounts uses.
 *  `rewrite` maps guest argv to host argv. */
export function fakeVm(rewrite: (argv: string[]) => string[] = (a) => a) {
	const children: ReturnType<typeof spawn>[] = [];
	return {
		killAll: () => children.forEach((c) => c.kill("SIGKILL")),
		exec(argv: string[], opts: any = {}) {
			const [cmd, ...args] = rewrite(argv);
			const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
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

/** Guest forwarders bind 127.0.0.2 here so they don't collide with the host server they forward to. */
export function forwarderOn127002(relayPort: number) {
	return (argv: string[]) =>
		argv[0] === "/usr/bin/python3"
			? ["python3", argv[1], argv[2].replace('s.bind(("127.0.0.1", port))', 's.bind(("127.0.0.2", port))'), argv[3], "127.0.0.1", String(relayPort)]
			: argv;
}

export const listen = (server: net.Server) =>
	new Promise<number>((res) => server.listen(0, "127.0.0.1", () => res((server.address() as net.AddressInfo).port)));
