/**
 * Integration tests for `buildFastify` (spec 12c). Builds the real app and
 * listens on an ephemeral port to prove the wiring: the returned instance is
 * bindable by the caller (NOT pre-bound), `/health` is open without auth, CORS
 * exposes the headers the Streamable HTTP transport needs, and unmatched routes
 * hit the global 404 handler. Does NOT drive `/mcp` here — that is covered
 * end-to-end by `mcpHttpRoutes` (12b) + the Tier-1 suite (T-mcp-e2e).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Config } from "./config.ts";
import { buildFastify } from "./server.ts";

const TOKEN = "test-opaque-bearer-token-for-buildfastify";

/** Minimal `Config`; `logLevel:"silent"` keeps the test output quiet. */
function makeConfig(rootDir: string): Config {
	return {
		port: 0,
		host: "127.0.0.1",
		rootDir,
		authToken: undefined,
		publicUrl: undefined,
		maxResponseBytes: 512_000,
		logLevel: "silent",
	};
}

describe("buildFastify", () => {
	let app: FastifyInstance;
	let rootDir: string;

	beforeEach(async () => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-server-"));
		app = await buildFastify(makeConfig(rootDir), TOKEN);
		// Real listen on an ephemeral port — proves the returned instance is
		// bindable by the caller (main.ts / Tier-1 E2E), i.e. buildFastify did
		// NOT listen itself. (A second listen would throw "already listening".)
		await app.listen({ port: 0, host: "127.0.0.1" });
	});

	afterEach(async () => {
		await app.close();
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("GET /health returns 200 {status:'ok'} without auth", async () => {
		const res = await app.inject({ method: "GET", url: "/health" });

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({ status: "ok" });
	});

	it("CORS exposes the headers the Streamable HTTP transport needs", async () => {
		const res = await app.inject({
			method: "GET",
			url: "/health",
			// Origin present → a CORS response, so expose-headers is attached.
			headers: { origin: "http://example.com" },
		});

		const expose = String(res.headers["access-control-expose-headers"]);
		expect(expose).toContain("Mcp-Session-Id");
		expect(expose).toContain("Mcp-Protocol-Version");
		expect(expose).toContain("WWW-Authenticate");
		expect(res.headers["access-control-allow-origin"]).toBe("http://example.com");
	});

	it("unmatched routes hit the global 404 handler", async () => {
		const res = await app.inject({ method: "GET", url: "/nope" });

		expect(res.statusCode).toBe(404);
		expect(JSON.parse(res.body)).toEqual({
			error: "Not Found",
			message: "Route GET /nope not found",
			statusCode: 404,
		});
	});
});
