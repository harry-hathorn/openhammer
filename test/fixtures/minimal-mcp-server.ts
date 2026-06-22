/**
 * Standalone minimal MCP server fixture (spec 16). A self-contained Streamable-
 * HTTP MCP server that mirrors OpenHammer's transport shape — `@fastify/cors`,
 * open `/health`, bearer-gated stateless `POST /mcp` over
 * `StreamableHTTPServerTransport`, `GET`/`DELETE /mcp` → 405, and the universal
 * size backstop — with ONE deterministic `echo` tool. It is the stable,
 * known-good target for the Tier-1 canary (`test/e2e-hermetic/harness.canary.test.ts`)
 * and the Tier-3 compose `test-runner` (`test/compose/run-e2e.ts`).
 *
 * **Deliberately standalone — no `src/` import.** A canary exists to prove the
 * test *harness* itself (vitest's `test/e2e-hermetic/**` include, a real SDK
 * `Client` over loopback HTTP, an ephemeral port-0 listen) is wired correctly
 * against a deterministic target — NOT to re-test the production server (that is
 * `T-mcp-e2e`'s job, driving the real `buildFastify`). Keeping the fixture
 * independent means a mid-refactor `src/` cannot turn the canary red: a green
 * canary isolates "the infra works" from "the code works". It doubles as a
 * compact spec-12 reference (CORS + health + bearer + stateless transport +
 * backstop) in one readable file. The real server's auth/backstop are covered
 * independently by `src/mcp/{server,http-transport}.test.ts` + `T-mcp-e2e`.
 *
 * Exports:
 *   buildFixtureServer({ token, maxResponseBytes?, logLevel? }) — build-only, NO listen
 *   main() — standalone entrypoint (compose `fixture-server` CMD)
 */
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import fastifyCors from "@fastify/cors";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import Fastify, { type FastifyInstance, type preHandlerHookHandler } from "fastify";

export interface FixtureServerOptions {
	token: string;
	maxResponseBytes?: number;
	logLevel?: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;
const DEFAULT_LOG_LEVEL = "info";

/** JSON-RPC error body sent on every auth failure (mirrors `src/auth/middleware.ts`). */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** The single deterministic tool: echoes `{ message }` back as text. */
const ECHO_TOOL: Tool = {
	name: "echo",
	description: "Echo the provided message back as text (deterministic fixture tool).",
	inputSchema: {
		type: "object",
		properties: { message: { type: "string", description: "The text to echo back." } },
		required: ["message"],
		additionalProperties: false,
	},
};

/** Parse `Authorization: Bearer <v>` (case-insensitive scheme); else `undefined`. */
function parseBearer(header: string | string[] | undefined): string | undefined {
	if (typeof header !== "string") return undefined;
	const parts = header.trim().split(/\s+/);
	if (parts.length !== 2) return undefined;
	const [scheme, value] = parts;
	return scheme.toLowerCase() === "bearer" ? value : undefined;
}

/** Constant-time equality; a length mismatch short-circuits before `timingSafeEqual`. */
function constantTimeEquals(presented: string, expected: Buffer): boolean {
	const a = Buffer.from(presented);
	if (a.length !== expected.length) return false;
	return timingSafeEqual(a, expected);
}

/**
 * Bearer `preHandler` — on any miss/mismatch, reply 401 with a `WWW-Authenticate`
 * challenge (base URL derived per request from the `Host` header, so it stays
 * correct under an ephemeral port) + a JSON-RPC error body, mirroring
 * `src/auth/middleware.ts`. `async` is load-bearing — a sync arity-2 hook that
 * returns void makes Fastify wait for a never-called `done()` and the request hangs.
 */
function authPreHandler(token: string): preHandlerHookHandler {
	const expected = Buffer.from(token);
	return async (request, reply) => {
		const presented = parseBearer(request.headers.authorization);
		if (presented !== undefined && constantTimeEquals(presented, expected)) return;
		const host = request.headers.host;
		const baseUrl =
			typeof host === "string" && host !== "" ? `${request.protocol}://${host}` : `http://${DEFAULT_HOST}`;
		reply
			.code(401)
			.header(
				"WWW-Authenticate",
				`Bearer realm="openhammer", resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
			)
			.send(UNAUTHORIZED_BODY);
	};
}

/**
 * Build a stateless MCP `Server` with the single `echo` tool and the universal
 * size backstop (mirrors `src/mcp/server.ts`'s post-success cap: over the limit,
 * replace the whole content with one structured `response_too_large` block).
 */
function createFixtureMcpServer(maxResponseBytes: number): Server {
	const server = new Server({ name: "openhammer-fixture", version: "0.0.0" }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ECHO_TOOL] }));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { arguments: args } = request.params;
		const text = typeof args?.message === "string" ? args.message : "";

		// Universal size backstop — `echo` is text-only, so the byte sum is just
		// the message length (the real server sums text + image blocks).
		const bytes = Buffer.byteLength(text);
		if (bytes > maxResponseBytes) {
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							ok: false,
							error: "response_too_large",
							bytes,
							cap: maxResponseBytes,
							message: `The "echo" response was ${bytes} bytes, over the ${maxResponseBytes}-byte limit.`,
						}),
					},
				],
			};
		}

		return { content: [{ type: "text", text }] };
	});

	return server;
}

/**
 * Build the fixture Fastify app — CORS, open `/health`, bearer-gated stateless
 * `POST /mcp`, `GET`/`DELETE /mcp` → 405. **Build-only: does NOT call `listen`**
 * (the canary owns the ephemeral port-0 binding; `main()` owns the compose listen).
 */
export async function buildFixtureServer(options: FixtureServerOptions): Promise<FastifyInstance> {
	const { token, maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES, logLevel = DEFAULT_LOG_LEVEL } = options;

	const fastify = Fastify({ logger: { level: logLevel } });

	await fastify.register(fastifyCors, {
		origin: true,
		credentials: true,
		methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		exposedHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "WWW-Authenticate"],
	});

	// Health check — no auth (probes liveness).
	fastify.get("/health", async () => ({ status: "ok" }));

	// Bearer-gated stateless `/mcp` over Streamable HTTP — per-request Server +
	// Transport, no `sessionIdGenerator` (stateless mode). Copy-adapted from
	// `src/mcp/http-transport.ts`: the header-flush is load-bearing (the SDK writes
	// directly to `reply.raw`, so CORS expose-headers must be flushed first), and
	// `reply.hijack()` tells Fastify the handler owns the raw response.
	fastify.post("/mcp", {
		preHandler: authPreHandler(token),
		handler: async (req, reply) => {
			const server = createFixtureMcpServer(maxResponseBytes);
			const transport = new StreamableHTTPServerTransport({ enableJsonResponse: true });

			// Best-effort teardown when the raw response closes — each promise caught
			// individually (the repo idiom) rather than an empty try/catch.
			reply.raw.once("close", () => {
				void transport.close().catch(() => {});
				void server.close().catch(() => {});
			});

			// SDK optional-callback type friction — cast through `Transport` (the one
			// documented `as` exception, same as `src/mcp/http-transport.ts`).
			await server.connect(transport as unknown as Transport);

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

	return fastify;
}

/** Coerce `PORT` to a number, falling back when absent/empty/non-numeric. */
function envPort(fallback = DEFAULT_PORT): number {
	const v = process.env.PORT;
	if (v === undefined || v === "") return fallback;
	const n = Number(v);
	return Number.isNaN(n) ? fallback : n;
}

/**
 * Standalone entrypoint for the compose `fixture-server` service (T-compose):
 * read env, build, listen, log the endpoint, and shut down cleanly on
 * `SIGINT`/`SIGTERM`. Not used by the canary (which calls `buildFixtureServer`
 * + `listen` itself) — invoked directly via `tsx test/fixtures/minimal-mcp-server.ts`.
 */
export async function main(): Promise<void> {
	const port = envPort();
	const host = process.env.HOST || DEFAULT_HOST;
	const token = process.env.MCP_TOKEN || "fixture-token";
	const maxBytesRaw = process.env.MCP_MAX_RESPONSE_BYTES;
	const maxResponseBytes =
		maxBytesRaw && maxBytesRaw !== "" && !Number.isNaN(Number(maxBytesRaw))
			? Number(maxBytesRaw)
			: DEFAULT_MAX_RESPONSE_BYTES;

	const app = await buildFixtureServer({ token, maxResponseBytes });
	await app.listen({ port, host });
	app.log.info({ url: `http://${host}:${port}/mcp` }, "fixture MCP server listening");

	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals) => {
		if (shuttingDown) return;
		shuttingDown = true;
		app.log.info({ signal }, "shutting down");
		await app.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Run as a direct entry (`tsx test/fixtures/minimal-mcp-server.ts`); a no-op when
// imported by the canary — vitest's `argv[1]` is the vitest binary, not this file,
// so the guard never fires under `npm test`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	void main();
}
