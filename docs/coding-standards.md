# OpenHammer — Coding Standards

> Applies to **every** task. Referenced from `AGENTS.md` so each loop iteration reads it. The reference codebases (pi for tools, the-reference for MCP wiring) set the de facto style; this doc codifies the deliberate choices and deviations.

## TypeScript & imports

- **NodeNext ESM.** Relative imports use **`.ts` extensions** (`import { resolveToCwd } from "./path-utils.ts";`) — enabled by `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (tsc rewrites to `.js` on emit). This is what makes ports from pi truly verbatim (pi's source imports `.ts`).
- **`import type` for type-only imports** — enforced by `verbatimModuleSyntax`. Split mixed imports: values in `import`, types in `import type`.
- **`node:` protocol on every Node built-in** (`node:fs`, `node:fs/promises`, `node:path`, `node:crypto`, `node:os`, `node:child_process`, …) — enforced by biome `useNodejsImportProtocol`. pi is inconsistent here; we are not.
- **Strict knobs on:** `strict` + `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly` (no enums / runtime namespaces / parameter properties — use union types), `forceConsistentCasingInFileNames`.
- **Deferred (off for now):** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Revisit once the port is green — `noUncheckedIndexedAccess` in particular fights a pi port (heavy indexing); flip it on in a consolidation pass.

## Error model — Result in the domain, exceptions at the edges

- **Domain functions return `Result<T, E = Error>`** (`src/tools/result.ts`): `{ ok: true; value: T } | { ok: false; error: E }`. Constructors `ok(v)` / `err(e)`; helpers `map` / `andThen` / `getOrElse` / `combine`.
- **`E` defaults to `Error`** — plain `Error`, no custom error classes in v1. Read `.message`.
- **Tool `execute` returns `Promise<Result<ToolOk, Error>>`** and **never throws for expected failures** (file-not-found, non-zero exit, edit-text-not-found, `rg`/`fd`-not-installed, not-a-directory). Return `err(new Error(msg))`. A normal result is `ok({ content: [...] })`.
- **The MCP `CallTool` handler is the single narrowing point**: `if (!r.ok) return { content:[{type:"text", text:r.error.message}], isError:true }`, else apply the `MAX_RESPONSE_BYTES` backstop to `r.value.content`. It keeps a fallback `try/catch` *only* as a bug safety-net.
- **Exceptions remain for:** framework boundaries (Fastify `reply` + error handler, MCP SDK `handleRequest`/`connect`), `main.ts`/boot/process errors, and genuine bugs. Don't fight the frameworks.
- **No `any`** (`noExplicitAny`). For external CLI JSON (`rg --json`, `fd` output), parse to `unknown` and narrow (`if (event.type === "match") …`) — never `let event: any`.

## Tool shape

- Each tool is a plain `ToolModule` object `{ name, description, inputSchema, execute(args, rootDir) }`. `inputSchema` is a **plain JSON-Schema object literal** (no Typebox — deliberate simplification vs pi). `createAllTools(rootDir)` wraps them into `McpToolEntry[]`.
- **All tool output funnels through the shared truncate utils** (`truncateHead` / `truncateTail` / `truncateLine`). Never return unbounded content; `MAX_RESPONSE_BYTES` is the outer net.
- Use the **`src/tools/io.ts` Result-wrappers** over throwing `node:fs`/`spawn` calls so tool bodies contain **zero try/catch** and compose with `andThen`/`map`.

## Porting from pi

- Port the **logic** verbatim from `pi/.../tools/<x>.ts`; strip `@earendil-works/pi-*`, `pi-tui`, `ToolDefinition`/render, every `*Operations` interface seam, and `ensureTool` (→ `isToolAvailable`).
- Convert pi's **throws to `err(...)`** at the point of failure (mechanical). The control flow ports unchanged; only the error signal changes.

## Style (biome — matched to pi so verbatim ports pass `biome check` unchanged)

- Tabs, **indentWidth 3**, **lineWidth 120**, double quotes. `organizeImports: on`.
- `useConst` = error. `noNonNullAssertion` off (pi uses `!`; revisit later). `recommended` covers `useImportType` etc.

## Tests

- Co-located `src/**/*.test.ts`. Assert on `result.ok` / `result.error` for expected failures — no `.rejects` / try-catch for the domain. Only genuine-throw paths use try/catch.
