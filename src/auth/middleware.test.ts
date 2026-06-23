import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { createAuthMiddleware, isClientAllowed } from "./middleware.ts";

/** A realistic opaque token of a fixed length for the compare-under-test. */
const TOKEN = "a-real-opaque-base64url-token-value";
/** The exact JSON-RPC error body the 401 path must emit. */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** The exact JSON-RPC error body the 403 path (allowedClients miss) must emit. */
const FORBIDDEN_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (User-Agent not in allowedClients)" },
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
async function buildApp(token = TOKEN, allowedClients: string[] = []): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.post("/mcp", {
		preHandler: createAuthMiddleware(token, configWith(), allowedClients),
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

describe("isClientAllowed (17r)", () => {
	it("admits any client when the list is empty (the default)", () => {
		expect(isClientAllowed(undefined, [])).toBe(true);
		expect(isClientAllowed("anything/1", [])).toBe(true);
	});

	it('admits any client when the list is ["*"]', () => {
		expect(isClientAllowed("anything/1", ["*"])).toBe(true);
		expect(isClientAllowed(undefined, ["*"])).toBe(true);
	});

	it("admits a client whose User-Agent contains an allowed name (case-insensitive)", () => {
		expect(isClientAllowed("claude-code/1.0.6", ["claude-code"])).toBe(true);
		expect(isClientAllowed("Claude-Code/1.0.6", ["claude-code"])).toBe(true);
		expect(isClientAllowed("Mozilla/5.0 mcp-inspector/0.10", ["mcp-inspector"])).toBe(true);
	});

	it("admits when any one of several allowed names matches", () => {
		expect(isClientAllowed("evil/9", ["claude-code", "evil"])).toBe(true);
	});

	it("denies a client whose User-Agent matches no allowed name", () => {
		expect(isClientAllowed("evil-client/9", ["claude-code"])).toBe(false);
	});

	it("denies a missing/blank User-Agent while the gate is active (an unknown client)", () => {
		expect(isClientAllowed(undefined, ["claude-code"])).toBe(false);
		expect(isClientAllowed("", ["claude-code"])).toBe(false);
		expect(isClientAllowed("   ", ["claude-code"])).toBe(false);
	});
});

describe("createAuthMiddleware — allowedClients gate (17r)", () => {
	it("admits an allowed client (correct token + matching User-Agent)", async () => {
		const app = await buildApp(TOKEN, ["claude-code"]);
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "claude-code/1.0.6" },
		});

		expect(res.statusCode).toBe(200);
		expect(res.body).toBe("ok");
		await app.close();
	});

	it("denies a disallowed client with 403 even with a correct token", async () => {
		const app = await buildApp(TOKEN, ["claude-code"]);
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "evil-client/9" },
		});

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.body)).toEqual(FORBIDDEN_BODY);
		await app.close();
	});

	it("denies a request with no User-Agent while the gate is active (403)", async () => {
		const app = await buildApp(TOKEN, ["claude-code"]);
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN}` },
		});

		expect(res.statusCode).toBe(403);
		await app.close();
	});

	it("still returns 401 (not 403) when the token is wrong, regardless of User-Agent", async () => {
		const app = await buildApp(TOKEN, ["claude-code"]);
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: "Bearer wrong-token-value-here", "user-agent": "evil-client/9" },
		});

		expect(res.statusCode).toBe(401);
		await app.close();
	});

	it('treats a ["*"] allowlist as any client (non-breaking)', async () => {
		const app = await buildApp(TOKEN, ["*"]);
		const res = await app.inject({
			method: "POST",
			url: "/mcp",
			headers: { authorization: `Bearer ${TOKEN}`, "user-agent": "anything/1" },
		});

		expect(res.statusCode).toBe(200);
		await app.close();
	});
});
