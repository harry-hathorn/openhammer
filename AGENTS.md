# AGENTS.md

Guidance for the build loop (`loop.sh` + `PROMPT_build.md`) and any AI agent in this repo.
Imperative and non-negotiable unless a line says otherwise. Chat instructions override this file;
this file overrides your defaults. Detail/rationale lives in `docs/coding-standards.md` — this is the
high-signal distillation that applies to **every** iteration.

> Keep this file high-signal. Add a rule only when an agent would otherwise get it wrong; delete rules
> that stop earning their place. Do **not** restate the specs or architecture here — agents read the repo.

---

## Setup & commands

- Package manager: **`npm`** (NOT pnpm/yarn — the whole pipeline is npm: `Dockerfile` `npm ci`, `package-lock.json`, scripts).
- Install: `npm install` · Dev (watch): `npm run dev` · Build: `npm run build` · Start: `npm start`
- **Validation trio (run before declaring done):** `npm run typecheck` · `npm run lint` · `npm test`.

Run all three until green before checking off a task. Fix the errors you introduce; do not suppress them.

## The build loop (how this repo ships)

- **One `- [ ]` checkbox in `IMPLEMENTATION_PLAN.md` = one iteration = one commit.** Pick the first unchecked box whose `deps:` are done, implement it **fully** (no stubs/placeholders), validate, check off **exactly one** box, commit, tag, write `.loop-complete`, stop. Fresh context per iteration.
- **Conventional Commits**: `feat:`/`fix:`/`chore:`/`docs:`/`test:`/`refactor:` (optionally scoped, e.g. `feat(read): …`). Plain message, imperative, ≤72-char subject. **No AI-attribution trailers.**
- The trio is the gate. Containerized tiers (`test:compose` etc.) are non-blocking extras — see *Testing*.

## Hard constraints (do not violate)

- **No LLM.** OpenHammer only executes tools; the agent loop lives in the MCP client (the LLM provider).
- **Node ≥20, ESM** (`"type":"module"`), TypeScript `strict`. Do not relax `tsconfig`. Node 22 LTS is the dev/CI runtime.
- **No dependency without a clear need; prefer the `node:` standard library.** No `jose`/`sharp`/`dotenv`/`diff`/`zod`.
- **Stateless MCP**: per-request `Server` + `Transport`, no `sessionIdGenerator` (Streamable HTTP, `enableJsonResponse:true`).
- **Isolation = containerize** (mount the target dir, set `MCP_ROOT_DIR`); not hard-jailed — `bash` reaches anything the OS user can, gated by the bearer token.
- Do not hand-edit `dist/`, the lockfile, or generated files.

## TypeScript rules

**Types**
- **Never `any`.** Use `unknown` at boundaries; narrow with a type guard (`if (e.type === "match")`). No `{}` type — use `unknown`/`Record`/`object`.
- **Discriminated unions for mutually-exclusive states** — the `Result` type *is* this (`{ ok:true; value } | { ok:false; error }`). Make `switch` over a union exhaustive (`default: assertNever(x)`).
- **`interface` for object shapes; `type` for unions/intersections/mapped.** No `enum` (`erasableSyntaxOnly` bans them — use a `const` object + derived union).
- **Assertions/non-null**: prefer runtime narrowing (`instanceof`, type guards) over `as`/`!`. **Documented exceptions (pi fidelity + SDK friction):** `!` is allowed (biome `noNonNullAssertion: off` — pi uses it); `as unknown as Transport` in the MCP transport wiring is required (SDK optional-callback type friction) — add a why-comment.
- **`noUncheckedIndexedAccess` is deferred (off)** for the port — it fights a pi port's heavy indexing; flip it on in a consolidation pass after v1.

**Validation & boundaries**
- Validate external input (env, CLI args, file contents, JSON) **at the boundary, by hand** (no `zod` — standard library only). See `src/config.ts`. Inside the trusted core, assume validated; don't re-check.

**Errors (the Result spine)**
- Tool `execute → Promise<Result<ToolOk, Error>>`. Expected failures return `err(new Error(msg))`, **never throw**; success returns `ok({ content })`.
- The MCP `CallTool` handler is the single narrowing point (`if (!r.ok) return { content:[{type:"text", text:r.error.message}], isError:true }`) with a fallback `try/catch` only for genuine bugs.
- Throw only `new Error(…)` (or a subclass) — never strings/objects. Exceptions stay at framework boundaries (Fastify `reply`, SDK transport, boot).
- No empty `catch`. `catch (e)` is `unknown` — narrow before use.

**Functions & data**
- Prefer pure functions; treat parameters as `readonly`. No default exports from OpenHammer's own modules (named exports); importing pi/fastify defaults is fine.

## Style (biome — do NOT change; pi fidelity)

- **Tabs, indent 3, lineWidth 120, double quotes.** NOT 2-space / single-quote. These match pi so **verbatim ports pass `biome check` unchanged** — do not "fix" them. (This is the deliberate divergence from the Google TS guide.)
- `useConst`/`useNodejsImportProtocol`/`noExplicitAny` = error. `node:` on every built-in.
- Relative imports use **`.ts`** extensions (`./path-utils.ts`); `import type` for type-only (`verbatimModuleSyntax`). **No `@/` path aliases** — relative `.ts` only (pi fidelity).

## Modules & structure (layer-based, mirrors pi)

- `src/{tools,mcp,auth,tunnel}`, `src/config.ts`, `src/server.ts`, `src/main.ts`, `src/startup-print.ts`.
  **Not** feature-first — layer-based to mirror pi for verbatim porting. `src/tools/` is the project's standard library (`result`/`io`/`path-utils`/`truncate`/`output-accumulator`/`edit-diff`/`bin`).
- Co-locate `*.test.ts` next to the source. No circular imports; no wide barrel files.
- **No `Operations` interface seams** (locked: every tool is a direct local implementation).

## Porting (the core of the work)

- Port tool `execute` **verbatim** from `pi/.../core/tools/<x>.ts`; strip `@earendil-works/pi-*`, `pi-tui`, `ToolDefinition`/render, every `*Operations` seam, `ensureTool`→`isToolAvailable`. Convert pi's throws → `err(...)` (mechanical; control flow unchanged).
- Use `src/tools/io.ts` Result-wrappers over throwing `node:fs` so tool bodies have **zero try/catch**.
- Wire MCP/Fastify per spec 12 (`src/mcp/server.ts`, `src/mcp/http-transport.ts`, `src/server.ts`) — stateless Streamable HTTP, per-request `Server` + `Transport`, bearer auth on POST `/mcp` only.

## Security & spawn hygiene

- Spawn `rg`/`fd`/`cloudflared` with **arg arrays** (never interpolate into a shell string) and **`--` before user-controlled operands** so a pattern like `-foo` can't become a flag. (`bash` is the intentional shell-string exception — its purpose, gated by the token.)
- Constant-time bearer compare; cred file `0600`; never log/secrets beyond the token.

## Exit codes, signals & async

- `main.ts`: exit **0** on clean `SIGINT`/`SIGTERM` shutdown; **non-zero** on boot failure (unwritable cred dir, `EADDRINUSE`) with an actionable message.
- `async/await` only. No floating promises — mark fire-and-forget `void p`. `Promise.all` for independent parallel work. Thread timeout/`AbortSignal` through I/O (bash timeout kills the detached process group).
- **Lockfile:** commit `package-lock.json` — the `Dockerfile` runs `npm ci`, which fails without it.

## Output backstops

- Per-tool truncation (2000 lines / 50KB; `bash` keeps the **tail**, `read` keeps the **head**) + universal `MAX_RESPONSE_BYTES` (512KB) backstop in `src/mcp/server.ts` → one `response_too_large` text block. Never return unbounded content.

## Toolchain notes

- `rg` + `fd` required at runtime (presence-checked via `isToolAvailable`, graceful `err`/`null` if missing — no auto-download, no Node fallback). `cloudflared` optional (`--tunnel`).
- Auth = opaque bearer token in `~/.openhammer/credential.json` (0600); `MCP_AUTH_TOKEN` overrides. No OAuth AS — only a `/.well-known/oauth-protected-resource` pointer.

## Naming

- `camelCase` vars/funcs · `PascalCase` types/classes · `UPPER_SNAKE` module constants. Booleans read as predicates (`isReady`, `hasAccess`, `shouldRetry`). Filenames lowercase (kebab for multi-word). No non-standard abbreviations.

## Testing (specs 15/16)

- **Trio (hermetic, every iteration):** Tier-0 units (`src/**/*.test.ts`), Tier-1 in-process MCP E2E, Tier-2 boot E2E (`test/e2e-hermetic/**`).
- **Containerized (on-demand, non-blocking):** `npm run test:compose`, `npm run test:compose:real`, `npm run test:in-container`, gated `npm run test:tunnel`.
- **Deterministic, no LLM** — the real client is the SDK `Client` asserting on `callTool` text. Each test independent/deterministic (fake timers/network); cover failure paths; add a regression test per bug.

## Definition of done (per checkbox)

1. `npm run typecheck` — no errors.
2. `npm run lint` — no errors.
3. `npm test` — green, including the test you added.
4. No new `any`; `!`/`as` only with the documented exceptions; no `@ts-ignore`/`eslint-disable`.
5. Conventional Commit; tag; **exactly one** box checked off.

## Project-specific conventions

- All MCP server/tool access goes through `src/mcp/server.ts` + `createAllTools(rootDir)`; tool paths resolve via `resolveToCwd` under `MCP_ROOT_DIR`.
- We use the `Result` type from `src/tools/result.ts` — do not install a Result library.
- Tool schemas are plain JSON-Schema object literals (no Typebox/zod).
