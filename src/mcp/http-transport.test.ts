/**
 * Integration tests for `mcpHttpRoutes` (spec 12b). Drives the real Streamable
 * HTTP wiring end-to-end: a real SDK `Client` connects over HTTP to a listening
 * Fastify on port 0 and runs `tools/list`, proving the per-request `Server` +
 * `StreamableHTTPServerTransport` plumbing, header flush, and `reply.hijack()`
 * all compose. The auth gate (401 on POST without a bearer) and the GET/DELETE
 * 405s are asserted via `inject` against the same app.
 *
 * This is the focused integration view for 12b (tools/list + gate + 405s); the
 * full Tier-1 suite that drives all 7 tools + the backstop over `POST /mcp`
 * lands separately in `test/e2e-hermetic/mcp.e2e.test.ts` (task T-mcp-e2e).
 */
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "../config.ts";
import { mcpHttpRoutes } from "./http-transport.ts";

const TOKEN = "a-real-opaque-base64url-token-value";
const TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `Config` — only `rootDir`/`maxResponseBytes` reach the transport. */
function configWith(rootDir: string): Config {
	return {
		port: 0,
		host: "127.0.0.1",
		rootDir,
		authToken: undefined,
		maxResponseBytes: 512_000,
		logLevel: "info",
	};
}

/** Minimal Fastify with the `/mcp` routes registered directly (no CORS — orthogonal here). */
async function buildApp(rootDir: string): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	await mcpHttpRoutes(app, { token: TOKEN, config: configWith(rootDir) });
	return app;
}

describe("mcpHttpRoutes", () => {
	let app: FastifyInstance;
	let baseUrl: string;
	let rootDir: string;

	beforeEach(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-http-"));
		app = await buildApp(rootDir);
		// Real listen on an ephemeral port — the SDK client uses its own fetch, so
		// `inject` can't satisfy it; it needs a genuine HTTP endpoint.
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address() as AddressInfo;
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterEach(async () => {
		await app.close();
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("POST /mcp without a bearer returns 401 (auth preHandler wired to POST only)", async () => {
		const res = await app.inject({ method: "POST", url: "/mcp" });

		expect(res.statusCode).toBe(401);
		expect(String(res.headers["www-authenticate"])).toMatch(/^Bearer realm="openhammer"/);
	});

	it("GET /mcp returns 405 with a JSON-RPC error body", async () => {
		const res = await app.inject({ method: "GET", url: "/mcp" });

		expect(res.statusCode).toBe(405);
		expect(JSON.parse(res.body)).toEqual({
			jsonrpc: "2.0",
			error: { code: -32000, message: "Method not allowed." },
			id: null,
		});
	});

	it("DELETE /mcp returns 405", async () => {
		const res = await app.inject({ method: "DELETE", url: "/mcp" });

		expect(res.statusCode).toBe(405);
	});

	it("a real SDK client runs tools/list over POST /mcp and sees all 7 tools", async () => {
		const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
		// The bearer rides on every request via `requestInit` headers — no
		// `authProvider`, so the SDK never tries the OAuth discovery flow.
		const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
			requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
		});
		await client.connect(transport);
		try {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
		} finally {
			await client.close().catch(() => {});
		}
	});
});
