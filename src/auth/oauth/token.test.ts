import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath } from "../../config/credentials.ts";
import {
	findClient,
	GRANT_AUTHORIZATION_CODE,
	type IssuedClient,
	issueClient,
	resolveJwtSecret,
	setOperatorLogin,
} from "./clients.ts";
import { verifyAccessToken } from "./jwt.ts";
import {
	ACCESS_TOKEN_TTL_SEC,
	oauthAuthorizationServerMetadata,
	oauthIssuerAudience,
	registerOauthRoutes,
} from "./token.ts";

const BASE_URL = "http://127.0.0.1:3000";
const { issuer, audience } = oauthIssuerAudience(BASE_URL);

/** Make a fresh temp `~/.openhammer` and return its credentials path. */
function tempCredPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "openhammer-oauth-token-"));
	return credentialsPath(dir);
}

/** Recurse-clean a temp dir created for a path under it. */
function rmUnder(path: string): void {
	// The temp dir is the parent of `.openhammer` — remove the whole temp root.
	rmSync(join(path, "..", ".."), { recursive: true, force: true });
}

/**
 * Build a Fastify with only the OAuth routes registered, against an isolated temp
 * credentials store. `env: {}` keeps `OAUTH_JWT_SECRET` from leaking out of the
 * real process env so the jwtSecret comes from the temp store (minted on first use).
 */
async function buildApp(baseUrl = BASE_URL): Promise<{ app: FastifyInstance; credPath: string }> {
	const credPath = tempCredPath();
	const app = Fastify({ logger: false });
	await registerOauthRoutes(app, { baseUrl, credentialsPath: credPath, env: {} });
	await app.ready();
	return { app, credPath };
}

/** Issue a real client into `credPath` and unwrap the plaintext secret. */
function seedClient(credPath: string, label = "test"): IssuedClient {
	const r = issueClient(label, {}, credPath);
	if (!r.ok) throw new Error(`issueClient failed: ${r.error.message}`);
	return r.value;
}

/** Resolve the jwtSecret, narrowing the (always-present) value to a string. */
function jwtSecret(credPath: string): string {
	const s = resolveJwtSecret({}, credPath);
	if (s === undefined) throw new Error("jwt secret was not minted");
	return s;
}

/** A form-encoded token-request body for the given credentials. */
function formBody(grant: string, c: { clientId: string; plaintextSecret: string }): string {
	return `grant_type=${grant}&client_id=${encodeURIComponent(c.clientId)}&client_secret=${encodeURIComponent(c.plaintextSecret)}`;
}

/** Form-encoded content-type header (the OAuth norm for /authorize + /token). */
const FORM_HEADERS = { "content-type": "application/x-www-form-urlencoded" };

/** The redirect_uri Claude web uses for a custom MCP connector. */
const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";

/** Encode a record as a form body. */
function form(record: Record<string, string>): string {
	return new URLSearchParams(record).toString();
}

/** Parse a redirect Location (absolute or relative — relative parses against BASE_URL). */
function locationUrl(res: { headers: { location?: string } }): URL {
	const loc = res.headers.location;
	if (typeof loc !== "string") throw new Error("response had no Location header");
	return new URL(loc, BASE_URL);
}

/** A fresh PKCE S256 pair (verifier + its base64url SHA-256 challenge). */
function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

/** Seed an authorization-code client with an optional per-client login + a registered redirect_uri. */
function seedAuthCodeClient(
	credPath: string,
	opts: { username?: string; password?: string; redirectUri?: string; label?: string } = {},
): IssuedClient {
	const r = issueClient(
		opts.label ?? "web",
		{
			grantTypes: [GRANT_AUTHORIZATION_CODE],
			redirectUris: [opts.redirectUri ?? CLAUDE_REDIRECT],
			...(opts.username !== undefined ? { username: opts.username } : {}),
			...(opts.password !== undefined ? { password: opts.password } : {}),
		},
		credPath,
	);
	if (!r.ok) throw new Error(`issueClient failed: ${r.error.message}`);
	return r.value;
}

/** POST the login form (simulating the form submission) → the issued code + client + verifier. */
async function authorizeLogin(
	app: FastifyInstance,
	credPath: string,
	password: string,
): Promise<{ client: IssuedClient; code: string; verifier: string }> {
	const client = seedAuthCodeClient(credPath, { username: "op", password: "pw" });
	const { verifier, challenge } = pkcePair();
	const login = await app.inject({
		method: "POST",
		url: "/oauth/authorize",
		headers: FORM_HEADERS,
		payload: form({
			client_id: client.clientId,
			redirect_uri: CLAUDE_REDIRECT,
			state: "",
			code_challenge: challenge,
			code_challenge_method: "S256",
			username: "op",
			password,
		}),
	});
	const code = locationUrl(login).searchParams.get("code") ?? "";
	return { client, code, verifier };
}

describe("oauthIssuerAudience", () => {
	it("derives issuer = baseUrl, audience = baseUrl + /mcp", () => {
		expect(oauthIssuerAudience(BASE_URL)).toEqual({ issuer: BASE_URL, audience: `${BASE_URL}/mcp` });
	});

	it("tracks a custom (tunnel) baseUrl", () => {
		const url = "https://tunnel.example:9999";
		expect(oauthIssuerAudience(url)).toEqual({ issuer: url, audience: `${url}/mcp` });
	});
});

describe("oauthAuthorizationServerMetadata", () => {
	it("advertises the authorization/token/registration endpoints + all grants", () => {
		expect(oauthAuthorizationServerMetadata(BASE_URL)).toEqual({
			issuer: BASE_URL,
			authorization_endpoint: `${BASE_URL}/oauth/authorize`,
			token_endpoint: `${BASE_URL}/oauth/token`,
			registration_endpoint: `${BASE_URL}/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
			code_challenge_methods_supported: ["S256"],
			scopes_supported: [],
			service_documentation: `${BASE_URL}/docs`,
		});
	});
});

describe("GET /.well-known/oauth-authorization-server", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		({ app } = await buildApp());
	});

	afterEach(async () => {
		await app.close();
	});

	it("responds 200 with the RFC 8414 metadata, reachable without auth", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/.well-known/oauth-authorization-server",
			// deliberately no Authorization header — discovery precedes auth
		});

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual(oauthAuthorizationServerMetadata(BASE_URL));
	});
});

describe("POST /oauth/token", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});

	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	it("issues a Bearer JWT for a valid client (JSON body)", async () => {
		const c = seedClient(credPath);
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/json" },
			payload: { grant_type: "client_credentials", client_id: c.clientId, client_secret: c.plaintextSecret },
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.token_type).toBe("Bearer");
		expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_SEC);
		expect(body.access_token).toBeTypeOf("string");
		// A compact JWS is three dot-separated base64url segments.
		expect(body.access_token.split(".")).toHaveLength(3);

		// The issued token must verify against the same iss/aud (proves 20d will accept).
		const claims = await verifyAccessToken(body.access_token, jwtSecret(credPath), issuer, audience);
		expect(claims).not.toBeNull();
		expect(claims?.client_id).toBe(c.clientId);
		expect(claims?.iss).toBe(issuer);
		expect(claims?.aud).toBe(audience);
		expect(claims?.sub).toBe(c.clientId);
		expect(claims?.exp).toBeTypeOf("number");
		expect(claims?.iat).toBeTypeOf("number");
		expect((claims?.exp ?? 0) - (claims?.iat ?? 0)).toBe(ACCESS_TOKEN_TTL_SEC);
	});

	it("parses a form-encoded request body (the OAuth norm, RFC 6749 §2.1)", async () => {
		const c = seedClient(credPath);
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			payload: formBody("client_credentials", c),
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.token_type).toBe("Bearer");
		expect(body.access_token.split(".")).toHaveLength(3);
		// The form-obtained token verifies identically — same grant, same iss/aud.
		const claims = await verifyAccessToken(body.access_token, jwtSecret(credPath), issuer, audience);
		expect(claims?.client_id).toBe(c.clientId);
	});

	it("rejects an unknown client_id with 401 invalid_client", async () => {
		seedClient(credPath); // a real client exists, but we POST a different id
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/json" },
			payload: { grant_type: "client_credentials", client_id: "oh_doesnotexist", client_secret: "whatever" },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "invalid_client" });
	});

	it("rejects a valid client_id with the wrong secret (401 invalid_client)", async () => {
		const c = seedClient(credPath);
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/json" },
			payload: { grant_type: "client_credentials", client_id: c.clientId, client_secret: "wrong-secret" },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual({ error: "invalid_client" });
	});

	it("rejects an unsupported grant_type with 400", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/json" },
			payload: { grant_type: "password", client_id: "oh_x", client_secret: "y" },
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({ error: "unsupported_grant_type" });
	});

	it("rejects a missing grant_type with 400 (treated as unsupported)", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: { "content-type": "application/json" },
			payload: { client_id: "oh_x", client_secret: "y" },
		});

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({ error: "unsupported_grant_type" });
	});

	it("rejects an empty body with 400 (no grant_type)", async () => {
		const res = await app.inject({ method: "POST", url: "/oauth/token" });

		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body)).toEqual({ error: "unsupported_grant_type" });
	});
});

describe("POST /register (RFC 7591)", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});
	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	it("creates an authorization-code client + returns the registration response", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/register",
			headers: { "content-type": "application/json" },
			payload: { client_name: "Claude web", redirect_uris: [CLAUDE_REDIRECT] },
		});

		expect(res.statusCode).toBe(201);
		const body = JSON.parse(res.body);
		expect(body.client_id).toMatch(/^oh_/);
		expect(typeof body.client_secret).toBe("string");
		expect(body.grant_types).toEqual([GRANT_AUTHORIZATION_CODE]);
		expect(body.redirect_uris).toEqual([CLAUDE_REDIRECT]);
		expect(body.token_endpoint_auth_method).toBe("none");
		expect(body.client_secret_expires_at).toBe(0);
		// The client is persisted + usable for /authorize.
		const rec = findClient(body.client_id, credPath);
		expect(rec?.grantTypes).toEqual([GRANT_AUTHORIZATION_CODE]);
		expect(rec?.redirectUris).toEqual([CLAUDE_REDIRECT]);
	});

	it("defaults the client_name when none is provided", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/register",
			headers: { "content-type": "application/json" },
			payload: { redirect_uris: [CLAUDE_REDIRECT] },
		});
		expect(res.statusCode).toBe(201);
		expect(JSON.parse(res.body).client_name).toBe("Dynamic registration");
	});
});

describe("GET /oauth/authorize", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});
	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	it("renders the login form for a valid auth-code client + redirect_uri", async () => {
		const c = seedAuthCodeClient(credPath, { username: "op", password: "pw" });
		const res = await app.inject({
			method: "GET",
			url: `/oauth/authorize?${form({ client_id: c.clientId, redirect_uri: CLAUDE_REDIRECT, state: "s", code_challenge: "ch", code_challenge_method: "S256" })}`,
		});

		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain("Sign in to grant access");
		expect(res.body).toContain(`value="${c.clientId}"`);
	});

	it("returns 400 for an unknown client_id", async () => {
		const res = await app.inject({
			method: "GET",
			url: `/oauth/authorize?${form({ client_id: "oh_nope", redirect_uri: CLAUDE_REDIRECT, code_challenge: "ch", code_challenge_method: "S256" })}`,
		});
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("invalid_client");
	});

	it("returns 400 for a redirect_uri the client did not register", async () => {
		const c = seedAuthCodeClient(credPath, { username: "op", password: "pw" });
		const res = await app.inject({
			method: "GET",
			url: `/oauth/authorize?${form({ client_id: c.clientId, redirect_uri: "https://evil.example/cb", code_challenge: "ch", code_challenge_method: "S256" })}`,
		});
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("invalid_request");
	});

	it("returns 400 when required parameters are missing", async () => {
		const c = seedAuthCodeClient(credPath);
		const res = await app.inject({ method: "GET", url: `/oauth/authorize?${form({ client_id: c.clientId })}` });
		expect(res.statusCode).toBe(400);
	});
});

describe("POST /oauth/authorize", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});
	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	it("redirects to the redirect_uri with a code on a valid per-client login", async () => {
		const c = seedAuthCodeClient(credPath, { username: "op", password: "pw" });
		const { challenge } = pkcePair();
		const res = await app.inject({
			method: "POST",
			url: "/oauth/authorize",
			headers: FORM_HEADERS,
			payload: form({
				client_id: c.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				state: "s1",
				code_challenge: challenge,
				code_challenge_method: "S256",
				username: "op",
				password: "pw",
			}),
		});

		expect(res.statusCode).toBe(302);
		const loc = locationUrl(res);
		expect(`${loc.origin}${loc.pathname}`).toBe(CLAUDE_REDIRECT);
		expect(loc.searchParams.get("state")).toBe("s1");
		expect(loc.searchParams.get("code")?.length).toBeGreaterThan(0);
	});

	it("redirects back to /authorize with an error on a wrong password", async () => {
		const c = seedAuthCodeClient(credPath, { username: "op", password: "pw" });
		const { challenge } = pkcePair();
		const res = await app.inject({
			method: "POST",
			url: "/oauth/authorize",
			headers: FORM_HEADERS,
			payload: form({
				client_id: c.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				state: "",
				code_challenge: challenge,
				code_challenge_method: "S256",
				username: "op",
				password: "wrong",
			}),
		});

		expect(res.statusCode).toBe(302);
		const loc = locationUrl(res);
		expect(loc.pathname).toBe("/oauth/authorize");
		expect(loc.searchParams.get("error") ?? "").toContain("Invalid");
	});

	it("authenticates against the global operator login when the client has none", async () => {
		setOperatorLogin("admin", "adminpw", credPath);
		const c = seedAuthCodeClient(credPath); // no per-client login
		const { challenge } = pkcePair();
		const res = await app.inject({
			method: "POST",
			url: "/oauth/authorize",
			headers: FORM_HEADERS,
			payload: form({
				client_id: c.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				state: "",
				code_challenge: challenge,
				code_challenge_method: "S256",
				username: "admin",
				password: "adminpw",
			}),
		});

		expect(res.statusCode).toBe(302);
		expect(locationUrl(res).searchParams.get("code")?.length).toBeGreaterThan(0);
	});
});

describe("POST /oauth/token — authorization_code", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});
	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	it("issues access + refresh for a valid code (PKCE)", async () => {
		const { client, code, verifier } = await authorizeLogin(app, credPath, "pw");
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: FORM_HEADERS,
			payload: form({
				grant_type: "authorization_code",
				code,
				client_id: client.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				code_verifier: verifier,
			}),
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.token_type).toBe("Bearer");
		expect(body.access_token.split(".")).toHaveLength(3);
		expect(typeof body.refresh_token).toBe("string");
		const claims = await verifyAccessToken(body.access_token, jwtSecret(credPath), issuer, audience);
		expect(claims?.sub).toBe("op");
		expect(claims?.client_id).toBe(client.clientId);
	});

	it("rejects a wrong PKCE verifier with 400 invalid_grant", async () => {
		const { client, code } = await authorizeLogin(app, credPath, "pw");
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: FORM_HEADERS,
			payload: form({
				grant_type: "authorization_code",
				code,
				client_id: client.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				code_verifier: "wrong-verifier",
			}),
		});
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("invalid_grant");
	});

	it("rejects a replayed code with 400 invalid_grant", async () => {
		const { client, code, verifier } = await authorizeLogin(app, credPath, "pw");
		const payload = form({
			grant_type: "authorization_code",
			code,
			client_id: client.clientId,
			redirect_uri: CLAUDE_REDIRECT,
			code_verifier: verifier,
		});
		const first = await app.inject({ method: "POST", url: "/oauth/token", headers: FORM_HEADERS, payload });
		expect(first.statusCode).toBe(200);
		const second = await app.inject({ method: "POST", url: "/oauth/token", headers: FORM_HEADERS, payload });
		expect(second.statusCode).toBe(400);
		expect(JSON.parse(second.body).error).toBe("invalid_grant");
	});
});

describe("POST /oauth/token — refresh_token", () => {
	let app: FastifyInstance;
	let credPath: string;

	beforeEach(async () => {
		({ app, credPath } = await buildApp());
	});
	afterEach(async () => {
		await app.close();
		rmUnder(credPath);
	});

	/** Complete the auth-code flow to obtain a real refresh token. */
	async function obtainRefresh(): Promise<string> {
		const { client, code, verifier } = await authorizeLogin(app, credPath, "pw");
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: FORM_HEADERS,
			payload: form({
				grant_type: "authorization_code",
				code,
				client_id: client.clientId,
				redirect_uri: CLAUDE_REDIRECT,
				code_verifier: verifier,
			}),
		});
		return JSON.parse(res.body).refresh_token as string;
	}

	it("rotates a refresh token + re-issues an access token", async () => {
		const refreshToken = await obtainRefresh();
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: FORM_HEADERS,
			payload: form({ grant_type: "refresh_token", refresh_token: refreshToken }),
		});

		expect(res.statusCode).toBe(200);
		const body = JSON.parse(res.body);
		expect(body.access_token.split(".")).toHaveLength(3);
		expect(body.refresh_token).not.toBe(refreshToken);
		const claims = await verifyAccessToken(body.access_token, jwtSecret(credPath), issuer, audience);
		expect(claims?.sub).toBe("op");
	});

	it("rejects a reused refresh token with 400 invalid_grant", async () => {
		const refreshToken = await obtainRefresh();
		const payload = form({ grant_type: "refresh_token", refresh_token: refreshToken });
		const first = await app.inject({ method: "POST", url: "/oauth/token", headers: FORM_HEADERS, payload });
		expect(first.statusCode).toBe(200);
		const second = await app.inject({ method: "POST", url: "/oauth/token", headers: FORM_HEADERS, payload });
		expect(second.statusCode).toBe(400);
		expect(JSON.parse(second.body).error).toBe("invalid_grant");
	});

	it("rejects an unknown refresh token with 400 invalid_grant", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/oauth/token",
			headers: FORM_HEADERS,
			payload: form({ grant_type: "refresh_token", refresh_token: "unknown-token" }),
		});
		expect(res.statusCode).toBe(400);
		expect(JSON.parse(res.body).error).toBe("invalid_grant");
	});
});
