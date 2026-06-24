/**
 * Bearer-token auth preHandler (spec 11) + opt-in client allowlist (spec 17r) +
 * AS-issued JWT acceptance (spec 20d).
 *
 * Gates `/mcp` with **either** of two accepted credentials:
 *
 * - the per-instance **opaque token** minted by `ensureToken` (spec 11) — the
 *   existing v1 gate; compared in constant time (`crypto.timingSafeEqual`), a
 *   length mismatch short-circuiting *before* `timingSafeEqual` (it throws
 *   `RangeError` on unequal lengths — the guard is load-bearing, and leaking
 *   the expected token's length is acceptable);
 * - **or** an AS-issued **HS256 JWT** (spec 20): an OAuth-only client that
 *   cannot set a raw `Bearer` header exchanges `client_id`+`client_secret` at
 *   `/oauth/token` for a short-lived JWT, which is verified statelessly here
 *   (signature + `iss` + `aud` + `exp` via `jose` — `verifyAccessToken`).
 *
 * On any miss/mismatch (neither credential validates) the hook replies 401 with
 * a `WWW-Authenticate` challenge pointing at the protected-resource discovery
 * document and a JSON-RPC error body, then ends the request (the route handler
 * never runs).
 *
 * Client allowlist (17r): the credential is the **real** gate. When a non-empty,
 * non-`["*"]` `allowedClients` is supplied the hook *additionally* checks the
 * caller's identity and replies `403` on a miss — authenticated, but not a
 * permitted client type. The identity it reads depends on the credential that
 * passed: an **opaque** token carries no identity, so the filter is a
 * best-effort **`User-Agent` substring** match (OpenHammer is stateless, so
 * `initialize`'s `clientInfo` is not retained for a later `tools/call`; a
 * token-holder can spoof the header, so this only narrows honest clients). A
 * **JWT** carries a precise `client_id`, so the filter is an **exact** match
 * against it (spec 20d) — a high-entropy id, not a User-Agent product string, so
 * the substring match would be wrong. Default `[]` / `["*"]` = any client in
 * both paths → non-breaking.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Config } from "../config.ts";
import { verifyAccessToken } from "./oauth/jwt.ts";

/** JSON-RPC error body sent on every auth failure (401). */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** JSON-RPC error body sent when an opaque-token client fails the User-Agent allowlist (403). */
const FORBIDDEN_UA_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (User-Agent not in allowedClients)" },
	id: null,
};

/** JSON-RPC error body sent when a JWT client's `client_id` fails the allowlist (403). */
const FORBIDDEN_CLIENT_ID_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (client_id not in allowedClients)" },
	id: null,
};

/**
 * Extract the bearer token from an `Authorization` header. The scheme is matched
 * case-insensitively and the value is whitespace-trimmed; anything that is not
 * exactly `<scheme> <token>` is treated as absent (`undefined`).
 */
function parseBearer(header: string | string[] | undefined): string | undefined {
	if (typeof header !== "string") return undefined;
	const parts = header.trim().split(/\s+/);
	if (parts.length !== 2) return undefined;
	const [scheme, value] = parts;
	return scheme.toLowerCase() === "bearer" ? value : undefined;
}

/**
 * Constant-time equality of a presented token against the expected Buffer. A
 * length mismatch returns `false` *before* `timingSafeEqual` runs (it throws on
 * unequal lengths). Leaking the expected length is acceptable.
 */
function constantTimeEquals(presented: string, expected: Buffer): boolean {
	const a = Buffer.from(presented);
	if (a.length !== expected.length) return false;
	return timingSafeEqual(a, expected);
}

/**
 * Resolve the base URL for `WWW-Authenticate`/discovery links from the live
 * request so it stays correct under the tunnel. The `Host` header carries the
 * authority *and* port (non-default/ephemeral ports survive); falls back to the
 * configured `host:port` when no Host header is present.
 *
 * (Fastify v4 exposes no `request.host` property — only `hostname`, which for
 * HTTP/1.1 returns the raw `Host` header value anyway. Reading the header
 * directly is type-honest about its possible absence and keeps the fallback
 * branch real.)
 */
function resolveBaseUrl(request: FastifyRequest, config: Config): string {
	const host = request.headers.host;
	if (typeof host === "string" && host !== "") {
		return `${request.protocol}://${host}`;
	}
	return `http://${config.host}:${config.port}`;
}

/**
 * Whether the inbound `User-Agent` satisfies the `allowedClients` allowlist
 * (17r). `[]` or `["*"]` = any client (the non-breaking default). Otherwise the
 * match is a **case-insensitive substring** of the header: a client named `foo`
 * is admitted when its `User-Agent` (e.g. `foo/1.2.0`) contains `foo`. A missing
 * or blank header is a miss while the gate is active (an unknown client). The
 * substring match is deliberately lenient — this is a secondary, best-effort
 * filter behind the real bearer gate, so version suffixes and incidental
 * surrounding text don't false-negative an honest client.
 */
export function isClientAllowed(userAgent: string | string[] | undefined, allowedClients: string[]): boolean {
	if (allowedClients.length === 0 || allowedClients.includes("*")) return true;
	const raw = Array.isArray(userAgent) ? userAgent[0] : userAgent;
	const ua = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	if (ua === "") return false;
	return allowedClients.some((name) => ua.includes(name.toLowerCase()));
}

/**
 * Whether a JWT `client_id` satisfies the `allowedClients` allowlist (spec 20d).
 * `[]` or `["*"]` = any client (the non-breaking default). Otherwise the match is
 * **exact** — unlike {@link isClientAllowed}'s User-Agent substring match, a
 * `client_id` is a precise, high-entropy identifier (`oh_<hex>`), so a substring
 * test would wrongly admit `oh_ab` for an allowlist entry `oh_a`. `undefined`
 * (a verified JWT that somehow carries no string `client_id`) is a miss while the
 * gate is active.
 */
export function isClientIdAllowed(clientId: string | undefined, allowedClients: string[]): boolean {
	if (allowedClients.length === 0 || allowedClients.includes("*")) return true;
	return typeof clientId === "string" && clientId !== "" && allowedClients.includes(clientId);
}

/**
 * OAuth (JWT) verification config for {@link createAuthMiddleware} (spec 20d).
 * When supplied, the middleware accepts an AS-issued HS256 JWT in addition to the
 * opaque token. All three values are resolved at boot (`main.ts`): the
 * `jwtSecret` is the single source `OAUTH_JWT_SECRET` env or the persisted/minted
 * one (`resolveJwtSecret`), and `issuer`/`audience` are derived from the server
 * base URL (`oauthIssuerAudience`) — the same source the `/oauth/token` grant
 * signs with, so a grant-issued JWT verifies here. Omit this to keep the gate
 * opaque-only (the default; non-breaking for every existing caller).
 */
export interface OauthMiddlewareOptions {
	/** HS256 signing/verifying secret — `OAUTH_JWT_SECRET` env or the persisted/minted one. */
	jwtSecret: string;
	/** AS issuer (the server base URL) — must match the JWT `iss`. */
	issuer: string;
	/** MCP resource audience (`${baseUrl}/mcp`) — must match the JWT `aud`. */
	audience: string;
}

/**
 * Build the auth `preHandler` for a given opaque token, an optional client
 * allowlist, and an optional OAuth (JWT) config. The expected opaque token is
 * encoded to a Buffer once (at build time) and reused across requests.
 * `allowedClients` defaults to `[]` (any client) — pass a non-empty,
 * non-`["*"]` list to enable the secondary client filter (User-Agent for opaque
 * tokens, `client_id` for JWTs). `oauth` defaults to `undefined` (opaque-only) —
 * pass it to enable the JWT path (spec 20d).
 */
export function createAuthMiddleware(
	token: string,
	config: Config,
	allowedClients: string[] = [],
	oauth?: OauthMiddlewareOptions,
): preHandlerHookHandler {
	const expected = Buffer.from(token);
	// `async` is load-bearing: a synchronous arity-2 hook that returns void makes
	// Fastify wait for a never-called `done()` and the request hangs. Returning a
	// Promise (async) is how Fastify advances the lifecycle.
	return async (request, reply) => {
		const presented = parseBearer(request.headers.authorization);

		// 1. Opaque token (spec 11) — constant-time compare against the minted token.
		// The real v1 gate; an opaque token carries no client identity, so the
		// allowlist filters on the User-Agent (17r).
		if (presented !== undefined && constantTimeEquals(presented, expected)) {
			if (!isClientAllowed(request.headers["user-agent"], allowedClients)) {
				reply.code(403).send(FORBIDDEN_UA_BODY);
				return;
			}
			return;
		}

		// 2. AS-issued JWT (spec 20d) — only when OAuth is configured. An OAuth-only
		//    client presents the access_token it got from /oauth/token; verify it
		//    statelessly. On success the allowlist applies to the JWT's client_id
		//    (an exact match — a precise id, not a User-Agent). `verifyAccessToken`
		//    returns null on any failure (bad signature / expired / wrong iss+aud /
		//    wrong alg) → fall through to the 401.
		if (presented !== undefined && oauth !== undefined) {
			const claims = await verifyAccessToken(presented, oauth.jwtSecret, oauth.issuer, oauth.audience);
			if (claims !== null) {
				const clientId = typeof claims.client_id === "string" ? claims.client_id : undefined;
				if (!isClientIdAllowed(clientId, allowedClients)) {
					reply.code(403).send(FORBIDDEN_CLIENT_ID_BODY);
					return;
				}
				return;
			}
		}

		// 3. Neither credential validated (wrong opaque, no/invalid JWT, or OAuth not
		//    configured) → 401. The credential gate always wins over the allowlist:
		//    a wrong token + disallowed client is 401, not 403.
		const baseUrl = resolveBaseUrl(request, config);
		reply
			.code(401)
			.header(
				"WWW-Authenticate",
				`Bearer realm="openhammer", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
			)
			.send(UNAUTHORIZED_BODY);
		return;
	};
}
