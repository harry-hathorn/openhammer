## Build & Run

OpenHammer is a **standalone MCP server with no LLM** — it only executes tools; intelligence lives in the remote agent. Node 20+, ESM, TypeScript strict.

- Install: `npm install`
- Build: `npm run build` (tsc → `dist/`)
- Start: `npm start` (`node dist/main.js`) — or `npm run dev` for `tsx watch src/main.ts`
- Tests: `npm test` (vitest run)

Configure via env (see `.env.example`): `PORT` (3000), `HOST` (127.0.0.1), `MCP_ROOT_DIR` (empty = launch cwd), `MCP_AUTH_TOKEN` (override the minted token), `MCP_MAX_RESPONSE_BYTES` (512000), `LOG_LEVEL`.

On first boot it mints a bearer token to `~/.openhammer/credential.json` and prints the URL + token + a ready-to-paste MCP client config block. Verify with the MCP Inspector: `npx @modelcontextprotocol/inspector` → POST `http://127.0.0.1:<PORT>/mcp` with `Authorization: Bearer <token>` → `initialize` → `tools/list` (expect 7 tools) → call each.

## Validation

Run these after implementing to get immediate feedback (the loop's backpressure — all three must pass before checking off a task):

- Tests: `npm test` (vitest; `--passWithNoTests` keeps it green for scaffold tasks). Runs the **hermetic** tiers: Tier-0 units (`src/**/*.test.ts`), Tier-1 in-process MCP E2E, Tier-2 boot E2E (`test/e2e-hermetic/**`).
- Typecheck: `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` — covers `src` **and** `test`).
- Lint/format: `npm run lint` (`biome check src test`).

**Containerized tiers (on-demand, non-blocking for the loop):** `npm run test:compose` (deterministic server+test-runner E2E via Docker Compose), `npm run test:in-container` (`docker compose run --rm dev npm test`), `npm run test:tunnel` (gated cloudflared E2E — skips unless `OPENHAMMER_TUNNEL_E2E=1` + binary present). Full strategy: `specs/15-testing-strategy.md`, `specs/16-containerized-e2e.md`. Each task in `IMPLEMENTATION_PLAN.md` names the test tier it activates.

## Operational Notes

- **No LLM.** Server only executes tools.
- **Stateless MCP.** No `sessionIdGenerator` (Streamable HTTP, `enableJsonResponse:true`), like the-reference. Per-request `Server` + `Transport`.
- **Auth = opaque bearer token**, constant-time compared. One token per instance in `~/.openhammer/credential.json` (0600); `MCP_AUTH_TOKEN` env overrides. No OAuth AS — only a `/.well-known/oauth-protected-resource` discovery pointer.
- **Filesystem root = `MCP_ROOT_DIR`** (default: launch cwd). Tool paths resolve via `resolveToCwd` (~ expansion + absolute pass-through). **Not hard-jailed** — the `bash` tool reaches anything the OS user can (documented; gated by the token). **For isolation, run OpenHammer in a container** with only the target dir mounted — that bounds what the shell can touch.
- **Output backstops:** per-tool truncation (2000 lines / 50KB; `bash` keeps the **tail**, `read` keeps the **head**) + a universal `MAX_RESPONSE_BYTES` (512KB) backstop that emits a `response_too_large` text block.
- **`rg` + `fd` required.** `grep` needs `rg` (ripgrep), `find` needs `fd`; both error with an install hint if absent (no auto-download, no Node fallback).
- **`--tunnel` is optional.** Spawns `cloudflared` quick-tunnel; falls back to localhost-only if the binary is missing.
- **Imports:** relative imports use **`.ts`** extensions (`./path-utils.ts`, via `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`); `import type` for type-only imports (`verbatimModuleSyntax`); `node:` protocol on every built-in (`useNodejsImportProtocol`). Details in `docs/coding-standards.md`.

## Codebase Patterns

- **Read `docs/coding-standards.md` — it applies to every task.** Shared utilities live in `src/tools/` (`result.ts`, `io.ts`, `path-utils.ts`, `truncate.ts`, `output-accumulator.ts`, `edit-diff.ts`, `bin.ts`) — this project's "standard library." Tools are plain `ToolModule` objects (`{ name, description, inputSchema, execute(args, rootDir) → Promise<Result<ToolOk>> }`); `src/tools/index.ts` → `createAllTools(rootDir): McpToolEntry[]`.
- **Port tool execute logic from pi verbatim** (schemas + behavior), stripping all `@earendil-works/pi-*` and TUI (`pi-tui`) coupling. Authoritative upstream: `/home/haz/source/pi/packages/coding-agent/src/core/tools/` (a vendored copy may live in `./pi/`, which is gitignored). Convert pi's **throws to `err(...)`** (Result model); use `src/tools/io.ts` wrappers over throwing `node:fs`/`spawn` so tool bodies have zero try/catch.
- **Copy MCP wiring from the-reference**: `src/mcp-server/{server,http-transport,types}.ts`, boot in `src/api/server.ts`. Authoritative upstream: `/home/haz/source/redacted/the-reference/`. Key pattern: per-request `StreamableHTTPServerTransport({ enableJsonResponse:true })`, flush Fastify headers to `reply.raw`, `transport.handleRequest(req.raw, reply.raw, body)`, `reply.hijack()`.
- **No `Operations` interface seams** — every tool is a direct local implementation, and none is planned. `bash` runs natively wherever OpenHammer runs, so isolation is a deployment choice, not a code path: **run OpenHammer inside a Docker container** (mount only the target dir, set `MCP_ROOT_DIR` to it) and the container *is* the sandbox. No `--sandbox` mode.
- **Tool/resource surface only — never host the agent loop.** OpenHammer executes tools and (later, step two) serves agent definitions as MCP resources/prompts; the **MCP client (the LLM provider) owns the agent loop, model calls, and compaction.** Do not add an in-server LLM loop, provider integration, or session-state. See `specs/99-roadmap-agent-harness.md` and `docs/agent-harness-design.md`.
- **Error model — Result, not throws.** Tool `execute` returns `Promise<Result<ToolOk, Error>>` (`ok({ content })` / `err(new Error(msg))`); expected failures never throw. The MCP `CallTool` handler is the single narrowing point (`if (!r.ok) return { content:[{type:"text", text:r.error.message}], isError:true }`) with a fallback `try/catch` only for genuine bugs. Exceptions remain at framework boundaries (Fastify `reply`, SDK transport, boot). Full rules: `docs/coding-standards.md`.
- `src/mcp/server.ts` applies the universal `MAX_RESPONSE_BYTES` backstop (replace oversized content with a single `response_too_large` text block) on every `tools/call` success.
