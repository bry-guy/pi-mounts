// Signs a CLI in to an oauth2 role secret without a terminal: runs its sign-in screen in a pty in the VM, shows the user
// the sign-in URL and asks for the code through pi's UI (terminal or pi-web). The token facade (src/oauth.ts) catches
// the code exchange, so the real refresh token goes to the broker and the CLI keeps placeholders.
import type { OAuthLogin } from "./oauth.ts";

export interface SignInScript {
	/** Guest command that shows the sign-in screen */
	command: string[];
	/** Keys to send when the screen shows `expect`, in order (e.g. pick "Google OAuth" from a menu) */
	steps?: { expect: RegExp; send: string }[];
	/** The sign-in URL in the screen's output */
	url: RegExp;
}

export interface SignInUi {
	notify: (msg: string, level: "info" | "warning" | "error") => void;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escapes
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/** Resolves once the facade has stored a login for `login`; rejects on cancel, exit, or timeout. */
export async function signIn(vm: any, login: OAuthLogin, script: SignInScript, ui: SignInUi, timeoutMs = 10 * 60_000): Promise<void> {
	const ac = new AbortController();
	// Wide pty so the URL isn't wrapped.
	const proc = vm.exec(script.command, { pty: true, stdin: true, stdout: "pipe", stderr: "pipe", signal: ac.signal });
	proc.resize(50, 2000);
	let screen = "";
	let step = 0;
	let asked = false;
	let exited = false;
	const done = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("sign-in timed out")), timeoutMs);
		const poll = setInterval(() => {
			if (!login.real) return;
			clearInterval(poll);
			clearTimeout(timer);
			resolve();
		}, 250);
		const stop = (e: Error) => {
			clearInterval(poll);
			clearTimeout(timer);
			reject(e);
		};
		(async () => {
			for await (const c of proc.output()) {
				screen += c.data.toString("utf8").replace(ANSI, "");
				const s = script.steps?.[step];
				if (s && s.expect.test(screen)) {
					step++;
					proc.write(s.send);
				}
				const url = !asked && script.url.exec(screen)?.[0];
				if (url) {
					asked = true;
					ui.notify(`Sign in to ${login.name}: open this URL, then paste the code you get.\n${url}`, "info");
					ui.input(`${login.name} sign-in code`, "paste the code from the browser").then(
						(code) => (code?.trim() ? proc.write(`${code.trim()}\r`) : stop(new Error("sign-in cancelled"))),
						stop,
					);
				}
			}
			exited = true;
			await proc.catch(() => {});
			if (!login.real) stop(new Error(`sign-in screen exited${screen.trim() ? `: ${screen.trim().split("\n").slice(-3).join(" ")}` : ""}`));
		})().catch((e) => !login.real && stop(e as Error));
	});
	try {
		await done;
		// The CLI saves its (placeholder) tokens after the exchange answers: give it a moment, then close the screen.
		for (let i = 0; i < 40 && !exited; i++) await new Promise((r) => setTimeout(r, 250));
	} finally {
		ac.abort();
	}
}
