/**
 * Bearer-token auth preHandler (spec 11) + opt-in client allowlist (spec 17r).
 *
 * Gates `/mcp` with the per-instance opaque token minted by `ensureToken`. The
 * presented token is encoded to a Buffer and compared to the expected one in
 * constant time (`crypto.timingSafeEqual`); a length mismatch short-circuits
 * *without* comparing — `timingSafeEqual` throws `RangeError` on unequal
 * lengths, so the guard is load-bearing (and leaking the expected token's
 * length is acceptable).
 *
 * On any miss/mismatch the hook replies 401 with a `WWW-Authenticate` challenge
 * pointing at the protected-resource discovery document and a JSON-RPC error
 * body, then ends the request (the route handler never runs).
 *
 * Client allowlist (17r): the bearer token is the **real** gate. When a
 * non-empty, non-`["*"]` `allowedClients` is supplied, the hook *additionally*
 * checks the inbound `User-Agent` against that list and replies `403` on a miss
 * — authenticated, but not a permitted client type. This is a secondary,
 * best-effort filter: OpenHammer is stateless, so `initialize`'s `clientInfo`
 * is not retained for a later `tools/call`, and `User-Agent` is the only
 * per-request identity signal (true `clientInfo`-based enforcement needs
 * sessions, deferred spec 18). A token-holder can spoof the header, so this only
 * narrows honest clients — acceptable for a secondary filter. Default `[]` /
 * `["*"]` = any client → non-breaking.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Config } from "../config.ts";

/** JSON-RPC error body sent on every auth failure (401). */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** JSON-RPC error body sent when a token-bearing client fails the allowlist (403). */
const FORBIDDEN_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (User-Agent not in allowedClients)" },
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
 * Build the auth `preHandler` for a given token and (optional) client allowlist.
 * The expected token is encoded to a Buffer once (at build time) and reused
 * across requests. `allowedClients` defaults to `[]` (any client) — pass a
 * non-empty, non-`["*"]` list to enable the secondary `User-Agent` filter (17r).
 */
export function createAuthMiddleware(
	token: string,
	config: Config,
	allowedClients: string[] = [],
): preHandlerHookHandler {
	const expected = Buffer.from(token);
	// `async` is load-bearing: a synchronous arity-2 hook that returns void makes
	// Fastify wait for a never-called `done()` and the request hangs. Returning a
	// Promise (async) is how Fastify advances the lifecycle.
	return async (request, reply) => {
		const presented = parseBearer(request.headers.authorization);
		const tokenOk = presented !== undefined && constantTimeEquals(presented, expected);
		if (!tokenOk) {
			const baseUrl = resolveBaseUrl(request, config);
			reply
				.code(401)
				.header(
					"WWW-Authenticate",
					`Bearer realm="openhammer", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
				)
				.send(UNAUTHORIZED_BODY);
			return;
		}

		// The real gate passed. Apply the secondary client-type filter (17r): a
		// non-empty, non-`["*"]` allowlist narrows which clients may call, best-effort
		// on the inbound User-Agent. A miss is `403` (forbidden: authenticated but not
		// permitted) — the request never reaches the handler.
		if (!isClientAllowed(request.headers["user-agent"], allowedClients)) {
			reply.code(403).send(FORBIDDEN_BODY);
			return;
		}
	};
}
