/**
 * Fastify app factory (spec 12c). `@fastify/cors` (open, for browser MCP
 * clients), `GET /health`, the protected-resource discovery pointer, and the
 * `/mcp` Streamable-HTTP routes — plus global error + 404 handlers.
 *
 * **Returns the instance WITHOUT calling `listen`.** Binding + lifecycle (the
 * listen port, `SIGINT`/`SIGTERM` shutdown) is owned by `main.ts` (spec 14).
 * This split is required for testing (spec 15): the Tier-1 in-process E2E binds
 * ephemeral port 0 itself and the Tier-2 boot E2E controls shutdown. Behavior
 * for `main.ts` is unchanged — it just calls `listen` on the returned instance.
 */
import fastifyCors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";

import type { OauthMiddlewareOptions } from "./auth/middleware.ts";
import { registerOauthRoutes } from "./auth/oauth/token.ts";
import type { Config } from "./config.ts";
import { mcpHttpRoutes } from "./mcp/http-transport.ts";
import type { RequestRecorder } from "./mcp/telemetry.ts";
import { registerWellKnown } from "./mcp/well-known.ts";

/**
 * Build the OpenHammer Fastify app: CORS, `/health`, well-known discovery, the
 * `/mcp` transport, and global error/404 handlers. Does not listen — the caller
 * owns binding + lifecycle (see module header).
 *
 * `oauth` (spec 20d), when supplied, enables the JWT acceptance path in the
 * `/mcp` auth gate (resolved at boot by `main.ts`); omit it for opaque-only.
 */
export async function buildFastify(
	config: Config,
	token: string,
	allowedClients: string[] = [],
	recorder?: RequestRecorder,
	oauth?: OauthMiddlewareOptions,
): Promise<FastifyInstance> {
	// pino-pretty only in development (`NODE_ENV=development`) — production gets
	// raw JSON for structured log shipping; tests run with `NODE_ENV=test`, so
	// they take the plain branch and never spawn a pretty-print worker thread.
	const fastify = Fastify({
		logger:
			process.env.NODE_ENV === "development"
				? {
						level: config.logLevel,
						transport: {
							target: "pino-pretty",
							options: { colorize: true, translateTime: "HH:MM:ss Z", ignore: "pid,hostname" },
						},
					}
				: { level: config.logLevel },
	});

	// Open CORS — MCP clients (Inspector, third-party browser UIs) hit /mcp from
	// origins we can't enumerate; `origin:true` reflects the request Origin
	// (which is required when combining with credentials). Bearer tokens aren't
	// browser-auto-attached, so a permissive policy opens no CSRF surface — an
	// attacker site still can't read the token held on another origin.
	// `exposedHeaders` lists the headers the Streamable HTTP transport + the
	// discovery flow need browsers to *read*; without them, JS can't see them
	// even when the request itself succeeds.
	await fastify.register(fastifyCors, {
		origin: true,
		credentials: true,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		exposedHeaders: [
			"Mcp-Session-Id",
			"Mcp-Protocol-Version",
			"WWW-Authenticate",
			"Deprecation",
			"Sunset",
			"Warning",
			"Link",
		],
	});

	// Health check — no auth. Probes liveness (app is up + routes registered).
	fastify.get("/health", async () => ({ status: "ok" }));

	// Protected-resource discovery — unauthenticated (must precede auth). The
	// advertised `resource` uses the configured host:port (build-time `baseUrl`);
	// the per-request `Host` is used only for the auth `WWW-Authenticate`
	// challenge (spec 11), so the two are intentionally separate.
	const baseUrl = `http://${config.host}:${config.port}`;
	registerWellKnown(fastify, baseUrl);

	// The OAuth Authorization Server (spec 20c): RFC 8414 metadata + the
	// `POST /oauth/token` client-credentials grant + formbody for form posts.
	// Unauthenticated — token issuance is the auth, and discovery precedes it.
	await registerOauthRoutes(fastify, { baseUrl });

	// The `/mcp` Streamable-HTTP routes — POST is gated by the bearer preHandler
	// wired inside `mcpHttpRoutes`. Called directly (it is an async arity-2
	// function shaped for this) so the routes land on the parent scope alongside
	// `/health` + well-known, with no plugin wrapper or `fastify-plugin` dep.
	await mcpHttpRoutes(fastify, { token, config, allowedClients, recorder, oauth });

	// Global error handler — preserves Fastify's `statusCode` (e.g. 400 on a
	// malformed JSON body) and otherwise 500s. The `/mcp` POST handler calls
	// `reply.hijack()`, so its own errors bypass this; it catches everything
	// else. `errorInput` is `Error` by default — `statusCode` is narrowed
	// honestly via the `in` guard (no `as`), matching the repo convention.
	fastify.setErrorHandler((errorInput, request, reply) => {
		const statusCode =
			"statusCode" in errorInput && typeof errorInput.statusCode === "number" ? errorInput.statusCode : 500;
		fastify.log.error({
			error: errorInput.message,
			stack: errorInput.stack,
			url: request.url,
			method: request.method,
		});
		reply.status(statusCode).send({
			error: errorInput.name,
			message: errorInput.message,
			statusCode,
		});
	});

	// 404 handler — any unmatched route.
	fastify.setNotFoundHandler((request, reply) => {
		reply.code(404).send({
			error: "Not Found",
			message: `Route ${request.method} ${request.url} not found`,
			statusCode: 404,
		});
	});

	return fastify;
}
