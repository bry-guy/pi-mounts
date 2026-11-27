// agy (the Antigravity CLI, driven by @estebanforge/pi-antigravity-bridge) in the role's VM: the exec relay's adapter
// for it. The generic parts are src/exec-relay.ts (AGY_BIN = bin/agy-vm), src/host-ports.ts (agy reaches the bridge's
// MCP server) and src/oauth.ts (the Google login stays on the host).
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { openHostPort } from "./host-ports.ts";
import type { Adapter } from "./exec-relay.ts";
import type { SignInScript } from "./sign-in.ts";

/** agy's first-run screen: a login menu (Enter picks Google OAuth), then the URL and a code prompt. */
export const agySignIn: SignInScript = {
	command: ["agy"],
	steps: [{ expect: /Select login method/, send: "\r" }],
	url: /https:\/\/accounts\.google\.com\/\S+/,
};

/** Runs that talk to Google (not --version/--help probes, nor a bare `agy`, which is its own sign-in screen). */
export const agyNeedsSignIn = (argv: string[]) => argv.length > 0 && !argv.some((a) => /^-{1,2}(version|help|h|v)$/.test(a));

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

/** The bridge lists models from `agy models` at pi start, before the VM is up, so it would only offer its fallback
 *  names. Once agy is signed in, write the bridge's model cache from the VM; the bridge keeps using a cache even after
 *  it goes stale (its background refresh fails quietly), so this is needed once. Takes effect on the next pi start. */
export async function seedBridgeModels(vm: any, file = join(getAgentDir(), "antigravity-bridge", "models-cache.json")): Promise<boolean> {
	if (existsSync(file)) return false;
	const r = await vm.exec(["agy", "models"], { stdout: "pipe", stderr: "pipe" });
	const raw = String(r.stdout ?? "");
	if (r.exitCode !== 0 || !/^\s*gemini-/m.test(raw)) return false;
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(`${file}.tmp`, `${JSON.stringify({ raw, savedAt: Date.now() }, null, 2)}\n`, { mode: 0o600 });
	renameSync(`${file}.tmp`, file);
	return true;
}
