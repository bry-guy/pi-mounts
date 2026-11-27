// Framing for the exec relay socket (shared by src/exec-relay.ts and bin/vm-exec.mjs, plain JS so the wrapper runs
// anywhere). A frame is one type byte, a 4-byte big-endian length, then the payload.
//   vm-exec -> pi-mounts: H hello (JSON {cmd, argv, cwd, pty, rows, cols}), I stdin data, E stdin end, R resize (JSON {rows, cols})
//   pi-mounts -> vm-exec: O stdout, Z stderr, X exit (JSON {code})

export function frame(type, payload = Buffer.alloc(0)) {
	const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload));
	const head = Buffer.alloc(5);
	head.write(type, 0, 1, "latin1");
	head.writeUInt32BE(body.length, 1);
	return Buffer.concat([head, body]);
}

/** Feeds socket chunks, calls onFrame(type, payload) for each complete frame. */
export function frameReader(onFrame) {
	let buf = Buffer.alloc(0);
	return (chunk) => {
		buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
		while (buf.length >= 5) {
			const len = buf.readUInt32BE(1);
			if (buf.length < 5 + len) break;
			const type = buf.toString("latin1", 0, 1);
			const payload = buf.subarray(5, 5 + len);
			buf = buf.subarray(5 + len);
			onFrame(type, payload);
		}
	};
}
