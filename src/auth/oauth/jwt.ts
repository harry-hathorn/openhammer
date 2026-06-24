/**
 * HS256 access-token sign/verify via `jose` (spec 20a).
 *
 * The OAuth Authorization Server (spec 20) issues short-lived HS256 JWTs for the
 * client-credentials grant. Verification is **stateless**: one server `jwtSecret`
 * (stored in `~/.openhammer/credentials.json` or `OAUTH_JWT_SECRET`) both signs and
 * verifies, so no token store is needed — revocation is the TTL.
 *
 * `jose` is the deliberate, evidence-based choice for the security-critical JWT case
 * (decided in spec 20 / recorded in `IMPLEMENTATION_PLAN.md` 20a): it has 0 runtime
 * deps, is audited, and `jwtVerify` enforces `alg: HS256` against the HMAC key —
 * blocking the classic alg-confusion attack (`alg:"none"` / `RS256`) that hand-rolling
 * risks. The repo's no-`jose` rule was for the **v1 opaque token**, where `node:crypto`
 * sufficed; an OAuth AS verifying JWTs is the case where `jose` is the responsible
 * choice. (Client-secret hashing stays `node:crypto` — SHA-256 + constant-time.)
 *
 * This is an **edge**, not a tool/domain op, so it follows spec 11's auth posture:
 * `verifyAccessToken → null` (never throws, never a `Result`) — the middleware `reply`s
 * 401 on `null`. The `Result` spine applies to the client-management ops (20b), not here.
 */
import { createSecretKey } from "node:crypto";
import { type JWTPayload, jwtVerify, SignJWT } from "jose";

/** Wrap the textual JWT secret as an HMAC key (`jose` accepts `SecretKeyObject`). */
const key = (secret: string) => createSecretKey(Buffer.from(secret));

/** Claims required to mint an access token; `client_id` is carried for `allowedClients`. */
export interface AccessTokenClaims {
	/** Token issuer — the server's own base URL (becomes the JWT `iss`). */
	iss: string;
	/** Intended audience — the MCP resource URL (becomes the JWT `aud`). */
	aud: string;
	/** Subject — the client identity (becomes the JWT `sub`). */
	sub: string;
	/** The OAuth client id; surfaced to `allowedClients` (spec 17r) on verify. */
	client_id: string;
}

/**
 * Sign an HS256 access token. `iss`/`aud`/`sub` are set from the claims; `client_id`
 * rides in the payload; `iat` (now) + `exp` (now + `ttlSec`) are added by `jose`.
 * Returns the compact JWS string (header.payload.signature).
 */
export async function signAccessToken(claims: AccessTokenClaims, secret: string, ttlSec: number): Promise<string> {
	return new SignJWT({ client_id: claims.client_id })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(claims.iss)
		.setAudience(claims.aud)
		.setSubject(claims.sub)
		.setIssuedAt()
		.setExpirationTime(`${ttlSec}s`)
		.sign(key(secret));
}

/**
 * Verify a compact JWT: signature (HS256 against `secret`) + `iss` + `aud` + `exp`.
 * Returns the claims (`JWTPayload`) on success, or `null` on any failure — a bad
 * signature, a tampered/expired token, the wrong issuer/audience, or the wrong `alg`
 * (jose rejects `alg:"none"`/`RS256` against the HMAC key). Never throws.
 */
export async function verifyAccessToken(
	jwt: string,
	secret: string,
	issuer: string,
	audience: string,
): Promise<JWTPayload | null> {
	try {
		const { payload } = await jwtVerify(jwt, key(secret), { issuer, audience });
		return payload;
	} catch {
		// Bad signature / expired / wrong iss+aud / wrong alg → `null` for the middleware.
		return null;
	}
}
