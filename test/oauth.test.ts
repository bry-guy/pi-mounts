import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type OAuthLogin, pathsAllowed, placeholders, tokenFacade } from "../src/oauth.ts";

test("placeholders are created once and kept, with an optional provider-like prefix", () => {
	const dir = mkdtempSync(join(tmpdir(), "ph-"));
	const p = placeholders(join(dir, "r", "A.json"), { access: "ya29.", refresh: "1//" });
	assert.match(p.access, /^ya29\.pimounts-[0-9a-f]{48}$/);
	assert.match(p.refresh, /^1\/\/pimounts-/);
	assert.deepEqual(placeholders(join(dir, "r", "A.json")), p);
	assert.match(placeholders(join(dir, "B.json")).access, /^pimounts-/);
});

test("pathsAllowed limits only the listed hosts", () => {
	const ok = pathsAllowed({ "www.googleapis.com": ["/oauth2/"] });
	assert.ok(ok(new Request("https://www.googleapis.com/oauth2/v2/userinfo")));
	assert.ok(!ok(new Request("https://www.googleapis.com/storage/v1/b")));
	assert.ok(ok(new Request("https://cloudcode-pa.googleapis.com/v1internal:generateContent")));
});

const TOKEN_URL = "https://auth.example.com/oauth/token";
function login(over: Partial<OAuthLogin> = {}) {
	const stored: string[] = [];
	const l: OAuthLogin = { name: "EX", tokenUrl: TOKEN_URL, hosts: ["api.example.com"], access: "acc-PH", refresh: "ref-PH", real: "ref-REAL", store: (v) => void stored.push(v), ...over };
	return { l, stored };
}
const tokenReq = (body: string, type = "application/x-www-form-urlencoded") =>
	new Request(TOKEN_URL, { method: "POST", headers: { "content-type": type, host: "auth.example.com" }, body });

test("other requests pass through untouched", async () => {
	const f = tokenFacade(login().l, () => {}, async () => assert.fail("no fetch"));
	assert.equal(await f(new Request("https://api.example.com/v1/x", { method: "POST", body: "{}" })), undefined);
	assert.equal(await f(new Request(TOKEN_URL)), undefined);
	assert.equal(await f(new Request("https://oauth2.googleapis.com/token", { method: "POST", body: "a=b" })), undefined);
});

test("refresh: the real token goes out from the host, placeholders come back, the real access token stays on the host", async () => {
	const { l, stored } = login();
	let access = "";
	let sent: URLSearchParams | undefined;
	const f = tokenFacade(
		l,
		(t) => (access = t),
		(async (url: string, init: RequestInit) => {
			assert.equal(url, TOKEN_URL);
			sent = new URLSearchParams(String(init.body));
			assert.equal(new Headers(init.headers).get("host"), null);
			return new Response(JSON.stringify({ access_token: "acc-REAL", expires_in: 3599, token_type: "Bearer", scope: "s" }));
		}) as typeof fetch,
	);
	const res = (await f(tokenReq("grant_type=refresh_token&refresh_token=ref-PH&client_id=cid")))!;
	assert.equal(sent!.get("refresh_token"), "ref-REAL");
	assert.equal(sent!.get("client_id"), "cid");
	assert.deepEqual(await res.json(), { access_token: "acc-PH", expires_in: 3599, token_type: "Bearer", scope: "s" });
	assert.equal(access, "acc-REAL");
	assert.deepEqual(stored, []);
});

test("sign-in: a new refresh token is stored and replaced by the placeholder (JSON bodies too)", async () => {
	const { l, stored } = login({ real: undefined });
	const f = tokenFacade(l, () => {}, (async () => new Response(JSON.stringify({ access_token: "acc-REAL", refresh_token: "ref-NEW" }))) as typeof fetch);
	const res = (await f(tokenReq(JSON.stringify({ grant_type: "authorization_code", code: "c", code_verifier: "v" }), "application/json")))!;
	assert.deepEqual(await res.json(), { access_token: "acc-PH", refresh_token: "ref-PH" });
	assert.deepEqual(stored, ["ref-NEW"]);
	assert.equal(l.real, "ref-NEW");
});

test("no login, a failed store or an unreadable reply never leaks a token or forwards a placeholder", async () => {
	const r1 = (await tokenFacade(login({ real: undefined }).l, () => {}, async () => assert.fail("no fetch"))(tokenReq("grant_type=refresh_token&refresh_token=ref-PH")))!;
	assert.equal(r1.status, 400);
	assert.equal((await r1.json()).error, "invalid_grant");

	const failing = login({ store: () => { throw new Error("keychain locked"); } }).l;
	const r2 = (await tokenFacade(failing, () => {}, (async () => new Response(JSON.stringify({ access_token: "acc-REAL", refresh_token: "ref-NEW" }))) as typeof fetch)(tokenReq("grant_type=authorization_code&code=c")))!;
	assert.equal(r2.status, 502);
	assert.ok(!(await r2.text()).includes("REAL"));

	const r3 = (await tokenFacade(login().l, () => {}, (async () => new Response("access_token=acc-REAL")) as typeof fetch)(tokenReq("grant_type=refresh_token&refresh_token=ref-PH")))!;
	assert.equal(r3.status, 502);
	assert.ok(!(await r3.text()).includes("REAL"));

	const r4 = (await tokenFacade(login().l, () => {}, (async () => new Response('{"error":"invalid_grant"}', { status: 400 })) as typeof fetch)(tokenReq("grant_type=refresh_token&refresh_token=ref-PH")))!;
	assert.equal(r4.status, 400);
});
