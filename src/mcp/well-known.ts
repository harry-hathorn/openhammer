/**
 * Protected-resource discovery (spec 11).
 *
 * Registers the unauthenticated `GET /.well-known/oauth-protected-resource`
 * pointer that MCP clients use to learn `/mcp` requires a bearer token. v1 ships
 * a minimal subset — just the `resource` URL and the single `bearer_methods`
 * value the server supports — rather than full RFC 8414/RFC 9728 metadata.
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
 * at), so the advertised `resource` points at the real `/mcp` entry point.
 */
export function registerWellKnown(fastify: FastifyInstance, baseUrl: string): void {
	fastify.get("/.well-known/oauth-protected-resource", async () => ({
		resource: `${baseUrl}/mcp`,
		bearer_methods: ["header"],
	}));
}
