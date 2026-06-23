# OpenHammer — Coding Standards

> Applies to **every** task. Referenced from `AGENTS.md` (the high-signal distillation); this doc holds
> the detail/rationale. The reference codebase (pi for tools) sets the de facto
> style; this codifies the deliberate choices and deviations — including where we deliberately diverge from
> the Google TS guide and the nodejs-cli best-practices for the sake of **verbatim pi porting**.

## TypeScript & imports

- **NodeNext ESM.** Relative imports use **`.ts` extensions** (`import { resolveToCwd } from "./path-utils.ts";`) — enabled by `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (tsc rewrites to `.js` on emit). This is what makes ports from pi truly verbatim (pi's source imports `.ts`). **No `@/` path aliases** — relative `.ts` only.
- **`import type` for type-only imports** — enforced by `verbatimModuleSyntax`. Split mixed imports: values in `import`, types in `import type`.
- **`node:` protocol on every Node built-in** (`node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `node:os`, `node:child_process`, …) — enforced by biome `useNodejsImportProtocol`. pi is inconsistent here; we are not.
- **Strict knobs on:** `strict` + `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly` (no enums / runtime namespaces / parameter properties — use a `const` object + derived union), `forceConsistentCasingInFileNames`.
- **Deferred (off for now):** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Revisit once the port is green — `noUncheckedIndexedAccess` in particular fights a pi port (heavy indexing); flip it on in a consolidation pass.
- **No `{}` type** — use `unknown` (opaque), `Record<K,V>` (dictionary), or `object`. `{}` admits almost anything and hides missing properties.
- **`interface` for object shapes; `type` for unions/intersections/mapped/utility.** Model mutually-exclusive states as discriminated unions, not optional fields.

## Style (biome — matched to pi so verbatim ports pass `biome check` unchanged)

- **Tabs, indentWidth 3, lineWidth 120, double quotes.** `organizeImports: on`.
- ⚠️ **Do not "fix" these to match the Google TS guide** (which prescribes 2-space + single quotes). They exist so pi ports land byte-for-byte; switching them breaks the verbatim-port principle. `useConst` = error.
- **`noNonNullAssertion` is off** (pi uses `!`; revisit in the consolidation pass). This is a deliberate, documented exception to the "narrow, don't assert" rule below.

## Error model — Result in the domain, exceptions at the edges

- **Domain functions return `Result<T, E = Error>`** (`src/tools/result.ts`): `{ ok: true; value: T } | { ok: false; error: E }`. Constructors `ok(v)` / `err(e)`; helpers `map` / `andThen` / `getOrElse` / `combine`.
- **`E` defaults to `Error`** — plain `Error`, no custom error classes in v1. Read `.message`.
- **Tool `execute` returns `Promise<Result<ToolOk, Error>>`** and **never throws for expected failures** (file-not-found, non-zero exit, edit-text-not-found, `rg`/`fd`-not-installed, not-a-directory). Return `err(new Error(msg))`. A normal result is `ok({ content: [...] })`.
- **The MCP `CallTool` handler is the single narrowing point**: `if (!r.ok) return { content:[{type:"text", text:r.error.message}], isError:true }`, else apply the `MAX_RESPONSE_BYTES` backstop to `r.value.content`. It keeps a fallback `try/catch` *only* as a bug safety-net.
- **Exceptions remain for:** framework boundaries (Fastify `reply` + error handler, MCP SDK `handleRequest`/`connect`), `main.ts`/boot/process errors, and genuine bugs. Don't fight the frameworks.
- **Throw only `new Error(…)`** (or a subclass) — never strings/objects (no stack trace otherwise). `catch (e)` is `unknown` — narrow (`e instanceof Error`) before use. No empty `catch` blocks.
- **No `any`** (`noExplicitAny`). For external CLI JSON (`rg --json`, `fd` output), parse to `unknown` and narrow (`if (event.type === "match") …`) — never `let event: any`.

## Assertions & non-null — narrow over asserting

- Prefer **runtime narrowing** (`instanceof`, type guards, control flow) over `as` / `!`, which only silence the compiler and can crash at runtime.
- **Documented exceptions** (add a brief why-comment when you use them):
  - `!` non-null assertion — allowed because pi uses it and `noNonNullAssertion` is off for port fidelity.
  - `as unknown as Transport` in the MCP transport wiring — required (SDK declares optional callbacks without `| undefined`, clashing with our types; cast through `Transport`). Use `unknown` (never `any`) as the intermediate.
  - `as const` — always fine.
- Use a type **annotation** (`: Foo`) rather than an **assertion** (`as Foo`) on object literals — it catches renamed/extra fields instead of hiding them.

## Naming

- `camelCase` variables/functions/properties · `PascalCase` types/classes/interfaces · `UPPER_SNAKE_CASE` module-level constants (incl. enum-like `const` object values).
- Booleans read as predicates: `isReady`, `hasAccess`, `shouldRetry`, `canWrite`.
- No `I` prefix on interfaces; no `_` prefix for private (use TypeScript visibility). No Hungarian notation.
- Filenames lowercase; `kebab-case` for multi-word modules (`path-utils.ts`, `output-accumulator.ts`); tests `*.test.ts` co-located with the source. No non-standard abbreviations (`request` not `req`).

## Number parsing & coercion

- Use **`Number(x)`** to parse, then check **`Number.isNaN` / `!Number.isFinite`**. Never unary `+`; never `parseInt`/`parseFloat` except non-base-10 (then validate the charset first). See `src/config.ts` (`Number(env.PORT) || fallback`).
- Beware the `Number("")` / `Number(" ")` / `Number("\t")` → `0` (not `NaN`) gotcha — that's why the config fallback uses `||`.

## Async & concurrency

- `async/await` only; no raw `.then()` chains. **No floating promises** (`@typescript-eslint/no-floating-promises) — if fire-and-forget is intended, write `void promise` explicitly.
- `Promise.all` for independent parallel work; don't `await` sequentially when iterations are independent.
- Thread **timeout / `AbortSignal`** through I/O — the `bash` tool starts a timer and kills the detached process group (`process.kill(-pid, "SIGKILL")`) on timeout.

## Security — spawn hygiene & argument injection

- Spawn `rg` / `fd` / `cloudflared` with an **arg array** (`spawn(bin, [arg1, "--", pattern, path], …)`), **never** by interpolating user input into a shell string. Insert **`--`** before any user-controlled operand so a pattern like `-foo` (or a filename starting with `-`) can't be parsed as a flag.
- `bash` is the deliberate exception: it executes a shell string by design, gated by the bearer token.
- Constant-time bearer compare (`crypto.timingSafeEqual`, equal-length-buffer short-circuit); credential file mode `0600`; never log the token beyond the one-time boot print.

## Exit codes, signals & lockfile

- `main.ts` exits **0** on clean `SIGINT`/`SIGTERM` shutdown (closes Fastify, kills the tunnel child); **non-zero** on boot failure (unwritable cred dir, `EADDRINUSE`, etc.) with an actionable message.
- **Commit `package-lock.json`.** The `Dockerfile` runs `npm ci`, which fails without a lockfile; the containerized E2E depends on it.
- Small dependency footprint is a core principle: no `jose`/`sharp`/`dotenv`/`diff`/`zod`. Prefer the `node:` standard library.

## Tool shape

- Each tool is a plain `ToolModule` object `{ name, description, inputSchema, execute(args, rootDir) }`. `inputSchema` is a **plain JSON-Schema object literal** (no Typebox/zod — deliberate simplification vs pi). `createAllTools(rootDir)` wraps them into `McpToolEntry[]`.
- **All tool output funnels through the shared truncate utils** (`truncateHead` / `truncateTail` / `truncateLine`). Never return unbounded content; `MAX_RESPONSE_BYTES` is the outer net.
- Use the **`src/tools/io.ts` Result-wrappers** over throwing `node:fs` calls so tool bodies contain **zero try/catch** and compose with `andThen`/`map`. Spawn-based tools (`bash`/`grep`/`find`/tunnel) manage their own streaming and return `Result` at the end — they do **not** use `io.ts`.

## Porting from pi

- Port the **logic** verbatim from `pi/.../tools/<x>.ts`; strip `@earendil-works/pi-*`, `pi-tui`, `ToolDefinition`/render, every `*Operations` interface seam, and `ensureTool` (→ `isToolAvailable`).
- Convert pi's **throws to `err(...)`** at the point of failure (mechanical). The control flow ports unchanged; only the error signal changes.

## Tests

- Co-located `src/**/*.test.ts`. Assert on `result.ok` / `result.error` for expected failures — no `.rejects` / try-catch for the domain. Only genuine-throw paths use try/catch.
- Each test independent and deterministic: no shared mutable state, no reliance on order, fake timers/network. Cover failure paths, not just the happy path; add a regression test with every bug fix.
