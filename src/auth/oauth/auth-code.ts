/**
 * Authorization-code + PKCE + refresh-token machinery (spec 20 auth-code extension).
 *
 * In-memory stores for a single-instance server: authorization codes (10 min,
 * single-use) and refresh tokens (30 day, single-use rotation). Both are cleared on
 * restart (→ re-auth required) — an accepted v1 limitation, since persistence would
 * mean a credentials-store write per refresh rotation, traded away for simplicity.
 * Lookups are by SHA-256 hash of the plaintext token (O(1), no scan, and the
 * plaintext code/token is never stored).
 *
 * PKCE (RFC 7636, S256): the `/oauth/token` exchange verifies
 * `sha256(code_verifier).base64url === stored code_challenge`.
 *
 * Patterns adapted from a reference OAuth implementation (outside this repo),
 * collapsed to OpenHammer's file-based, single-instance model (no DB, no bcrypt).
 */
import { createHash, randomBytes } from "node:crypto";

/** Authorization-code lifetime (RFC 6749 §4.1.2 recommends ≤ 10 min). */
const CODE_TTL_MS = 10 * 60 * 1000;
/** Refresh-token lifetime (a personal-server balance between seamlessness + exposure). */
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** sha256 hex — keys the in-memory maps so the plaintext code/token is never stored. */
function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/**
 * Verify a PKCE code-verifier against the stored S256 challenge
 * (`BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) === code_challenge`).
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
	return createHash("sha256").update(verifier).digest("base64url") === challenge;
}

// ── Authorization codes ────────────────────────────────────────────────────────

/** Inputs to {@link generateCode} — the OAuth params bound to the code. */
export interface GenerateCodeInput {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	/** The authenticated identity (becomes the JWT `sub`). */
	username: string;
}

/** The payload bound to a minted code (returned by {@link consumeCode}). */
export interface ConsumedCode {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	username: string;
}

interface StoredCode extends ConsumedCode {
	expiresAt: number;
	consumedAt: number | null;
}

const codes = new Map<string, StoredCode>();

/**
 * Mint a single-use authorization code bound to the client + PKCE challenge +
 * authenticated identity. Returns the plaintext code (shown once to the client via
 * the redirect); only its hash is kept.
 */
export function generateCode(input: GenerateCodeInput): string {
	const code = randomBytes(32).toString("base64url");
	codes.set(sha256Hex(code), {
		clientId: input.clientId,
		redirectUri: input.redirectUri,
		codeChallenge: input.codeChallenge,
		username: input.username,
		expiresAt: Date.now() + CODE_TTL_MS,
		consumedAt: null,
	});
	return code;
}

/**
 * Consume a code: single-use (mark consumed before any check, so a replay can never
 * succeed), then verify it belongs to `clientId`, has not expired, and that
 * `codeVerifier` matches the stored S256 challenge. Returns the bound payload on
 * success, else `null`.
 */
export function consumeCode(code: string, clientId: string, codeVerifier: string): ConsumedCode | null {
	const stored = codes.get(sha256Hex(code));
	if (stored === undefined) return null;
	// One-time use: mark consumed even if a later check fails (defensive against replay).
	if (stored.consumedAt !== null) return null;
	stored.consumedAt = Date.now();
	if (stored.clientId !== clientId) return null;
	if (stored.expiresAt < Date.now()) return null;
	if (!verifyPkce(codeVerifier, stored.codeChallenge)) return null;
	return {
		clientId: stored.clientId,
		redirectUri: stored.redirectUri,
		codeChallenge: stored.codeChallenge,
		username: stored.username,
	};
}

/** Drop consumed + expired codes (best-effort hygiene; returns the count removed). */
export function pruneCodes(now: number = Date.now()): number {
	let removed = 0;
	for (const [hash, stored] of codes) {
		if (stored.consumedAt !== null || stored.expiresAt < now) {
			codes.delete(hash);
			removed++;
		}
	}
	return removed;
}

// ── Refresh tokens ─────────────────────────────────────────────────────────────

/** Inputs to {@link issueRefreshToken}. */
export interface IssueRefreshInput {
	clientId: string;
	username: string;
}

interface StoredRefresh {
	clientId: string;
	username: string;
	expiresAt: number;
	usedAt: number | null;
}

const refreshTokens = new Map<string, StoredRefresh>();

/**
 * Mint a refresh token bound to the client + identity (30-day TTL). Returns the
 * plaintext token; only its hash is kept. Single-use: {@link redeemRefreshToken}
 * rotates it (the caller mints the next one).
 */
export function issueRefreshToken(input: IssueRefreshInput): string {
	const token = randomBytes(32).toString("base64url");
	refreshTokens.set(sha256Hex(token), {
		clientId: input.clientId,
		username: input.username,
		expiresAt: Date.now() + REFRESH_TTL_MS,
		usedAt: null,
	});
	return token;
}

/**
 * Redeem a refresh token: rotate (mark used — the caller mints the next one with
 * {@link issueRefreshToken}), reject an expired or already-used token. Returns the
 * bound identity on success, else `null`. v1 does not chain-revoke on reuse (a
 * single-use rotate is sufficient for a personal server).
 */
export function redeemRefreshToken(token: string): { clientId: string; username: string } | null {
	const stored = refreshTokens.get(sha256Hex(token));
	if (stored === undefined) return null;
	if (stored.usedAt !== null) return null;
	if (stored.expiresAt < Date.now()) return null;
	stored.usedAt = Date.now();
	return { clientId: stored.clientId, username: stored.username };
}

/** Drop used + expired refresh tokens (best-effort hygiene; returns the count removed). */
export function pruneRefreshTokens(now: number = Date.now()): number {
	let removed = 0;
	for (const [hash, stored] of refreshTokens) {
		if (stored.usedAt !== null || stored.expiresAt < now) {
			refreshTokens.delete(hash);
			removed++;
		}
	}
	return removed;
}

/**
 * Reset the in-memory code + refresh stores (test/operational hygiene only — the
 * stores are module singletons, so tests call this in `beforeEach` for isolation).
 */
export function resetAuthCodeStores(): void {
	codes.clear();
	refreshTokens.clear();
}

// ── Login form HTML ────────────────────────────────────────────────────────────

/** Escape HTML-special characters (the form echoes OAuth params into hidden inputs). */
export function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Inputs to {@link buildLoginForm}. */
export interface LoginFormParams {
	clientId: string;
	/** Display name for the client (shown in the subtitle). */
	clientName: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
	/** Optional pre-rendered error line (e.g. an escaped "Invalid username or password"). */
	errorHtml: string;
}

/**
 * Build the `/oauth/authorize` login form (username + password). Hidden inputs carry
 * the OAuth params back to `POST /oauth/authorize`; `state` is optional. All echoed
 * values are HTML-escaped. The form POSTs to `/oauth/authorize` (the same path),
 * matching the existing `/oauth` namespace (`/oauth/token`).
 */
export function buildLoginForm(p: LoginFormParams): string {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>OpenHammer — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 32px; width: 100%; max-width: 360px; }
    h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; color: #f0f6fc; }
    .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
    .subtitle strong { color: #58a6ff; }
    label { display: block; font-size: 12px; font-weight: 500; color: #8b949e; margin-bottom: 6px; }
    input[type=text], input[type=password] { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px 12px; color: #c9d1d9; font-size: 14px; outline: none; margin-bottom: 14px; }
    input:focus { border-color: #58a6ff; box-shadow: 0 0 0 3px rgba(88, 166, 255, 0.2); }
    button { width: 100%; background: #238636; border: none; border-radius: 6px; padding: 10px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #2ea043; }
    .error { color: #f85149; font-size: 13px; margin-bottom: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>OpenHammer</h1>
    <p class="subtitle">Sign in to grant access to <strong>${escapeHtml(p.clientName)}</strong></p>
    ${p.errorHtml}
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id" value="${escapeHtml(p.clientId)}">
      <input type="hidden" name="redirect_uri" value="${escapeHtml(p.redirectUri)}">
      <input type="hidden" name="state" value="${escapeHtml(p.state)}">
      <input type="hidden" name="code_challenge" value="${escapeHtml(p.codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="S256">
      <label for="username">Username</label>
      <input type="text" id="username" name="username" autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input type="password" id="password" name="password" autocomplete="current-password" required>
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
}
