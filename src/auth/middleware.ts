/**
 * Bearer-token auth preHandler (spec 11).
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
 * body, then ends the request (the route handler never runs). On success it
 * returns without replying — control flows to the handler.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { Config } from "../config.ts";

/** JSON-RPC error body sent on every auth failure. */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
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
 * Build the auth `preHandler` for a given token. The expected token is encoded
 * to a Buffer once (at build time) and reused across requests.
 */
export function createAuthMiddleware(token: string, config: Config): preHandlerHookHandler {
	const expected = Buffer.from(token);
	// `async` is load-bearing: a synchronous arity-2 hook that returns void makes
	// Fastify wait for a never-called `done()` and the request hangs. Returning a
	// Promise (async) is how Fastify advances the lifecycle (matches the-reference).
	return async (request, reply) => {
		const presented = parseBearer(request.headers.authorization);
		const ok = presented !== undefined && constantTimeEquals(presented, expected);
		if (ok) return;

		const baseUrl = resolveBaseUrl(request, config);
		reply
			.code(401)
			.header(
				"WWW-Authenticate",
				`Bearer realm="openhammer", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
			)
			.send(UNAUTHORIZED_BODY);
	};
}
