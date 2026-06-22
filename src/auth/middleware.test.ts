import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createAuthMiddleware } from "./middleware.ts";

/** A realistic opaque token of a fixed length for the compare-under-test. */
const TOKEN = "a-real-opaque-base64url-token-value";
/** The exact JSON-RPC error body the 401 path must emit. */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** Minimal `Config` — only `host`/`port` are read (the baseUrl fallback). */
function configWith(): Config {
	return {
		port: 3000,
		host: "127.0.0.1",
		rootDir: "/tmp",
		authToken: undefined,
		maxResponseBytes: 512_000,
		logLevel: "info",
	};
}

/** Minimal Fastify: a single POST route guarded by the auth preHandler. */
async function buildApp(token = TOKEN): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.post("/mcp", {
		preHandler: createAuthMiddleware(token, configWith()),
		handler: async () => "ok",
	});
	await app.ready();
	return app;
}

describe("createAuthMiddleware", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await buildApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it("rejects a request with no Authorization header (401 + WWW-Authenticate + JSON-RPC body)", async () => {
		const res = await app.inject({ method: "POST", url: "/mcp" });

		expect(res.statusCode).toBe(401);
		expect(String(res.headers["www-authenticate"])).toMatch(/^Bearer realm="openhammer"/);
		expect(String(res.headers["www-authenticate"])).toContain("/.well-known/oauth-protected-resource");
		expect(JSON.parse(res.body)).toEqual(UNAUTHORIZED_BODY);
	});

	it("rejects a wrong token of the same length with 401", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN.replace(/^a/, "z")}` },
		});

		expect(res.statusCode).toBe(401);
	});

	it("rejects a wrong token of a different length with 401 (no length-leak throw / 500)", async () => {
		// timingSafeEqual throws RangeError on unequal lengths; the middleware must
		// short-circuit before comparing, so this stays a clean 401 — never a 500.
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: "Bearer xx" },
		});

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual(UNAUTHORIZED_BODY);
	});

	it("admits a request bearing the correct token", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN}` },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toBe("ok");
	});

	it("accepts a case-insensitive Bearer scheme", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `bearer ${TOKEN}` },
		});

		expect(res.statusCode).toBe(200);
	});

	it("derives the WWW-Authenticate base URL from the request Host header", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { host: "tunnel.example:9999" },
		});

		expect(String(res.headers["www-authenticate"])).toContain(
			'resource_metadata="http://tunnel.example:9999/.well-known/oauth-protected-resource"',
		);
	});
});
