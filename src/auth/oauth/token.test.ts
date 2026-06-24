import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath } from "../../config/credentials.ts";
import { type IssuedClient, issueClient, resolveJwtSecret } from "./clients.ts";
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
	const r = issueClient(label, credPath);
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
	it("advertises the issuer + token endpoint + client-credentials grant", () => {
		expect(oauthAuthorizationServerMetadata(BASE_URL)).toEqual({
			issuer: BASE_URL,
			token_endpoint: `${BASE_URL}/oauth/token`,
			grant_types_supported: ["client_credentials"],
			token_endpoint_auth_methods_supported: ["client_secret_post"],
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
