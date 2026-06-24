import { afterEach, describe, expect, it, vi } from "vitest";
import { type AccessTokenClaims, signAccessToken, verifyAccessToken } from "./jwt.ts";

const SECRET = "a-very-long-test-hs256-secret-key-0123456789";
const ISSUER = "https://openhammer.test";
const AUDIENCE = "https://openhammer.test/mcp";

const claims: AccessTokenClaims = {
	iss: ISSUER,
	aud: AUDIENCE,
	sub: "oh_abc123",
	client_id: "oh_abc123",
};

/** Compact-JWT segments: [header, payload, signature] — all base64url. */
function segments(jwt: string): string[] {
	return jwt.split(".");
}

/** Flip the first character of the signature segment to invalidate the signature.
 * The first char — **not** the last — so every flipped bit is a real signature bit: the
 * final base64url char of a 32-byte signature carries 2 unused trailing bits, so
 * flipping the last char can leave the decoded signature unchanged (a flaky pass). */
function tamperSignature(jwt: string): string {
	const [header, payload, signature] = segments(jwt);
	if (signature === undefined) throw new Error("not a compact JWT");
	const chars = [...signature];
	chars[0] = chars[0] === "A" ? "B" : "A";
	return [header, payload, chars.join("")].join(".");
}

describe("signAccessToken + verifyAccessToken round-trip", () => {
	it("signs an HS256 token that verifies back to the claims (iss/aud/sub/client_id + iat/exp)", async () => {
		const token = await signAccessToken(claims, SECRET, 3600);

		// Compact JWS shape: three base64url segments.
		expect(segments(token)).toHaveLength(3);

		// The header advertises HS256 (not "none"/RS256 — the alg the verify enforces).
		// jose omits the optional `typ`; the alg is the load-bearing claim here.
		const header = JSON.parse(Buffer.from(segments(token)[0], "base64url").toString("utf8"));
		expect(header).toMatchObject({ alg: "HS256" });

		const payload = await verifyAccessToken(token, SECRET, ISSUER, AUDIENCE);
		expect(payload).not.toBeNull();
		expect(payload?.iss).toBe(ISSUER);
		expect(payload?.aud).toBe(AUDIENCE);
		expect(payload?.sub).toBe(claims.sub);
		expect(payload?.client_id).toBe(claims.client_id);
		// jose added iat (now) + exp (now + ttl) as numeric epoch seconds.
		expect(payload?.iat).toBeTypeOf("number");
		expect(payload?.exp).toBeTypeOf("number");
		expect(payload?.exp ?? 0).toBeGreaterThan(payload?.iat ?? 0);
	});
});

describe("verifyAccessToken failure paths → null", () => {
	it("returns null for a tampered signature", async () => {
		const token = await signAccessToken(claims, SECRET, 3600);
		expect(await verifyAccessToken(tamperSignature(token), SECRET, ISSUER, AUDIENCE)).toBeNull();
	});

	it("returns null for an expired token", async () => {
		// Deterministic without a real sleep: freeze the clock at sign time, then jump past exp.
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
		try {
			const token = await signAccessToken(claims, SECRET, 3600); // exp = 01:00:00
			vi.setSystemTime(new Date("2025-01-01T01:00:01Z")); // 1 second past expiry
			expect(await verifyAccessToken(token, SECRET, ISSUER, AUDIENCE)).toBeNull();
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns null for the wrong audience", async () => {
		const token = await signAccessToken(claims, SECRET, 3600);
		expect(await verifyAccessToken(token, SECRET, ISSUER, "https://other.test/mcp")).toBeNull();
	});

	it("returns null for the wrong issuer", async () => {
		const token = await signAccessToken(claims, SECRET, 3600);
		expect(await verifyAccessToken(token, SECRET, "https://other.test", AUDIENCE)).toBeNull();
	});

	it("returns null for the wrong secret", async () => {
		const token = await signAccessToken(claims, SECRET, 3600);
		expect(await verifyAccessToken(token, "a-different-secret-key", ISSUER, AUDIENCE)).toBeNull();
	});

	it("returns null for a malformed token", async () => {
		expect(await verifyAccessToken("not.a.valid.jwt", SECRET, ISSUER, AUDIENCE)).toBeNull();
	});

	it("rejects an alg:none token — the alg-confusion attack (jose enforces HS256)", async () => {
		// Hand-craft a valid-shape token whose header lies (`alg: "none"`), signed with an
		// empty signature. jose must reject it against the HMAC key (the security claim).
		const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
		const now = Math.floor(Date.now() / 1000);
		const payload = Buffer.from(
			JSON.stringify({
				iss: ISSUER,
				aud: AUDIENCE,
				sub: claims.sub,
				client_id: claims.client_id,
				iat: now,
				exp: now + 3600,
			}),
		).toString("base64url");
		const noneToken = `${header}.${payload}.`;
		expect(await verifyAccessToken(noneToken, SECRET, ISSUER, AUDIENCE)).toBeNull();
	});
});

afterEach(() => {
	// Defensive: the expired test restores real timers in `finally`, but guarantee no fake
	// clock leaks into a sibling test if that path ever changes.
	vi.useRealTimers();
});
