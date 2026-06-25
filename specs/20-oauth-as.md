# 20 — OAuth Authorization Server (client-credentials + authorization-code)

## Purpose
Many MCP clients (Claude Code, Cursor, custom agents) **cannot set a raw `Authorization: Bearer` header** — they only speak OAuth: they discover an Authorization Server, `POST client_id` + `client_secret` to a token endpoint, and use the returned `access_token`. Spec 20 adds an **OAuth 2.0 Authorization Server** to OpenHammer so those clients connect natively, **un-deferring** spec 11's "no OAuth AS" decision.

> **Scope grew in two passes.** The original v1 (20a–20g) was the **client-credentials grant only**
> (machine clients — `POST /oauth/token` with `client_id`/`client_secret`). The **authorization-code
> extension** (20h–20l) added the flow Claude web and Claude Code actually require — authorization-code
> + PKCE (`GET/POST /oauth/authorize`), RFC 7591 dynamic registration (`POST /register`), and refresh
> tokens — because those clients do **not** support client-credentials. Tokens are **HS256 JWTs**
> signed with one server secret (stateless validation); the existing opaque bearer stays supported as
> a fallback. (No user database, no DB, no bcrypt — OpenHammer is single-instance + file-based; see
> the extension section below.)

## Source references
- Standard OAuth 2.0 client-credentials grant (RFC 6749 §4.4) + JWT (RFC 7519, HS256).
- Metadata: **RFC 8414** (`/.well-known/oauth-authorization-server`) + **RFC 9728** (`/.well-known/oauth-protected-resource` — OpenHammer already ships a minimal one in spec 11c; extend it to point at the AS).
- Existing OpenHammer: `src/auth/middleware.ts` (the bearer gate, spec 11b — extended to accept JWTs), `src/mcp/well-known.ts` (spec 11c), `src/config/credentials.ts` (spec 17e — stores the client registry + signing secret, `0600`).
- **Conventions:** JWT sign/verify uses **`jose`** (0 runtime deps, audited — see Decisions); client-secret hashing uses **`node:crypto`** (SHA-256 + `timingSafeEqual`; no `bcrypt` — secrets are high-entropy random).

## Depends on
- spec 11 (auth middleware + well-known), spec 17 (credentials store, CLI/wizard for client issuance).

## Architecture
- **Client registry** lives in `~/.openhammer/credentials.json` (`0600`): `{ clients: { <client_id>: { secretHash, label, createdAt } }, jwtSecret }`. Issued via the TUI / a CLI command; the plaintext secret is returned **once**.
- **`POST /oauth/token`** (`grant_type=client_credentials`): verify `client_id` + `client_secret` → issue an HS256 JWT (`iss`, `aud`, `sub=client_id`, `exp` ~1h) → `{ access_token, token_type: "Bearer", expires_in: 3600 }`.
- **Metadata**: RFC 8414 advertises the token endpoint + `grant_types_supported: ["client_credentials"]`; the existing RFC 9728 doc gains `authorization_servers`.
- **Middleware** (spec 11b) accepts **either** the existing opaque token **or** a valid AS-issued JWT (signature + `exp` + `iss` + `aud`). `allowedClients` (spec 17r) then applies to the JWT's `client_id`.

## Files + code

### `src/auth/oauth/jwt.ts` — HS256 sign/verify (`jose`)
```ts
import { createSecretKey } from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

const key = (secret: string) => createSecretKey(Buffer.from(secret));

/** Sign an HS256 access token (iss/aud/sub required; exp/iat added by jose). */
export async function signAccessToken(
	claims: { iss: string; aud: string; sub: string; client_id: string },
	secret: string,
	ttlSec: number,
): Promise<string> {
	return new SignJWT({ client_id: claims.client_id })
		.setProtectedHeader({ alg: "HS256" })
		.setIssuer(claims.iss)
		.setAudience(claims.aud)
		.setSubject(claims.sub)
		.setIssuedAt()
		.setExpirationTime(`${ttlSec}s`)
		.sign(key(secret));
}

/** Verify signature + iss/aud + exp → claims (JWTPayload), or null. jose enforces
 *  alg = HS256 against the HMAC key, so `alg:"none"` / `RS256` tokens are rejected
 *  (the classic alg-confusion attack) — no hand-rolled footgun. No `as` (returns jose's type). */
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
		return null; // bad signature / expired / wrong iss+aud / wrong alg
	}
}
```

### `src/auth/oauth/clients.ts` — client registry (`node:crypto`, no `bcrypt`)
```ts
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
// store: credentials.json → { jwtSecret, clients: { [id]: { secretHash, label, createdAt } } }

export const newClientId = (): string => `oh_${randomBytes(16).toString("hex")}`;
export const newClientSecret = (): string => randomBytes(32).toString("base64url"); // print once
const hashSecret = (s: string): string => createHash("sha256").update(s).digest("hex");
export const verifySecret = (provided: string, hash: string): boolean => {
	const a = Buffer.from(hashSecret(provided)), b = Buffer.from(hash);
	return a.length === b.length && timingSafeEqual(a, b); // constant-time
};
// issue/list/remove → Result<..., Error> domain mutations over credentials.json
//   (spec-17 manage.ts style). issueClient → ok({ clientId, plaintextSecret }): the
//   plaintext secret is returned ONCE; only the hash is stored.
```

> **Implementation note (20b, shipped):** the on-disk layout is a **reserved credId**
> (`__openhammer_oauth__`) bag `{ jwtSecret?, clients }` (with `clients` JSON-stringified)
> inside 17e's `Record<credId, Record<string,string>>` `credentials.json` — **not** the
> top-level `{ jwtSecret, clients: {…} }` sketched above. 17e's `isCredentialsMap`
> whole-file validation rejects any non-string-bag value (data loss on the next channel
> write), so the registry must ride inside a valid string bag. The bag shape is fully
> encapsulated behind the domain functions (`findClient`/`listClients`/`issueClient`/
> `removeClient`/`ensureJwtSecret`/`resolveJwtSecret`). Full rationale in
> `IMPLEMENTATION_PLAN.md` 20b.

### `src/auth/oauth/token.ts` — the client-credentials grant
```ts
// POST /oauth/token  (JSON or form body; mount under @fastify/formbody for form posts)
const body = isRecord(req.body) ? req.body : {};            // narrow WITHOUT `as` (AGENTS.md forbids it)
const grantType = typeof body["grant_type"] === "string" ? body["grant_type"] : "";
if (grantType !== "client_credentials") return reply.code(400).send({ error: "unsupported_grant_type" });
const clientId = typeof body["client_id"] === "string" ? body["client_id"] : "";
const clientSecret = typeof body["client_secret"] === "string" ? body["client_secret"] : "";
const client = clientId ? findClient(clientId) : undefined;
if (!client || !verifySecret(clientSecret, client.secretHash))
	return reply.code(401).send({ error: "invalid_client" }); // RFC 6749 error body
const access_token = signAccessToken(
	{ iss: ISSUER, aud: AUDIENCE, sub: client.clientId, client_id: client.clientId },
	jwtSecret, 3600,
);
return reply.send({ access_token, token_type: "Bearer", expires_in: 3600 });
```

### `src/mcp/well-known.ts` (extend) — RFC 8414 + point RFC 9728 at the AS
```ts
// GET /.well-known/oauth-authorization-server  (RFC 8414, public)
{
  issuer: baseUrl,
  token_endpoint: `${baseUrl}/oauth/token`,
  grant_types_supported: ["client_credentials"],
  token_endpoint_auth_methods_supported: ["client_secret_post"],
  scopes_supported: [],
  service_documentation: `${baseUrl}/docs`,
}
// GET /.well-known/oauth-protected-resource  (RFC 9728 — add authorization_servers)
{ resource: baseUrl, authorization_servers: [baseUrl], bearer_methods_supported: ["header"], scopes_supported: [] }
```

### `src/auth/middleware.ts` (extend, spec 11b) — accept opaque OR JWT
```ts
const token = parseBearer(request); // existing
if (opaqueTokenMatches(token, config.authToken)) return;          // existing opaque path
const claims = verifyAccessToken(token, jwtSecret, ISSUER, AUDIENCE); // new JWT path
if (claims) {
	const cid = typeof claims.client_id === "string" ? claims.client_id : undefined;
	if (!allowedClientsAllows(cid)) return reply.code(403).send({ error: "access_denied" });
	return;
}
return reply.code(401).send({ /* WWW-Authenticate: Bearer ... */ });
```

### `src/cli.ts` / wizard — issue clients via the TUI
`openhammer auth add-client` (and `list`/`remove`) → generates `client_id` + `client_secret`, stores the hash in `credentials.json`, prints the plaintext secret **once**. (Also reachable as a `config` section if you prefer.) The `jwtSecret` is minted on first use if absent.

## Acceptance criteria
- A client can `POST /oauth/token` with `grant_type=client_credentials` + a valid `client_id`/`client_secret` → receives a `Bearer` JWT; using it on `/mcp` succeeds; a wrong pair → `401 invalid_client`.
- The JWT is HS256, statelessly verifiable (signature + `exp` + `iss` + `aud`), ~1h TTL; an expired/tampered JWT → `401`.
- `/.well-known/oauth-authorization-server` (RFC 8414) + the extended `oauth-protected-resource` (RFC 9728) advertise the token endpoint, so an OAuth-only MCP client discovers + connects end-to-end.
- The existing opaque bearer still works (no regression); `allowedClients` applies to the JWT's `client_id`.
- Clients + the `jwtSecret` persist to `~/.openhammer/credentials.json` (`0600`); the plaintext secret is shown once; `doctor` checks the file perms + that a `jwtSecret` exists.

## Decisions & deviations
- **Un-defers spec 11's "no OAuth AS".** Client-credentials only (machine clients); no auth-code/login/users/DB/refresh — OpenHammer has no user system, so the human-login half of a full AS is out of scope.
- **JWT via `jose`** (decided, evidence-based) — `jose` has **0 runtime deps** + is audited, and `jwtVerify` enforces `alg: HS256` against the HMAC key, **blocking alg-confusion** (the classic JWT vuln: `alg:"none"`/`RS256`) that hand-rolling risks. The repo's no-`jose` rule was for the **v1 opaque token** (`node:crypto` sufficed); an OAuth AS verifying JWTs is the security-critical case where `jose` is the responsible choice. Client-secret hashing stays `node:crypto` (SHA-256 + `timingSafeEqual`; no `bcrypt`). **Dep placement:** `jose` → `dependencies` (the prod server verifies JWTs in the auth middleware).
- **Result-pattern boundary** — auth is an **edge**, not domain: `verifyAccessToken`→`null`, `verifySecret`→`boolean`, and the `/token` handler `reply`s (401/400) — **not** `Result`. This matches spec 11's auth posture (`ensureToken` throws at boot; the middleware `reply`s at request). The `Result` spine applies to the **client-management ops** (`issue`/`list`/`remove` — domain mutations over the file, spec-17 `manage.ts` style) and, as ever, tool `execute`. Same split as the rest of the codebase: tools/domain → `Result`; presence/boot/edge → `null`/throw/`reply`.
- **Stateless JWTs** — no token storage; revocation is the TTL (~1h). A denylist is a later option if needed.
- **Symmetric HS256** — one server `jwtSecret` (in `credentials.json` or `OAUTH_JWT_SECRET` env) signs + verifies; no JWKS/asymmetric key management. Sufficient for a single-instance server; revisit if multi-instance.

## Suggested plan items (atomic checkboxes)
- [x] 20a — `src/auth/oauth/jwt.ts`: HS256 sign/verify via **`jose`** (`SignJWT`/`jwtVerify`; `iss`/`aud`/`exp`; alg-confusion-safe). Add `jose` to **dependencies**. + tests (round-trip; tamper→null; expired→null; wrong aud→null). *deps: none (jose is 0-dep).* **Shipped** (see `IMPLEMENTATION_PLAN.md` 20a).
- [x] 20b — `src/auth/oauth/clients.ts`: client registry over `credentials.json` (`newClientId`/`newClientSecret`/`hashSecret`/`verifySecret`/issue/list/remove) + `jwtSecret` mint. + tests. *deps: 17e.* **Shipped.**
- [x] 20c — `src/auth/oauth/token.ts` + mount `POST /oauth/token` (client-credentials grant; `@fastify/formbody` for form posts) + RFC 8414 metadata + extend RFC 9728. + tests (valid/invalid pair; unsupported grant). *deps: 20a, 20b, 11c.* **Shipped.**
- [x] 20d — extend `src/auth/middleware.ts` (spec 11b): accept opaque OR JWT; `allowedClients` applies to JWT `client_id`. + tests (opaque pass; JWT pass; expired/ tampered → 401; disallowed client → 403). *deps: 20a, 11b, 17r.* **Shipped.**
- [x] 20e — `openhammer auth {add-client|list|remove}` (TUI/CLI issuance; plaintext secret shown once). + tests. *deps: 20b, 17n.* **Shipped.**
- [x] 20f — `doctor` checks `credentials.json` perms + `jwtSecret` present; `.env.example`/README note `OAUTH_JWT_SECRET`. *deps: 20b, 17p.* **Shipped.**

---

## Authorization-code extension (20h–20l, shipped)

The client-credentials AS (above) does not serve **Claude web** or **Claude Code**, which only speak
the **authorization-code + PKCE** flow and require **dynamic client registration**. This extension
adds that flow on top of the existing AS — same HS256 JWTs, same `/mcp` gate (the middleware already
accepts any AS-issued JWT with the right `iss`/`aud`, so **no middleware change**).

### Public base URL (20h) — `MCP_PUBLIC_URL`
OAuth discovery advertises the issuer + endpoints from the server's base URL. Build-time
``http://${host}:${port}`` is wrong behind a tunnel (unreachable, non-https, drags a port in). `main.ts`
now resolves the channel handle **before** building Fastify and derives
`baseUrl = handle?.url ?? config.publicUrl ?? http://${host}:${port}` — so a managed ngrok/cloudflare
channel auto-advertises its URL, and a **manual** tunnel sets `MCP_PUBLIC_URL=https://<tunnel>.app`.
`buildFastify` takes `baseUrl` as an explicit param (the localhost fallback keeps test callers valid);
it threads to `registerWellKnown` + `registerOauthRoutes`, and `main.ts` derives the JWT `iss`/`aud`
from the same source.

### Client model + operator login (20i) — `clients.ts`
`ClientRecord` gains `grantTypes: string[]`, `redirectUris?`, `username?`, `passwordHash?`. Legacy
clients (pre-auth-code, no `grantTypes`) **normalize to `["client_credentials"]`** on read, so an
existing client keeps working. `issueClient(label, opts?)` selects the grant type + redirect URIs +
optional per-client login (SHA-256 hashed, like the client secret). A **global operator login**
(`setOperatorLogin`/`verifyOperatorLogin`/`hasOperatorLogin`, under a reserved `__openhammer_login__`
credId bag) is the `/authorize` fallback for clients with no per-client credentials — i.e. the clients
`/register` mints.

### Auth-code + PKCE + refresh (20j) — `src/auth/oauth/auth-code.ts` (NEW)
In-memory stores for a single-instance server (cleared on restart → re-auth required):
- **Authorization codes** — `Map<sha256(code), {clientId, redirectUri, codeChallenge, username, expiresAt(10m), consumedAt}>`; `generateCode`/`consumeCode` (single-use: mark consumed before checks; verify PKCE S256 `sha256(verifier).base64url === challenge`, `clientId`, expiry). The plaintext code is never stored.
- **Refresh tokens** — `Map<sha256(token), {clientId, username, expiresAt(30d), usedAt}>`; `issueRefreshToken`/`redeemRefreshToken` (single-use rotation; reuse → reject). v1 has no chain-revocation.
- `buildLoginForm` — the inline HTML login form (username + password); hidden inputs carry the OAuth params; all echoed values HTML-escaped.

### Routes + metadata (20k) — `token.ts`
- `GET /oauth/authorize` — validate `client_id` (registered + `authorization_code` grant), `redirect_uri` (registered), `code_challenge`, `code_challenge_method === "S256"` → render the login form.
- `POST /oauth/authorize` — resolve the login (per-client credentials, else the global operator login), else redirect back with `error`; on success mint a code + `302` to `redirect_uri?code=&state=`.
- `POST /oauth/token` — now a grant dispatcher: `client_credentials` (existing) + `authorization_code` (consume the code, verify PKCE + redirect_uri match, sign the JWT with `sub=username`, issue a refresh token) + `refresh_token` (rotate + re-issue).
- `POST /register` (RFC 7591) — create an `authorization_code` client with the request's `redirect_uris`; public (the `/authorize` login still gates).
- **Metadata** gains `authorization_endpoint`, `registration_endpoint`, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `"authorization_code","refresh_token"` in `grant_types_supported`, and `"none"` in `token_endpoint_auth_methods_supported` (auth-code clients are public — PKCE is the client auth).

### Add-client wizard + set-login (20l) — `client-wizard.ts`, `cli/auth.ts`, dashboard
The shared `collectClientConfig(io)` (in `src/tui/client-wizard.ts`, so both the CLI and dashboard
import it without a `tui → cli` cycle) walks label → type → (for auth-code) redirect URIs + optional
per-client login. `auth add-client` runs it (interactive) or builds the same config from flags
(`--type`, `--redirect-uris`, `--username`, `--password`). New `auth set-login` sets the global
operator login. The Clients screen shows each client's grant type ("login" / "machine") and the detail
view shows username + redirect URIs.

### Acceptance criteria (extension)
- Claude web/Code discover the AS, `/register` (or use a pre-registered client), complete the `/oauth/authorize` login, exchange the code at `/oauth/token`, and reach `tools/list` over `/mcp` through a tunnel with `MCP_PUBLIC_URL` set.
- A code is single-use; a wrong PKCE verifier, a `clientId` mismatch, an expired code, and a redirect_uri mismatch all → `400 invalid_grant`; a replayed code → `400`.
- A refresh token rotates (new access + new refresh); a reused refresh → `400 invalid_grant`.
- The `/authorize` login accepts the client's own credentials when set, else the global operator login; otherwise it re-renders the form with an error.
- The existing client-credentials grant + opaque bearer are unchanged (no regression).

### Decisions & notes (extension)
- **No DB / no bcrypt / no user system** — OpenHammer is single-instance + file-based, so the reference impl's Postgres + Firebase + bcrypt-rotation is collapsed to in-memory code/refresh stores + SHA-256 hashing. Trade-off: codes + refresh tokens clear on restart (re-auth required).
- **Login model** — `/authorize` resolves a client's own credentials first, else the global operator login. This is forced by `/register` (Claude web mints its own client, so the login can't bind to one pre-registered client); the global login is the `/register` fallback.
- **Public auth-code clients** — token-endpoint auth method `"none"`; PKCE is the client auth (no `client_secret` required at `/token` for auth-code). The `/authorize` username/password is the user gate.
- **Deferred** — a dashboard "Set operator login" menu entry (CLI `auth set-login` covers it); refresh-token/auth-code persistence across restart.

## Plan items — authorization-code extension (shipped)
- [x] 20h — `MCP_PUBLIC_URL` + boot reorder (`config.ts`, `main.ts`, `server.ts`): advertise the public base URL. *deps: 20c.*
- [x] 20i — `clients.ts`: extend `ClientRecord` (`grantTypes`/`redirectUris`/`username`/`passwordHash`) + global operator login; legacy normalize. *deps: 20b.*
- [x] 20j — `src/auth/oauth/auth-code.ts` (NEW): PKCE, in-memory auth codes + refresh tokens, login HTML. *deps: 20a.*
- [x] 20k — `token.ts`: `/oauth/authorize` (GET+POST), `/register`, `authorization_code` + `refresh_token` grants, extended metadata. *deps: 20i, 20j, 20c.*
- [x] 20l — `client-wizard.ts` (NEW) + `cli/auth.ts` wizard + `auth set-login` + dashboard view/screens. *deps: 20i, 20k, 20e.*
