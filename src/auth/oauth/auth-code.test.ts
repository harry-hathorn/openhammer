import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildLoginForm,
	consumeCode,
	generateCode,
	issueRefreshToken,
	redeemRefreshToken,
	resetAuthCodeStores,
	verifyPkce,
} from "./auth-code.ts";

const verifier = "verifier-value-1234567890";
const challenge = createHash("sha256").update(verifier).digest("base64url");

beforeEach(() => {
	resetAuthCodeStores();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("verifyPkce", () => {
	it("accepts the matching S256 verifier", () => {
		expect(verifyPkce(verifier, challenge)).toBe(true);
	});

	it("rejects a wrong verifier", () => {
		expect(verifyPkce("wrong-verifier", challenge)).toBe(false);
	});
});

describe("authorization codes", () => {
	it("mints a code that consumes once with the right clientId + verifier", () => {
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		expect(code).toMatch(/^[A-Za-z0-9_-]+$/);

		const consumed = consumeCode(code, "oh_1", verifier);
		expect(consumed).toEqual({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
	});

	it("is single-use — a replay returns null", () => {
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		expect(consumeCode(code, "oh_1", verifier)).not.toBeNull();
		expect(consumeCode(code, "oh_1", verifier)).toBeNull();
	});

	it("rejects an unknown code", () => {
		expect(consumeCode("nonexistent", "oh_1", verifier)).toBeNull();
	});

	it("rejects a clientId mismatch (and burns the code)", () => {
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		expect(consumeCode(code, "oh_other", verifier)).toBeNull();
		// The mismatch burned it — a correct retry no longer works.
		expect(consumeCode(code, "oh_1", verifier)).toBeNull();
	});

	it("rejects a wrong PKCE verifier (and burns the code)", () => {
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		expect(consumeCode(code, "oh_1", "wrong-verifier")).toBeNull();
		expect(consumeCode(code, "oh_1", verifier)).toBeNull();
	});

	it("rejects an expired code", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		// Advance past the 10-minute code TTL.
		vi.advanceTimersByTime(11 * 60 * 1000);
		expect(consumeCode(code, "oh_1", verifier)).toBeNull();
	});
});

describe("refresh tokens", () => {
	it("issues a token that redeems once for the bound identity", () => {
		const token = issueRefreshToken({ clientId: "oh_1", username: "op" });
		expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(redeemRefreshToken(token)).toEqual({ clientId: "oh_1", username: "op" });
	});

	it("is single-use — a reuse returns null", () => {
		const token = issueRefreshToken({ clientId: "oh_1", username: "op" });
		expect(redeemRefreshToken(token)).not.toBeNull();
		expect(redeemRefreshToken(token)).toBeNull();
	});

	it("rejects an unknown token", () => {
		expect(redeemRefreshToken("nonexistent")).toBeNull();
	});

	it("rejects an expired token", () => {
		vi.useFakeTimers({ now: 1_000_000 });
		const token = issueRefreshToken({ clientId: "oh_1", username: "op" });
		// Advance past the 30-day refresh TTL.
		vi.advanceTimersByTime(31 * 24 * 60 * 60 * 1000);
		expect(redeemRefreshToken(token)).toBeNull();
	});
});

describe("resetAuthCodeStores", () => {
	it("clears the in-memory code store", () => {
		const code = generateCode({
			clientId: "oh_1",
			redirectUri: "https://app/cb",
			codeChallenge: challenge,
			username: "op",
		});
		resetAuthCodeStores();
		expect(consumeCode(code, "oh_1", verifier)).toBeNull();
	});

	it("clears the in-memory refresh store", () => {
		const token = issueRefreshToken({ clientId: "oh_1", username: "op" });
		resetAuthCodeStores();
		expect(redeemRefreshToken(token)).toBeNull();
	});
});

describe("buildLoginForm", () => {
	const baseParams = {
		clientId: "oh_1",
		clientName: "Claude",
		redirectUri: "https://claude.ai/api/mcp/auth_callback",
		state: "state-123",
		codeChallenge: challenge,
		errorHtml: "",
	};

	it("renders the client name + the OAuth params as hidden inputs + the username/password fields", () => {
		const html = buildLoginForm(baseParams);
		expect(html).toContain("Sign in to grant access to <strong>Claude</strong>");
		expect(html).toContain('name="client_id" value="oh_1"');
		expect(html).toContain('name="redirect_uri" value="https://claude.ai/api/mcp/auth_callback"');
		expect(html).toContain('name="state" value="state-123"');
		expect(html).toContain('name="code_challenge"');
		expect(html).toContain('name="code_challenge_method" value="S256"');
		expect(html).toContain('name="username"');
		expect(html).toContain('name="password"');
		expect(html).toContain('action="/oauth/authorize"');
	});

	it("renders the error line when provided", () => {
		const html = buildLoginForm({ ...baseParams, errorHtml: '<p class="error">Invalid username or password</p>' });
		expect(html).toContain("Invalid username or password");
	});

	it("HTML-escapes the echoed client name (no XSS)", () => {
		const html = buildLoginForm({ ...baseParams, clientName: "<script>alert(1)</script>" });
		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain("<script>alert(1)</script>");
	});

	it("HTML-escapes the echoed redirect_uri", () => {
		const html = buildLoginForm({ ...baseParams, redirectUri: 'https://app/cb" onload="x' });
		expect(html).toContain("&quot;");
		expect(html).not.toContain('value="https://app/cb" onload');
	});
});
