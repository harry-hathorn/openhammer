import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config.ts";
import { createAuthMiddleware, isClientAllowed, isClientIdAllowed, type OauthMiddlewareOptions } from "./middleware.ts";
import { signAccessToken } from "./oauth/jwt.ts";

/** A realistic opaque token of a fixed length for the compare-under-test. */
const TOKEN = "a-real-opaque-base64url-token-value";
/** The exact JSON-RPC error body the 401 path must emit. */
const UNAUTHORIZED_BODY = {
	jsonrpc: "2.0",
	error: { code: -32001, message: "Unauthorized" },
	id: null,
};

/** The exact JSON-RPC error body the 403 path (User-Agent allowedClients miss) must emit. */
const FORBIDDEN_UA_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (User-Agent not in allowedClients)" },
	id: null,
};

/** The exact JSON-RPC error body the 403 path (JWT client_id allowedClients miss) must emit. */
const FORBIDDEN_CLIENT_ID_BODY = {
	jsonrpc: "2.0",
	error: { code: -32002, message: "Forbidden: client not permitted (client_id not in allowedClients)" },
	id: null,
};

// --- JWT path fixtures (spec 20d) -------------------------------------------
/** A long-enough HS256 secret for `jose` (mirrors `jwt.test.ts`). */
const JWT_SECRET = "a-very-long-test-hs256-secret-key-0123456789";
const ISSUER = "http://127.0.0.1:3000";
const AUDIENCE = "http://127.0.0.1:3000/mcp";
const CLIENT_ID = "oh_abc123def456";

/** The OAuth verify config the middleware receives — matches what `/oauth/token` signs with. */
const OAUTH: OauthMiddlewareOptions = { jwtSecret: JWT_SECRET, issuer: ISSUER, audience: AUDIENCE };

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
async function buildApp(
	token = TOKEN,
	allowedClients: string[] = [],
	oauth?: OauthMiddlewareOptions,
): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	app.post("/mcp", {
		preHandler: createAuthMiddleware(token, configWith(), allowedClients, oauth),
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
		expect(JSON.parse(res.body)).toEqual(FORBIDDEN_UA_BODY);
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

describe("isClientIdAllowed (20d)", () => {
	it("admits any client when the list is empty (the default)", () => {
		expect(isClientIdAllowed(undefined, [])).toBe(true);
		expect(isClientIdAllowed("oh_anything", [])).toBe(true);
	});

	it('admits any client when the list is ["*"]', () => {
		expect(isClientIdAllowed("oh_anything", ["*"])).toBe(true);
		expect(isClientIdAllowed(undefined, ["*"])).toBe(true);
	});

	it("admits a client_id that is exactly in the list", () => {
		expect(isClientIdAllowed("oh_abc123", ["oh_abc123"])).toBe(true);
		expect(isClientIdAllowed("oh_abc123", ["oh_other", "oh_abc123"])).toBe(true);
	});

	it("denies a client_id that is not in the list", () => {
		expect(isClientIdAllowed("oh_abc123", ["oh_other"])).toBe(false);
	});

	it("does NOT substring-match (a client_id is a precise id)", () => {
		// `oh_ab` must not admit `oh_abc` — the whole point of exact match for an id.
		expect(isClientIdAllowed("oh_abc123", ["oh_ab"])).toBe(false);
		expect(isClientIdAllowed("oh_abc", ["oh_abc123"])).toBe(false);
	});

	it("denies a missing/blank client_id while the gate is active", () => {
		expect(isClientIdAllowed(undefined, ["oh_abc123"])).toBe(false);
		expect(isClientIdAllowed("", ["oh_abc123"])).toBe(false);
	});
});

describe("createAuthMiddleware — JWT path (20d)", () => {
	/** Sign a JWT for the configured OAuth options with an optional client_id override. */
	async function signJwt(clientId: string = CLIENT_ID, secret: string = JWT_SECRET): Promise<string> {
		return signAccessToken({ iss: ISSUER, aud: AUDIENCE, sub: clientId, client_id: clientId }, secret, 3600);
	}

	/** Flip the first char of the signature segment to invalidate the signature.
	 * All 6 bits of the first base64url char map to the first signature byte, so
	 * this ALWAYS changes the decoded signature. (Flipping the last char is flaky:
	 * its trailing bits are unused, so ~6% of tokens decode byte-identical and jose
	 * still verifies — the 20f `jwt.test.ts` precedent, fixed the same way here.) */
	function tamper(jwt: string): string {
		const sigStart = jwt.lastIndexOf(".") + 1; // first char of the signature segment
		const chars = [...jwt];
		chars[sigStart] = chars[sigStart] === "A" ? "B" : "A";
		return chars.join("");
	}

	it("admits a valid AS-issued JWT (any client by default)", async () => {
		const app = await buildApp(TOKEN, [], OAUTH);
		const jwt = await signJwt();
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(200);
		expect(res.body).toBe("ok");
		await app.close();
	});

	it("still admits a correct opaque token when OAuth is configured (both paths coexist)", async () => {
		const app = await buildApp(TOKEN, [], OAUTH);
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${TOKEN}` } });

		expect(res.statusCode).toBe(200);
		await app.close();
	});

	it("rejects a tampered JWT with 401", async () => {
		const app = await buildApp(TOKEN, [], OAUTH);
		const jwt = tamper(await signJwt());
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(401);
		expect(JSON.parse(res.body)).toEqual(UNAUTHORIZED_BODY);
		await app.close();
	});

	it("rejects a JWT signed with the wrong secret with 401", async () => {
		const app = await buildApp(TOKEN, [], OAUTH);
		const jwt = await signJwt(CLIENT_ID, "a-different-wrong-secret-key-xxxxxxxxxx");
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(401);
		await app.close();
	});

	it("rejects a JWT with the wrong audience with 401", async () => {
		const app = await buildApp(TOKEN, [], OAUTH);
		const jwt = await signAccessToken(
			{ iss: ISSUER, aud: "https://other.test/mcp", sub: CLIENT_ID, client_id: CLIENT_ID },
			JWT_SECRET,
			3600,
		);
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(401);
		await app.close();
	});

	it("rejects an expired JWT with 401", async () => {
		// Freeze the clock at signing, then jump 1s past `exp` so jose's `exp` check
		// fails deterministically (mirrors `jwt.test.ts` — no real sleep).
		vi.useFakeTimers();
		const signAt = new Date("2025-01-01T00:00:00Z");
		vi.setSystemTime(signAt);
		const jwt = await signJwt(); // exp = 01:00:00
		vi.setSystemTime(new Date("2025-01-01T01:00:01Z")); // 1s past exp
		try {
			const app = await buildApp(TOKEN, [], OAUTH);
			const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

			expect(res.statusCode).toBe(401);
			await app.close();
		} finally {
			vi.useRealTimers();
		}
	});

	it("denies a valid JWT whose client_id is not in allowedClients with 403", async () => {
		const app = await buildApp(TOKEN, ["oh_allowed"], OAUTH);
		const jwt = await signJwt("oh_denied");
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(403);
		expect(JSON.parse(res.body)).toEqual(FORBIDDEN_CLIENT_ID_BODY);
		await app.close();
	});

	it("admits a valid JWT whose client_id is in allowedClients", async () => {
		const app = await buildApp(TOKEN, ["oh_allowed"], OAUTH);
		const jwt = await signJwt("oh_allowed");
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(200);
		await app.close();
	});

	it('treats a ["*"] allowlist as any client for JWTs (non-breaking)', async () => {
		const app = await buildApp(TOKEN, ["*"], OAUTH);
		const jwt = await signJwt();
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(200);
		await app.close();
	});

	it("returns 401 (not 500) for a JWT presented to an opaque-only gate (OAuth not configured)", async () => {
		// No `oauth` → the middleware never tries JWT verify; a presented JWT is just
		// a non-matching bearer → 401. Proves the path is opt-in and never throws.
		const app = await buildApp(TOKEN, []);
		const jwt = await signJwt();
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(401);
		await app.close();
	});

	it("returns 401 (not 403) for an invalid JWT + disallowed client — the credential gate wins", async () => {
		const app = await buildApp(TOKEN, ["oh_allowed"], OAUTH);
		const jwt = tamper(await signJwt("oh_denied"));
		const res = await app.inject({ method: "POST", url: "/mcp", headers: { authorization: `Bearer ${jwt}` } });

		expect(res.statusCode).toBe(401);
		await app.close();
	});
});
