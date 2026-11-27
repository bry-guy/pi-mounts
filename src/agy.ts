// agy (the Antigravity CLI, driven by @estebanforge/pi-antigravity-bridge) in the role's VM: the exec relay's adapter
// for it. The generic parts are src/exec-relay.ts (AGY_BIN = bin/agy-vm), src/host-ports.ts (agy reaches the bridge's
// MCP server) and src/oauth.ts (the Google login stays on the host).
import { openHostPort } from "./host-ports.ts";
import type { Adapter } from "./exec-relay.ts";

/** The bridge's --gemini-dir is a host folder linked to the host's own agy login: agy uses the role's home instead. */
export function guestArgs(argv: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--gemini-dir" || argv[i] === "--gemini_dir") i++;
		else if (!/^--gemini[-_]dir=/.test(argv[i])) out.push(argv[i]);
	}
	return out;
}

/** The bridge's MCP port from an ACP session/new or session/load line, if it names a loopback server. */
export function bridgePort(line: string): number | undefined {
	if (!line.includes("mcpServers")) return;
	let msg: any;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	if (msg?.method !== "session/new" && msg?.method !== "session/load") return;
	for (const s of msg.params?.mcpServers ?? []) {
		const m = /^http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//.exec(String(s?.url ?? ""));
		if (m) return Number(m[1]);
	}
}

export const agyAdapter: Adapter = {
	args: guestArgs,
	// The bridge's URL then works unchanged in the VM; agy's first connection waits until it does.
	onLine: async (line, vm) => {
		const port = bridgePort(line);
		if (port) await openHostPort(vm, port);
	},
};
