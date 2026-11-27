// OAuth 2 logins kept on the host (a role secret of kind "oauth2"). A CLI in the VM signs in and refreshes as usual,
// but only ever holds two placeholders:
// - pi-mounts answers the CLI's POSTs to the secret's tokenUrl (RFC 6749 token requests, form or JSON body). It swaps
//   the real refresh token in, sends the request from the host and returns placeholders.
// - The real refresh token lives in the role's grants source (read with pi-secret-broker; a new one Google or another
//   provider issues, at sign-in or on rotation, is written back with storeSecret).
// - The real access token lives only in Gondolin's secret manager, which swaps the access placeholder into request
//   headers for the secret's hosts only.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface OAuthLogin {
	/** Secret name in the role file */
	name: string;
	/** The token endpoint the CLI calls, e.g. https://oauth2.googleapis.com/token */
	tokenUrl: string;
	/** Hosts the access token is sent to */
	hosts: string[];
	/** Placeholders the guest holds */
	access: string;
	refresh: string;
	/** The real refresh token (host only); unset until the role has signed in */
	real?: string;
	/** Persists a new real refresh token */
	store: (refreshToken: string) => void;
}

/** A login's two placeholders, created once and kept: the CLI stores them in its home in the VM. `prefix` lets them
 *  look like the provider's own tokens, for CLIs that check the shape (Google: ya29. and 1//). */
export function placeholders(file: string, prefix: { access?: string; refresh?: string } = {}): { access: string; refresh: string } {
	if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
	const p = {
		access: `${prefix.access ?? ""}pimounts-${randomBytes(24).toString("hex")}`,
		refresh: `${prefix.refresh ?? ""}pimounts-${randomBytes(24).toString("hex")}`,
	};
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
	return p;
}

const json = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Gondolin onRequest hook for one login: answers POSTs to its tokenUrl, ignores every other request. */
export function tokenFacade(login: OAuthLogin, setAccess: (token: string) => void, doFetch: typeof fetch = fetch) {
	return async (req: Request): Promise<Response | undefined> => {
		if (req.method !== "POST") return;
		const u = new URL(req.url);
		if (`${u.origin}${u.pathname}` !== login.tokenUrl) return;
		const isJson = (req.headers.get("content-type") ?? "").includes("json");
		const text = await req.text();
		let fields: Record<string, unknown>;
		try {
			fields = isJson ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
		} catch {
			return json(400, { error: "invalid_request", error_description: "pi-mounts: unreadable token request" });
		}
		if (fields.refresh_token === login.refresh) {
			if (!login.real)
				return json(400, { error: "invalid_grant", error_description: `pi-mounts: no ${login.name} login yet; sign in by running the CLI in the VM (/vm-exec)` });
			fields.refresh_token = login.real;
		}
		const headers = new Headers(req.headers);
		for (const h of ["host", "content-length", "accept-encoding", "connection"]) headers.delete(h);
		const body = isJson ? JSON.stringify(fields) : new URLSearchParams(fields as Record<string, string>).toString();
		const res = await doFetch(login.tokenUrl, { method: "POST", headers, body });
		const out = await res.text();
		if (!res.ok) return new Response(out, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
		let tokens: Record<string, unknown>;
		try {
			tokens = JSON.parse(out);
		} catch {
			// Never pass an unparsed body through: it may hold real tokens.
			return json(502, { error: "server_error", error_description: "pi-mounts: unexpected token response" });
		}
		if (typeof tokens.refresh_token === "string" && tokens.refresh_token !== login.refresh) {
			try {
				login.store(tokens.refresh_token);
			} catch (e) {
				return json(502, { error: "server_error", error_description: `pi-mounts: could not store the ${login.name} login (${(e as Error).message})` });
			}
			login.real = tokens.refresh_token;
			tokens.refresh_token = login.refresh;
		}
		if (typeof tokens.access_token === "string") {
			setAccess(tokens.access_token);
			tokens.access_token = login.access;
		}
		return json(200, tokens);
	};
}

/** Gondolin isRequestAllowed for a role's egressPaths: a listed host only for requests under one of its path prefixes
 *  (e.g. www.googleapis.com only for /oauth2/, since a cloud-platform token would open its other APIs). */
export function pathsAllowed(egressPaths: Record<string, string[]>) {
	return (req: Request): boolean => {
		const u = new URL(req.url);
		const prefixes = egressPaths[u.hostname];
		return !prefixes || prefixes.some((p) => u.pathname.startsWith(p));
	};
}
