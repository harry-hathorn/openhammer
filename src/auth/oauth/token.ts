/**
 * OAuth 2.0 client-credentials grant + RFC 8414 AS metadata (spec 20c).
 *
 * Spec 20 adds a **minimal Authorization Server** so OAuth-only MCP clients
 * (Claude Code, Cursor, custom agents that cannot set a raw `Authorization:
 * Bearer` header) connect natively: they discover the AS via RFC 8414, `POST`
 * `client_id` + `client_secret` to `/oauth/token`, and use the returned HS256
 * `access_token` against `/mcp`. Scope is the **client-credentials grant only**
 * (machine clients — no auth-code/login/users/refresh); the existing opaque
 * bearer stays supported (spec 20d wires the JWT path into the middleware).
 *
 * This module mounts three things onto `fastify`:
 *
 * - `@fastify/formbody` — OAuth token requests are form-encoded
 *   (`application/x-www-form-urlencoded`, RFC 6749 §2.1); Fastify's built-in
 *   parser only handles JSON, so formbody is registered to parse them. It only
 *   fires for that content-type, so `/mcp` (JSON-RPC over JSON) is unaffected.
 * - `GET /.well-known/oauth-authorization-server` (RFC 8414) — public; the AS
 *   advertises its `token_endpoint` + supported grant so a client can discover
 *   + exchange end-to-end. Discovery precedes auth (it is how a client learns
 *   the grant), so this route is never behind the bearer preHandler.
 * - `POST /oauth/token` — the client-credentials grant (RFC 6749 §4.4).
 *
 * **Edge, not `Result`.** Per spec 20's boundary posture (auth is an edge), the
 * grant handler `reply`s (`400 unsupported_grant_type` / `401 invalid_client`)
 * — it does not return a `Result`. The `Result` spine applies to the
 * client-management mutations in `clients.ts` (20b), not to this request edge.
 *
 * **Issuer/audience (single source).** The JWT `iss` is the server's base URL
 * (the AS issuer, matching RFC 8414's `issuer`); `aud` is the protected MCP
 * resource (`${baseUrl}/mcp`). Both are **derived from `baseUrl`** (not hardcoded
 * constants) so they stay correct under the configured host:port, and both the
 * sign path here and the verify path in the auth middleware (20d) resolve them
 * from the same `oauthIssuerAudience(baseUrl)` — the single source. (This is the
 * accepted v1 limitation from 11c: a build-time `baseUrl` carries `config.port`,
 * which is the configured port, not an ephemeral listen port.)
 */
import formbody from "@fastify/formbody";
import type { FastifyInstance } from "fastify";
import { credentialsPath } from "../../config/credentials.ts";
import { findClient, resolveJwtSecret, verifySecret } from "./clients.ts";
import { signAccessToken } from "./jwt.ts";

/** Access-token lifetime in seconds (~1h; revocation is the TTL — spec 20). */
export const ACCESS_TOKEN_TTL_SEC = 3600;

/**
 * The JWT issuer + audience derived from the server's reachable base URL. `iss`
 * is the AS issuer (its base URL — matches RFC 8414's `issuer`); `aud` is the
 * protected MCP resource (`${baseUrl}/mcp`). The single source for both the
 * `/oauth/token` sign (here) and the middleware verify (20d) — derived, not a
 * hardcoded constant, so they track the configured host:port.
 */
export function oauthIssuerAudience(baseUrl: string): { issuer: string; audience: string } {
	return { issuer: baseUrl, audience: `${baseUrl}/mcp` };
}

/**
 * RFC 8414 authorization-server metadata advertised at
 * `/.well-known/oauth-authorization-server`. `issuer` is the server base URL;
 * `grant_types_supported` pins the AS to the client-credentials grant;
 * `token_endpoint_auth_methods_supported` advertises `client_secret_post`
 * (secrets in the body — the only method the grant reads). An OAuth-only client
 * uses this to discover the token endpoint and connect end-to-end.
 */
export function oauthAuthorizationServerMetadata(baseUrl: string): Record<string, unknown> {
	return {
		issuer: baseUrl,
		token_endpoint: `${baseUrl}/oauth/token`,
		grant_types_supported: ["client_credentials"],
		token_endpoint_auth_methods_supported: ["client_secret_post"],
		scopes_supported: [],
		service_documentation: `${baseUrl}/docs`,
	};
}

/** Type guard narrowing an unknown request body to a string-keyed record (no `as`). */
function isRecord(body: unknown): body is Record<string, unknown> {
	return typeof body === "object" && body !== null && !Array.isArray(body);
}

/** Options for {@link registerOauthRoutes}. */
export interface OauthRoutesOptions {
	/** Server base URL (`protocol://host[:port]`) — the AS issuer + token-endpoint root. */
	baseUrl: string;
	/** Credentials.json path (test injection; default = real `~/.openhammer/credentials.json`). */
	credentialsPath?: string;
	/** Process env for `OAUTH_JWT_SECRET` (test injection; default = `process.env`). */
	env?: NodeJS.ProcessEnv;
}

/**
 * Register the OAuth AS routes on `fastify`: formbody (so form posts parse),
 * the RFC 8414 metadata (public), and `POST /oauth/token` (the
 * client-credentials grant). None of these are behind the bearer preHandler —
 * `/oauth/token` **is** the auth (it mints the token), and the metadata must
 * precede auth so a client can discover the grant.
 */
export async function registerOauthRoutes(fastify: FastifyInstance, opts: OauthRoutesOptions): Promise<void> {
	const { baseUrl } = opts;
	const credPath = opts.credentialsPath ?? credentialsPath();
	const env = opts.env ?? process.env;
	const { issuer, audience } = oauthIssuerAudience(baseUrl);

	// Form bodies are the OAuth norm (RFC 6749 §2.1). Registered globally — the
	// parser only fires for `application/x-www-form-urlencoded`, which `/mcp`
	// (JSON-RPC over JSON) never sends, so the MCP transport is unaffected.
	await fastify.register(formbody);

	// RFC 8414 metadata — public (discovery precedes auth).
	fastify.get("/.well-known/oauth-authorization-server", async () => oauthAuthorizationServerMetadata(baseUrl));

	// POST /oauth/token — the client-credentials grant (RFC 6749 §4.4).
	fastify.post("/oauth/token", async (req, reply) => {
		const body = isRecord(req.body) ? req.body : {};
		const grantType = typeof body.grant_type === "string" ? body.grant_type : "";
		if (grantType !== "client_credentials") {
			// RFC 6749 §5.2 — any non-client_credentials grant is unsupported in v1.
			return reply.code(400).send({ error: "unsupported_grant_type" });
		}
		const clientId = typeof body.client_id === "string" ? body.client_id : "";
		const clientSecret = typeof body.client_secret === "string" ? body.client_secret : "";
		const client = clientId !== "" ? findClient(clientId, credPath) : undefined;
		// No matching client, or a wrong/missing secret → RFC 6749 `invalid_client` (401).
		if (client === undefined || !verifySecret(clientSecret, client.secretHash)) {
			return reply.code(401).send({ error: "invalid_client" });
		}
		const jwtSecret = resolveJwtSecret(env, credPath);
		// No jwtSecret available (unwritable cred dir + no `OAUTH_JWT_SECRET` env) →
		// cannot sign. RFC 6749 §5.2 `server_error`; not a client fault (500).
		if (jwtSecret === undefined) {
			return reply.code(500).send({ error: "server_error", error_description: "jwt secret unavailable" });
		}
		const accessToken = await signAccessToken(
			{ iss: issuer, aud: audience, sub: clientId, client_id: clientId },
			jwtSecret,
			ACCESS_TOKEN_TTL_SEC,
		);
		return reply.send({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SEC });
	});
}
