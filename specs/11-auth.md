# 11 — Auth: Per-Instance Bearer Token

## Purpose
Gate `/mcp` with a per-instance opaque bearer token: minted once, persisted locally, constant-time compared. Plus a `/.well-known/oauth-protected-resource` pointer so MCP clients discover the bearer requirement. **No OAuth AS, no `/oauth/token`, no DB.**

## Depends on
- `src/config.ts` → `Config` (spec 01)

## Files: `src/auth/token.ts`, `src/auth/middleware.ts`, `src/mcp/well-known.ts`

## `src/auth/token.ts` — `ensureToken(config): Promise<{ token: string; createdAt: string }>`
- If `config.authToken` is set (`MCP_AUTH_TOKEN` override) → return `{ token: config.authToken, createdAt: "" }` **without** touching the credential file.
- Else: credential file at `path.join(os.homedir(), ".openhammer", "credential.json")` = `{ token: string; createdAt: string }`.
  - If it exists and parses with a non-empty `token` → return it.
  - Else: `token = crypto.randomBytes(32).toString("base64url")`; `createdAt = new Date().toISOString()`; `fs.mkdir` the `.openhammer` dir; write the JSON file with mode `0o600` (`fs.writeFileSync(path, data, { mode: 0o600 })`); return it.
- Throw with a clear message if the cred dir is unwritable (don't silently fall back).

## `src/auth/middleware.ts` — `createAuthMiddleware(token: string): FastifyPreHandler`
- `preHandler` that reads `Authorization` header. Require the form `Bearer <value>` (case-insensitive scheme, trim).
- **Constant-time compare:** decode the expected token and the presented token to equal-length Buffers; if lengths differ → fail without comparing; else `crypto.timingSafeEqual(a, b)`.
- On any miss/mismatch: `reply.code(401)`; set header `WWW-Authenticate: Bearer realm="openhammer", resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"`; send a small JSON body (`{ jsonrpc:"2.0", error:{ code:-32001, message:"Unauthorized" }, id:null }`).
- `baseUrl` is derived from the request (`${req.protocol}://${req.host}`) so it is correct under the tunnel too; fall back to `http://${config.host}:${config.port}` if `req.host` is absent. (Take `config` or `baseUrl` as a second arg.)

## `src/mcp/well-known.ts` — `registerWellKnown(fastify, baseUrl): void`
- `GET /.well-known/oauth-protected-resource` (no auth) → JSON:
```json
{
  "resource": "<baseUrl>/mcp",
  "bearer_methods": ["header"]
}
```
- Minimal but sufficient for MCP clients to learn a bearer token is required (no full RFC 8414 metadata in v1).

## Acceptance criteria
- First boot with no cred file → mints a ~43-char base64url token, writes `~/.openhammer/credential.json` (mode `0600`), returns it.
- Second boot reuses the persisted token (same value).
- `MCP_AUTH_TOKEN=xyz` → `ensureToken` returns `xyz` and does NOT read/write the file.
- Request to `/mcp` with no `Authorization` → `401` + `WWW-Authenticate` header naming the well-known URL.
- Wrong token → `401`. Correct token → request proceeds.
- `GET /.well-known/oauth-protected-resource` → 200 JSON with `resource` + `bearer_methods`, no auth needed.
- Token comparison is constant-time (length-mismatch short-circuits safely).

## Decisions & deviations
- **Opaque token, not JWT** — hence no `jose` dependency. Constant-time compare via `crypto.timingSafeEqual`.
- `resource_metadata`/discovery is a minimal subset (plan's intent: "enough for MCP clients to know a bearer token is required").

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/auth/token.ts` (`ensureToken`: override path, read/persist path, 0600) with unit tests (mint, reuse, override, file mode)
- [ ] Implement `src/auth/middleware.ts` (`createAuthMiddleware`: constant-time bearer compare, 401 + WWW-Authenticate) with unit tests
- [ ] Implement `src/mcp/well-known.ts` (`registerWellKnown`: `GET /.well-known/oauth-protected-resource`) with unit tests
