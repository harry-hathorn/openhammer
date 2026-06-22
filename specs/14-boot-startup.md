# 14 — Boot & Startup Output (main.ts, startup-print.ts)

## Purpose
Wire everything together on boot: load config → ensure token → boot Fastify → (optional) tunnel → print URL + token + a ready-to-paste client config block. The user-facing entrypoint.

## Depends on
- All prior specs (config 01, auth 11, mcp/fastify 12, tunnel 13).

## `src/startup-print.ts` — `printStartup({ localUrl, tunnelUrl, token }): void`
Log, with clear separators:
- The local MCP endpoint: `http://127.0.0.1:<PORT>/mcp` (or the configured HOST).
- The tunnel URL (only if `tunnelUrl` provided): `https://<...>.trycloudflare.com/mcp`.
- The bearer token (printed **once**, on boot): `<token>`.
- A ready-to-paste **MCP client config block**, both forms:
  - Claude Code / generic MCP `mcpServers` JSON (an HTTP server entry pointing at the URL with the `Authorization: Bearer <token>` header):
    ```json
    {
      "mcpServers": {
        "openhammer": {
          "type": "http",
          "url": "<localUrl>/mcp",
          "headers": { "Authorization": "Bearer <token>" }
        }
      }
    }
    ```
  - A one-line note: "Hand this URL + token to your remote agent (e.g. pi, Claude Code, a cloud LLM)."
- Also log where the credential file lives (`~/.openhammer/credential.json`) and that the token is reused on restart (unless `MCP_AUTH_TOKEN` overrides).

## `src/main.ts`
1. `const config = loadConfig();`
2. `const { token } = await ensureToken(config);`
3. Parse argv: `const tunnel = process.argv.slice(2).includes("--tunnel");`
4. `const fastify = await buildFastify(config, token);` then `await fastify.listen({ port: config.port, host: config.host });` (`buildFastify` builds only — it does **not** listen; see spec 12).
5. If `tunnel`: `const t = await startTunnel(config.port);` — if `null`, log `"cloudflared not found — continuing localhost-only."`.
6. `printStartup({ localUrl: `http://${config.host}:${config.port}`, tunnelUrl: t?.url, token });`
7. Shutdown: register `SIGINT`/`SIGTERM` handlers → `fastify.close()`, kill `t?.child` if present, `process.exit(0)`.
8. Let the process stay alive serving requests.

## Acceptance criteria
- **Automated (Tier-2 boot E2E `test/e2e-hermetic/boot.e2e.test.ts`, task T-boot-e2e):** spawns the entrypoint via `tsx`, asserts `/health` 200, token reuse across two boots, and clean `SIGINT`/`SIGTERM` shutdown (no orphan tunnel child). This replaces the manual smoke below as the regression.
- `npm start` (with `MCP_ROOT_DIR` set to a scratch dir) boots, prints local URL + token + the client-config JSON block, and serves `/mcp`, `/health`, `/.well-known/oauth-protected-resource`.
- `npm start -- --tunnel` (cloudflared present) additionally prints a `trycloudflare.com` URL; (absent) prints the "not found, localhost-only" notice and still serves.
- Ctrl+C cleanly stops Fastify and the tunnel child (no orphan processes, no stack trace dumped).
- Re-running `npm start` reuses the same token from `~/.openhammer/credential.json` (token line is identical).

## Decisions & deviations
- `printStartup` is unit-testable (assert it emits the URL, the token, and a parseable `mcpServers` JSON block); `main.ts` wiring is verified by the boot smoke test above.

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/startup-print.ts` (`printStartup`: format URL(s) + token + `mcpServers` JSON block) with unit tests
- [ ] Implement `src/main.ts` (loadConfig → ensureToken → buildFastify → optional tunnel → printStartup → signal handlers) — verified by the `npm start` smoke test
