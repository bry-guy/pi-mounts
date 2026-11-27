import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agyNeedsSignIn } from "../src/agy.ts";
import type { OAuthLogin } from "../src/oauth.ts";
import { signIn } from "../src/sign-in.ts";
import { fakeVm } from "./helpers/fake-vm.ts";

const login = (): OAuthLogin => ({ name: "AGY", tokenUrl: "https://auth.example.com/token", hosts: [], access: "a", refresh: "r", store: () => {} });
// A sign-in screen like agy's: a menu (Enter picks), then a URL and a code prompt; it records the code it got.
const screen = (out: string) => [
	"bash",
	"-c",
	`printf '\\e[1mSelect login method:\\e[0m\\n> 1. OAuth\\n'; read -r -d $'\\r' k; printf ' https://accounts.google.com/o/oauth2/auth?a=1&b=2\\n code: '; read -r -d $'\\r' c; echo "$c" > ${out}; sleep 30`,
];

test("signIn: picks the menu entry, shows the URL, types the pasted code, finishes when the login is stored", async () => {
	const out = join(mkdtempSync(join(tmpdir(), "signin-")), "code");
	const vm = fakeVm(() => screen(out));
	const l = login();
	const notes: string[] = [];
	await signIn(vm, l, { open: () => false, command: ["agy"], steps: [{ expect: /Select login method/, send: "\r" }], url: /https:\/\/accounts\.google\.com\/\S+/ }, {
		notify: (m) => notes.push(m),
		input: async () => {
			// What the token facade does once the CLI exchanges the code.
			setTimeout(() => (l.real = "1//real"), 300);
			return " 4/code \n";
		},
	});
	vm.killAll();
	assert.match(notes[0], /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?a=1&b=2$/);
	assert.equal(readFileSync(out, "utf8").trim(), "4/code");
});

test("signIn: cancelling the code prompt or the screen exiting fails it", async () => {
	const script = { open: () => false, command: ["agy"], steps: [{ expect: /Select/, send: "\r" }], url: /https:\/\/\S+/ };
	const vm = fakeVm(() => screen("/dev/null"));
	await assert.rejects(signIn(vm, login(), script, { notify: () => {}, input: async () => undefined }), /cancelled/);
	vm.killAll();
	const quits = fakeVm(() => ["bash", "-c", "echo 'Error: no network'"]);
	await assert.rejects(signIn(quits, login(), script, { notify: () => {}, input: async () => "x" }), /exited: Error: no network/);
});

test("agy needs a login for real runs, not for probes or its own sign-in screen", () => {
	assert.equal(agyNeedsSignIn(["acp"]), true);
	assert.equal(agyNeedsSignIn(["models"]), true);
	assert.equal(agyNeedsSignIn(["--version"]), false);
	assert.equal(agyNeedsSignIn([]), false);
});
