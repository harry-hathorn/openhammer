/**
 * Stateless Streamable-HTTP transport mounted at `/mcp` behind bearer auth
 * (spec 12b). The auth `preHandler` is attached to the **POST `/mcp` route
 * only**, so `/health` and `/.well-known/*` stay open (discovery precedes auth).
 * Each request builds a fresh `createMcpServer(config.rootDir,
 * config.maxResponseBytes)`.
 *
 * **Per-request `Server` + `Transport`, no `sessionIdGenerator`** (stateless,
 * the SDK's "stateless mode"): every POST builds a fresh
 * pair, so clients never share state and the process holds no session table.
 *
 * The header-flush loop is load-bearing: the SDK writes directly to `reply.raw`,
 * bypassing Fastify's reply phase — without flushing Fastify's accumulated
 * headers (CORS `Access-Control-Allow-Origin` / `expose-headers`, …) onto the raw
 * response first, browsers strip them with a "CORS Missing Allow Origin" error
 * even though the request succeeded. Then `reply.hijack()` tells Fastify the
 * handler owns the raw response (no auto-send).
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { FastifyInstance } from "fastify";
import { createAuthMiddleware, type OauthMiddlewareOptions } from "../auth/middleware.ts";
import type { Config } from "../config.ts";
import { createMcpServer } from "./server.ts";
import { attachRequestRecorder, type RequestRecorder } from "./telemetry.ts";

/** Options threaded in from `buildFastify` (spec 12c) — the token + resolved config + optional client allowlist (17r) + optional recorder (17s) + optional OAuth/JWT config (20d). */
export interface McpHttpRoutesOptions {
	token: string;
	config: Config;
	/** The `allowedClients` allowlist — `[]`/`["*"]` (default) = any client; else a User-Agent (`opaque`) / `client_id` (`JWT`) filter (17r/20d). */
	allowedClients?: string[];
	/** When set, each `POST /mcp` is recorded into the ring buffer for `openhammer monitor` (spec 17s). */
	recorder?: RequestRecorder;
	/** When set, the auth gate also accepts an AS-issued HS256 JWT (spec 20d); omit for opaque-only. */
	oauth?: OauthMiddlewareOptions;
}

/**
 * Register the `/mcp` Streamable-HTTP routes on `fastify`. Usable two ways: call
 * directly (`await mcpHttpRoutes(fastify, { token, config })`) or register as a
 * Fastify plugin (`fastify.register(mcpHttpRoutes, { token, config })`) — both
 * pass the options as the 2nd arg. Either keeps the routes on the parent scope.
 */
export async function mcpHttpRoutes(fastify: FastifyInstance, opts: McpHttpRoutesOptions): Promise<void> {
	const { token, config, allowedClients = [], recorder, oauth } = opts;

	// Live activity capture (17s): the `onRequest` hook records each `POST /mcp`.
	// No-op per request when no recorder is wired (the default — existing tests).
	if (recorder !== undefined) {
		attachRequestRecorder(fastify, recorder);
	}

	// Auth on POST only — discovery (`/.well-known/*`) and `/health` stay open.
	fastify.post("/mcp", {
		preHandler: createAuthMiddleware(token, config, allowedClients, oauth),
		handler: async (req, reply) => {
			// Per-request server + transport — stateless, isolates clients.
			const server = createMcpServer(config.rootDir, config.maxResponseBytes);
			// Stateless mode: omit `sessionIdGenerator` (per SDK docs).
			const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

			// Best-effort teardown when the raw response closes. Each promise is
			// caught individually (the repo's established idiom, e.g. `server.test.ts`)
			// rather than an empty `try/catch` — AGENTS.md forbids empty catch blocks.
			reply.raw.once("close", () => {
				void transport.close().catch(() => {});
				void server.close().catch(() => {});
			});

			// SDK optional-callback type friction — cast through `Transport` (the one
			// documented `as` exception, per AGENTS.md).
			await server.connect(transport as unknown as Transport);

			// Flush Fastify's accumulated headers (CORS, etc.) onto the raw response
			// before handing control to the SDK — see module header for why.
			for (const [name, value] of Object.entries(reply.getHeaders())) {
				if (value !== undefined && !reply.raw.headersSent) {
					reply.raw.setHeader(name, value);
				}
			}

			await transport.handleRequest(req.raw, reply.raw, req.body);
			return reply.hijack();
		},
	});

	fastify.get("/mcp", async (_req, reply) =>
		reply.code(405).send({
			jsonrpc: "2.0",
			error: { code: -32000, message: "Method not allowed." },
			id: null,
		}),
	);

	fastify.delete("/mcp", async (_req, reply) => reply.code(405).send());
}
