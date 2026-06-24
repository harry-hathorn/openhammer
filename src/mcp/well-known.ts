/**
 * Protected-resource discovery (spec 11) + OAuth AS advertisement (spec 20c).
 *
 * Registers the unauthenticated `GET /.well-known/oauth-protected-resource`
 * pointer that MCP clients use to learn `/mcp` requires a bearer token. v1 ships
 * a minimal subset — the `resource` URL and the single `bearer_methods` value the
 * server supports — rather than full RFC 9728 metadata.
 *
 * Spec 20c extends the body to point at the OAuth Authorization Server
 * (`authorization_servers`) so an OAuth-only client — one that cannot set a raw
 * `Authorization: Bearer` header — discovers the AS, exchanges its client
 * credentials at `/oauth/token`, and connects. The full RFC 8414 AS metadata
 * lives at `/.well-known/oauth-authorization-server` (registered by
 * `src/auth/oauth/token.ts`); this pointer just names the issuer.
 *
 * The route is intentionally unguarded: discovery must precede auth, otherwise a
 * client has no way to obtain the challenge. (In `src/server.ts` the auth
 * `preHandler` is attached to `POST /mcp` only, so this route is never behind
 * it.) `baseUrl` is threaded in rather than re-derived per request so the
 * advertised `resource` stays correct under the tunnel.
 */
import type { FastifyInstance } from "fastify";

/**
 * Register `GET /.well-known/oauth-protected-resource` on `fastify`. The body is
 * derived from `baseUrl` (the `protocol://host[:port]` the server is reachable
 * at), so the advertised `resource` points at the real `/mcp` entry point. The
 * `authorization_servers` array names the AS issuer (its base URL) so an
 * OAuth-only client can find the token endpoint via RFC 8414.
 *
 * **Field name note:** this stays `bearer_methods` (not RFC 9728's
 * `bearer_methods_supported`) — the deliberate v1 "minimal subset" decision from
 * 11c. `authorization_servers` + `scopes_supported` are added per spec 20c.
 */
export function registerWellKnown(fastify: FastifyInstance, baseUrl: string): void {
	fastify.get("/.well-known/oauth-protected-resource", async () => ({
		resource: `${baseUrl}/mcp`,
		authorization_servers: [baseUrl],
		bearer_methods: ["header"],
		scopes_supported: [],
	}));
}
