# OpenHammer — Implementation Plan

> A standalone MCP server with **no LLM** that mints a per-instance bearer token and exposes pi's 7 local shell/filesystem tools (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) to a remote agent over Fastify + stateless Streamable HTTP, rooted at `MCP_ROOT_DIR`, gated by the credential, with an optional cloudflared quick-tunnel.
>
> **Source of truth:** `specs/01`–`specs/16` (15 = testing strategy, 16 = containerized E2E). Porting references: tool execute logic ← `/home/haz/source/pi/packages/coding-agent/src/core/tools/`; MCP/Fastify wiring ← `/home/haz/source/redacted/the-reference/src/{mcp-server,api}/`. **Spec `99` (agent harness) is explicitly OUT OF SCOPE for v1 — no tasks from it here.**

## How to read this plan

- Each `- [ ]` checkbox is **ONE iteration** for a fresh-context AI — one file (or one small cohesive change to a single file), tests folded in.
- Tasks are in **strict dependency order**; pick the first unchecked box. Each item lists: spec ref, target file, porting source, deps (item numbers), and a one-line scope.
- Validation trio must pass before checking off any task: `npm test` (vitest `--passWithNoTests`; hermetic Tiers 0–2 — units + in-process MCP E2E + boot E2E), `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit` — covers `src` **and** `test`), `npm run lint` (`biome check src test`). Containerized tiers (`test:compose`, `test:in-container`, gated `test:tunnel`) are on-demand/non-blocking — see specs 15/16 and the **Testing & pipeline** section below.
- **Conventions (apply everywhere — see `docs/coding-standards.md`):** `.ts` relative import extensions; `import type` for type-only imports; `node:` on every built-in; tabs / indent 3 / lineWidth 120 / double quotes; **Result error model** (tool `execute` → `Promise<Result<ToolOk, Error>>`; expected failures return `err(new Error(msg))`, never throw; the MCP `CallTool` handler is the single narrowing point); plain `Error` (no custom error classes).

## Status snapshot

**Scaffold done (spec 01, `01-scaffold-a`–`d`):** `package.json`, `tsconfig.json`, `biome.json`, `.env.example`, `vitest.config.ts`, and `src/` are in place. **`01-config` done:** `src/config.ts` + `src/config.test.ts` shipped (first source file + first tests); the earlier `TS18003`/`biome "no files"` transient is cleared and the full trio is green. No `test/` dir yet — first E2E tests land in `T-harness`/`T-canary`.

### Project scaffold (spec 01)

- [x] **01-scaffold-a.** `package.json` (deps `fastify`/`@fastify/cors`/`@modelcontextprotocol/sdk`; devDeps `typescript`/`tsx`/`vitest`/`@types/node`/`@biomejs/biome`/`pino-pretty`; scripts build/start/dev/test/typecheck/lint/format; `engines.node >=20`) + `npm install` — spec 01
- [x] **01-scaffold-b.** `tsconfig.json` (NodeNext, `.ts` import extensions via `allowImportingTsExtensions`+`rewriteRelativeImportExtensions`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, strict knobs) — spec 01
- [x] **01-scaffold-c.** `biome.json` (tabs, indentWidth 3, lineWidth 120, double quotes; `useConst`/`useNodejsImportProtocol`/`noExplicitAny`=error, `noNonNullAssertion`=off; `organizeImports:on`) — spec 01
- [x] **01-scaffold-d.** `.env.example` (PORT/HOST/MCP_ROOT_DIR/MCP_AUTH_TOKEN/MCP_MAX_RESPONSE_BYTES/LOG_LEVEL) + `vitest.config.ts` + empty `src/` skeleton (subdirs created by their first file) — spec 01

---

## Build tasks (in dependency order)

### Config (spec 01)

- [x] **01-config.** `src/config.ts` — `Config` interface + `loadConfig(env = process.env)` (coerce PORT/MCP_MAX_RESPONSE_BYTES with `Number()`; `rootDir = path.resolve(MCP_ROOT_DIR || process.cwd())`; defaults port 3000 / host `127.0.0.1` / maxResponseBytes 512000 / logLevel `info`; do **not** fail boot if `rootDir` missing). + unit tests (`loadConfig({})` → defaults; `loadConfig({PORT:"4242",MCP_ROOT_DIR:"/tmp/x"})` → coerced). *deps: 01-scaffold-a.*

### Shared utilities (spec 02) + tool types (spec 10-types)

- [x] **02a.** `src/tools/result.ts` (NEW) — `Result<T,E=Error>` + `ok`/`err`/`map`/`andThen`/`getOrElse`/`combine`; pure, no imports. + tests (success propagation, `combine` short-circuit on err). *deps: none. Most-imported module — do first.*
- [x] **02c.** `src/tools/truncate.ts` — verbatim port from `pi/.../tools/truncate.ts` (`DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50*1024`, `GREP_MAX_LINE_LENGTH=500`, `formatSize`, `truncateHead`, `truncateTail`, `truncateLine`, types). + tests (`truncateHead` 3000→2000 lines; 60KB single line → `firstLineExceedsLimit`; `truncateTail` keeps last 2000; `formatSize(512*1024)`→`"512.0KB"`). *deps: none.*
- [x] **02d.** `src/tools/path-utils.ts` — verbatim port from `pi/.../tools/path-utils.ts` (`expandPath`, `resolveToCwd`). **Do NOT port `resolveReadPath`'s macOS screenshot variants.** + tests (`resolveToCwd("~/x","/root")`→`/root/x`; relative→under cwd; absolute passes through). *deps: none.*
- [x] **02b.** `src/tools/io.ts` (NEW) — Result-wrappers over `node:fs`/`node:fs/promises` (**fs surface only — NOT spawn**): `readFile`/`access`/`stat`/`statSync`/`readdir`/`readdirSync`/`writeFile`/`mkdir`/`exists`. + tests (success + errno-failure → `err` with `Error`). *deps: 02a.*
- [x] **02e.** `src/tools/output-accumulator.ts` — verbatim port from `pi/.../tools/output-accumulator.ts`. **Change `tempFilePrefix` `"pi-output"` → `"openhammer"`.** + tests (feed >50KB then `snapshot({persistIfTruncated:true})` → truncated tail + non-empty `fullOutputPath`). *deps: 02c.*
- [x] **10-types.** `src/mcp/types.ts` (NEW) — `ToolContent` (text|image), `ToolOk`, `ToolModule` (name/description/inputSchema/`execute(args,rootDir)→Promise<Result<ToolOk>>`), `McpToolEntry` (`{tool, handler}`). Imports `Tool` from `@modelcontextprotocol/sdk/types.js`, `Result` from `../tools/result.ts`. + tests (type-level; can be a trivial smoke test). *deps: 02a. Precedes every tool module — they all export a `ToolModule`.* **Deviation recorded:** `ToolModule.inputSchema` is typed `Tool["inputSchema"]` (SDK's JSON-Schema-object type), **not** `Record<string, unknown>` — the SDK's `Tool.inputSchema` requires `type:"object"` as a literal, so the spec's literal `Record<string, unknown>` (which has `type: unknown`) made the spec's own `createAllTools` fail `tsc`. Reusing `Tool["inputSchema"]` is single-source-of-truth and lets `createAllTools` lift it onto `tool.inputSchema` with **no `as` cast** (10-index ships as-written). Its `[x:string]: unknown` index keeps it permissive for every tool's hand-written inline literal. Spec 10 updated to match.

### Tools (specs 03–09)

- [x] **03a.** `src/tools/read.ts` — port `execute` text path from `pi/.../tools/read.ts`: `resolveToCwd` → access → UTF-8 read → `split("\n")` → offset/limit slice → `truncateHead` + continue/limit notices. **Strip** pi's `resolveReadPath`/compact-read/`getReadmePath`/theme/resize/magic-byte detection. **No line numbers.** + tests (full read, 3000-line→offset notice, offset/limit window, offset-past-EOF→err, missing→err). *deps: 02c, 02d, 10-types. Port source: `pi/.../tools/read.ts`.* **Convention set:** each `ToolModule` is a named export named `<tool>Tool` (e.g. `readTool: ToolModule`) — `10-index` imports the 7 this way. Image path (03b) not included here.
- [ ] **03b.** `src/tools/read.ts` (2nd pass) — add image content-block path: extension detection (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`) → base64 image block + `Read image file [mime]` text note; no resize (oversized caught by `MAX_RESPONSE_BYTES`). + tests (`pic.png` → text+image blocks). *deps: 03a.*
- [ ] **04.** `src/tools/bash.ts` — port `execute` + local exec body from `pi/.../tools/bash.ts`: shell `$SHELL||"bash"`, spawn `[shell,"-c",cmd]` (`cwd:rootDir`, `detached` off-win32, merged stdout+stderr into `OutputAccumulator({tempFilePrefix:"openhammer"})`, timeout/abort → `process.kill(-pid,"SIGKILL")`, exit≠0→`err`, tail-truncation footer with `Full output:` path, `(no output)` default). **Strip** `getShellConfig`/`trackDetachedChildPid`/`commandPrefix`/`spawnHook`/render. + tests (`echo hello && pwd`; `exit 3`→err; `yes|head -c 2000000`→tempfile footer; `sleep 30, timeout:1`→timeout err + dead child). *deps: 02c, 02e, 10-types. Port source: `pi/.../tools/bash.ts`.*
- [ ] **05.** `src/tools/write.ts` — port `execute` from `pi/.../tools/write.ts`: `resolveToCwd` → `mkdir(dir,{recursive:true})` → `writeFile(utf-8)` → `Successfully wrote ${len} bytes to ${path}`. **Strip** `withFileMutationQueue`/`WriteOperations`/render. + tests (parent-dir creation, overwrite, write→read round-trip, abs/rel resolution). *deps: 02d, 10-types. Port source: `pi/.../tools/write.ts`.*
- [ ] **06a.** `src/tools/edit-diff.ts` — port the apply path only from `pi/.../tools/edit-diff.ts`: `stripBom`, `detectLineEnding`, `normalizeToLF`, `restoreLineEndings`, `normalizeForFuzzyMatch`, `fuzzyFindText`, `applyEditsToNormalizedContent`, `countOccurrences`, error builders. **`applyEditsToNormalizedContent` returns `Result<{baseContent,newContent},Error>` (never throws).** **Do NOT port** `generateDiffString`/`generateUnifiedPatch`/`computeEditsDiff` (no `diff` dep). + tests (match, not-found, duplicate, overlap, fuzzy-trailing-ws, no-change; BOM/CRLF preserved). *deps: 02a. Port source: `pi/.../tools/edit-diff.ts`.*
- [ ] **06b.** `src/tools/edit.ts` — port `execute`+`validateEditInput`+`prepareEditArguments` from `pi/.../tools/edit.ts`: tolerate `edits` as JSON string / legacy `{oldText,newText}`; access R_OK|W_OK→`Could not edit file…`; read→stripBom→detectLineEnding→normalize→`applyEditsToNormalizedContent`→restoreLineEndings→write → `Successfully replaced ${edits.length} block(s) in ${path}.`. **Strip** render/`EditOperations`. + tests (single, multi-disjoint, non-unique→err, not-found→err, overlap→err, fuzzy, BOM/CRLF round-trip). *deps: 06a, 02d, 10-types. Port source: `pi/.../tools/edit.ts`.*
- [ ] **07a.** `src/tools/bin.ts` (NEW) — `isToolAvailable(name): boolean` via `spawnSync(name,["--version"],{stdio:"ignore"})`→exit 0. + tests (present + PATH-stripped→false). *deps: none. Shared by grep/find/tunnel.*
- [ ] **07b.** `src/tools/grep.ts` — port `execute` from `pi/.../tools/grep.ts`: `isToolAvailable("rg")`→else `err` install hint; `resolveToCwd`; build rg args (`--json --line-number --color=never --hidden` + flags); spawn + parse NDJSON `match` events to cap `limit`; exit 1 on no-match is OK; format `path:line: text` (+ context block when `context>0`); `truncateHead` byte-cap + notices. **Replace `ensureTool` with `isToolAvailable`. Strip** render/`GrepOperations`. + tests (TODO matches; ignoreCase/literal; no-match; rg-missing→err; limit notice). *deps: 07a, 02c, 02d, 10-types. Port source: `pi/.../tools/grep.ts`.*
- [ ] **08.** `src/tools/find.ts` — port `execute` from `pi/.../tools/find.ts`: `isToolAvailable("fd")`→else `err`; `resolveToCwd`; build fd args (`--glob --color=never --hidden --no-require-git --max-results`); pattern-with-slash handling (`--full-path` + `**/` prefix rewrite); spawn→lines; relativize/POSIX/trailing-`/`; cap + notices. **Replace `ensureTool` with `isToolAvailable`. Strip** render/`FindOperations`. + tests (`**/*.ts`; basename `*.json`; no-match; fd-missing→err; limit notice). *deps: 07a, 02c, 02d, 10-types. Port source: `pi/.../tools/find.ts`.*
- [ ] **09.** `src/tools/ls.ts` — port `execute` from `pi/.../tools/ls.ts`: `resolveToCwd`; `existsSync`→`Path not found`; `isDirectory`→else `Not a directory`; `readdirSync` + case-insensitive sort + `/` suffix on dirs + stat-skip; `(empty directory)`; `truncateHead` byte-cap + notices. **Strip** render/`LsOperations`. + tests (alpha sort + `/` + dotfiles; empty; file→err; missing→err; >500→notice). *deps: 02c, 02d, 10-types. Port source: `pi/.../tools/ls.ts`.*

### Registry (spec 10-index)

- [ ] **10-index.** `src/tools/index.ts` — `createAllTools(rootDir): McpToolEntry[]`: import the 7 `ToolModule`s, map each to `{tool:{name,description,inputSchema}, handler:(args)=>m.execute(args??{},rootDir)}`. + test (`createAllTools("/srv")` → exactly 7 entries with names `read,bash,edit,write,grep,find,ls`; handler returns a `Result<ToolOk>`). *deps: 10-types + 03–09.*

### Auth (spec 11)

- [ ] **11a.** `src/auth/token.ts` — `ensureToken(config)`: if `config.authToken` set → return it (no file touch); else read `~/.openhammer/credential.json`; if valid reuse, else mint `crypto.randomBytes(32).toString("base64url")` + `createdAt` + `mkdir` + `writeFileSync({mode:0o600})`. Throw on unwritable dir. + tests (mint→~43-char + 0600; reuse; override; no-file-write when override set). *deps: 01-config.*
- [ ] **11b.** `src/auth/middleware.ts` — `createAuthMiddleware(token, config): FastifyPreHandler`: parse `Authorization: Bearer <v>`; equal-length decode + `crypto.timingSafeEqual` (length-mismatch short-circuits); on miss/mismatch → `reply.code(401)` + `WWW-Authenticate: Bearer realm="openhammer", resource_metadata="<baseUrl>/.well-known/oauth-protected-resource"` + JSON-RPC error body. `baseUrl` from `${req.protocol}://${req.host}` with fallback `http://${config.host}:${config.port}`. + tests (no-auth→401; wrong→401; correct→proceeds; timing-safe length handling). *deps: 01-config.*
- [ ] **11c.** `src/mcp/well-known.ts` — `registerWellKnown(fastify, baseUrl)`: `GET /.well-known/oauth-protected-resource` (no auth) → `{resource:"<baseUrl>/mcp", bearer_methods:["header"]}`. + test (200 + body, no auth). *deps: none.*

### MCP server, transport, Fastify (spec 12)

- [ ] **12a.** `src/mcp/server.ts` — `createMcpServer(rootDir, maxResponseBytes): Server` (copy/ adapt `the-reference/src/mcp-server/server.ts`): `new Server({name:"openhammer",version:<pkg>},{capabilities:{tools:{}}})`; `ListTools` → `entries.map(e=>e.tool)`; `CallTool` → find by name (unknown→`isError` text), narrow `Result` with **fallback try/catch** (genuine bugs → `err`), apply universal size backstop on success (`sum Buffer.byteLength` text + image `data.length`; over cap → replace whole content with one `response_too_large` JSON text block). + tests (ListTools=7; unknown tool→isError; err→isError no-throw; backstop fires on >cap). *deps: 10-index, 02a, 10-types. Copy source: `the-reference/.../mcp-server/server.ts`.*
- [ ] **12b.** `src/mcp/http-transport.ts` — `mcpHttpRoutes(fastify,{token,config})` plugin (copy `the-reference/.../mcp-server/http-transport.ts`): `POST /mcp` with auth `preHandler` (only on POST) → per-request `createMcpServer` + `new StreamableHTTPServerTransport({enableJsonResponse:true})` (**no `sessionIdGenerator`**), `reply.raw.once("close")` cleanup, `server.connect(transport as unknown as Transport)`, flush Fastify headers onto `reply.raw`, `transport.handleRequest(req.raw, reply.raw, req.body)`, `return reply.hijack()`. `GET /mcp`→405, `DELETE /mcp`→405. + integration test against a real Fastify (tools/list via transport; auth gating; 405s). *deps: 12a, 11b. Copy source: `the-reference/.../mcp-server/http-transport.ts`.* **→ activates Tier-1 in-process E2E** (`T-mcp-e2e`): a real SDK `Client` drives all 7 tools over `POST /mcp` on port 0, asserts auth 401 + the `MAX_RESPONSE_BYTES` backstop.
- [ ] **12c.** `src/server.ts` — `buildFastify(config, token): Promise<FastifyInstance>` (copy `the-reference/.../api/server.ts`): `Fastify({logger:{level, transport:pino-pretty in dev}})`; `@fastify/cors` (`origin:true,credentials:true,methods:[...],exposedHeaders:["Mcp-Session-Id","Mcp-Protocol-Version","WWW-Authenticate",...]`); `GET /health`→`{status:"ok"}`; `registerWellKnown(fastify, baseUrl)`; register mcp routes plugin; global error + 404 handlers; **return `fastify` WITHOUT calling `listen`** (spec 12 edit — `main.ts` owns binding/lifecycle; this is what lets Tier-1 tests bind port 0 and Tier-2 tests control shutdown). + test (`buildFastify(...)` then `listen({port:0})` → `GET /health` 200 no-auth; close cleanly). *deps: 01-config, 11c, 12b. Copy source: `the-reference/.../api/server.ts`.*

### Tunnel (spec 13)

- [ ] **13.** `src/tunnel/cloudflare.ts` — `startTunnel(port): Promise<{url,child}|null>`: `isToolAvailable("cloudflared")`→else `null` (no throw); `spawn("cloudflared",["tunnel","--url",`http://localhost:${port}`,"--no-autoupdate"])`; regex-scan **stderr** for `https://[a-z0-9-]+\.trycloudflare\.com`; ~15s timeout→kill+`null`; early child death→`null`; return `{url,child}`. + tests (presence-check branches; URL regex parsing; mock spawn). *deps: 07a.* **→ activates Tier-4 tunnel E2E** (`T-tunnel-e2e`): gated `npm run test:tunnel` spins up the compose `tunnel` profile and drives a `tools/call` round-trip through the public `trycloudflare.com` URL.

### Boot (spec 14)

- [ ] **14a.** `src/startup-print.ts` — `printStartup({localUrl, tunnelUrl, token})`: print local `/mcp` URL, tunnel URL (if any), token (once), ready-to-paste `mcpServers` JSON (`{"type":"http","url":"<localUrl>/mcp","headers":{"Authorization":"Bearer <token>"}}`), credential-file path + reuse note. + tests (emits URL + token + parseable `mcpServers` JSON; tunnel URL omitted when absent). *deps: none.*
- [ ] **14b.** `src/main.ts` — `loadConfig()` → `ensureToken(config)` → parse argv `--tunnel` → `buildFastify(config,token)` → **`await fastify.listen({port:config.port,host:config.host})`** → if tunnel `startTunnel(config.port)` (null→log localhost-only) → `printStartup(...)` → `SIGINT`/`SIGTERM` handlers (`fastify.close()`, kill `t?.child`, `process.exit(0)`). *deps: 01-config, 11a, 12c, 13, 14a.* **→ activates Tier-2 boot E2E** (`T-boot-e2e`: spawn the entrypoint, assert `/health`, token reuse across two boots, clean `SIGINT`/`SIGTERM`) **and Tier-3 real compose** (`T-real-compose`: `test:compose:real` retargets the runner at the real `server` service for all 7 tools). The manual `npm start` smoke remains as a one-time human check.

---

## Testing & pipeline (specs 15 + 16)

**Deterministic, no LLM.** The "real MCP client" is the official `@modelcontextprotocol/sdk` `Client`
driven by a script that asserts on `callTool` text. Five tiers build on each other — Tier N only exists
once Tier N−1's underlying code has shipped:

| Tier | Proves | Runs via | Activates |
|---|---|---|---|
| 0 Unit | each tool's `execute → Result` directly | `npm test` | every tool task 03–09 |
| 1 In-process MCP | SDK client ↔ `buildFastify` on port 0 (init/list/call, auth 401, backstop) | `npm test` | `12b` |
| 2 Boot | spawn entrypoint; `/health`, token reuse, clean shutdown | `npm test` | `14b` |
| 3 Containerized | real image + runner on a Docker network | `npm run test:compose` | fixture now; real server `14b` |
| 4 Tunnel | runner through the public `trycloudflare.com` URL | `npm run test:tunnel` (gated) | `13` |

**Fast path (every iteration):** hermetic trio — `npm test` (Tiers 0–2), `npm run typecheck` (`tsconfig.json` + `tsconfig.test.json`), `npm run lint` (`biome check src test`). Green on any Node 20+ box; `loop.sh` unchanged.
**Container path (on-demand, non-blocking):** `npm run test:compose`, `npm run test:in-container` (`docker compose run --rm dev npm test`), `npm run test:tunnel` (gated on `OPENHAMMER_TUNNEL_E2E=1` + `cloudflared`).

### Test-pipeline foundation (no src deps — can land alongside the scaffold)

- [ ] **T-harness.** `vitest.config.ts` (include `src/**` + `test/e2e-hermetic/**`); `tsconfig.test.json` (typechecks `src`+`test`, no `rootDir`); `package.json` (`typecheck` + `lint`/`format` cover `test`; `test:compose`/`test:in-container`/`test:tunnel` scripts); `scripts/test-tunnel.sh`; `.gitignore`/`.env.example`. *deps: 01-scaffold-a.*
- [ ] **T-canary.** `test/e2e-hermetic/harness.canary.test.ts` + `test/fixtures/minimal-mcp-server.ts` — Tier-1 walking skeleton: SDK client ↔ in-process fixture on port 0 (connect/listTools/callTool, missing+wrong bearer 401, backstop). *deps: T-harness.*
- [ ] **T-dockerfile.** `Dockerfile` (multi-stage `dev`/`build`/`prod`) + `.dockerignore`. *deps: none.*
- [ ] **T-compose.** `docker-compose.yml` (`dev` profile-gated, `fixture-server` w/ healthcheck, `test-runner` depends_on healthy, `server` profile=real, `cloudflared` profile=tunnel) + `test/compose/run-e2e.ts`; `npm run test:compose` green (fixture). *deps: T-dockerfile, T-canary.*

### Higher tiers (dependency-ordered; each is its own iteration)

- [ ] **T-mcp-e2e.** `test/e2e-hermetic/mcp.e2e.test.ts` — Tier-1 real: swap the fixture for real `buildFastify`; drive all 7 tools over `POST /mcp` (port 0) + assert auth 401 + `response_too_large` backstop. *deps: 12b.*
- [ ] **T-boot-e2e.** `test/e2e-hermetic/boot.e2e.test.ts` — Tier-2: spawn entrypoint via `tsx`, assert `/health`, token reuse across two boots, clean `SIGINT`/`SIGTERM` (no orphan tunnel child). *deps: 14b.*
- [ ] **T-real-compose.** `server` (profile `real`) + retarget `test/compose/run-e2e.ts` at `http://server:3000/mcp` with all 7 tools; add `test:compose:real` script. *deps: 14b, T-compose.*
- [ ] **T-tunnel-e2e.** Wire `scripts/test-tunnel.sh` → compose `tunnel` profile: real `server` + `cloudflared`, parse `trycloudflare.com` URL from stderr, runner drives a `tools/call` through the public URL. Gated/non-blocking. *deps: 13, T-real-compose.*

---

## Notes & risks for implementers

- **MCP SDK import paths resolve under NodeNext.** The SDK's `exports` map exposes a `./*` wildcard → `dist/esm/*`, so `@modelcontextprotocol/sdk/server/index.js`, `/types.js`, `/server/streamableHttp.js`, `/shared/transport.js` all resolve (files exist; the-reference uses the same paths). Use them verbatim.
- **Per-request `Server` + `Transport`, no `sessionIdGenerator`** (stateless, like the-reference). `server.connect(transport as unknown as Transport)` cast absorbs SDK optional-callback type friction.
- **Header flush before `handleRequest`** is required or `@fastify/cors` expose-headers never reach the wire (browsers then strip the response). Copy the-reference' flush loop exactly.
- **`MAX_RESPONSE_BYTES` backstop replaces the ENTIRE content** (text or image) with one `response_too_large` JSON text block — a structured error, never a silent truncation. Compute bytes as text `Buffer.byteLength` + image `data.length`.
- **Result model is the spine.** Tool `execute` never throws for expected failures; only the `CallTool` handler narrows, and its `try/catch` is a bug safety-net only. Spawn-based tools (`bash`/`grep`/`find`/tunnel) manage their own streaming and return `Result` at the end — they do **not** use `io.ts` (fs-surface only).
- **`rg` + `fd` + `cloudflared` are presence-checked at runtime** (via `isToolAvailable`) with graceful `err`/`null` — no auto-download, no Node fallback, no install-time hard dep.
- **Image support is extension-based, no `sharp`** (no resize; oversized images hit the backstop). **No `diff`/`jose`/`sharp`/`dotenv` deps** — do not add them.
- **`npm audit` reports 5 high-severity advisories in `fast-uri`** (path-traversal/host-confusion), transitive via `fastify@4` → `@fastify/ajv-compiler`/`fast-json-stringify`. The only fix is `fastify@5` (breaking major; needs `@fastify/cors@10` + API changes). `the-reference` (the porting reference) is on the same `fastify@4.x`, and all MCP/Fastify wiring is copied against v4 — so this is a **deliberate, deferred** major bump, not a scaffold concern. Do **not** `npm audit fix --force` (it major-bumps fastify and breaks the port). Revisit after v1 ships.

- **Biome 2.5 field note.** `linter.rules.recommended: true` is **deprecated** in Biome 2.5 (`biome check` warns on every run); use `linter.rules.preset: "recommended"` instead (`enum: recommended|all|none`). `01-scaffold-c` ships the non-deprecated form. This satisfies spec 01's "`recommended` preset" wording (field-agnostic) — do not hand-edit it back to `recommended: true`.


- **Spec `99` (filesystem-defined agent harness)** — future step-two design record. Do **not** implement or add tasks for it. v1 already keeps the door open (extensible `Server` capabilities, 7 fs/bash tools, truncation/backstop reused). Promote to specs 15+ only after v1 ships and is verified end-to-end with a real MCP client.
- No LLM / agent loop / provider integration / session state. No `Operations` interface seams. No `--sandbox` mode (isolation = containerize). No OAuth AS (only the well-known discovery pointer).
