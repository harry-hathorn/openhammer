# 01 — Project Setup & Configuration

## Purpose
Scaffold the greenfield OpenHammer project: package manifest, TypeScript config, lint/format config, env handling, and the directory layout every later spec populates. **OpenHammer is a standalone MCP server with no LLM** — it only executes tools.

## Source references
- Architecture & locked decisions: `~/.claude/plans/i-need-you-to-serialized-biscuit.md`
- Package/manifest style: `/home/haz/source/redacted/the-reference/package.json` (ESM, scripts).

## Requirements

### `package.json`
- `"name": "openhammer"`, `"type": "module"`, `"version": "0.1.0"`.
- `"engines": { "node": ">=20" }`.
- `"main": "dist/main.js"`.
- **dependencies**: `fastify`, `@fastify/cors`, `@modelcontextprotocol/sdk`. (No `jose` — opaque bearer tokens need only `node:crypto`. No `sharp` — image support is extension-based, no resize; see spec 03.)
- **devDependencies**: `typescript`, `tsx`, `vitest`, `@types/node`, `@biomejs/biome`, `pino-pretty`.
- **scripts**:
  - `"build": "tsc"`
  - `"start": "node dist/main.js"`
  - `"dev": "tsx watch src/main.ts"`
  - `"test": "vitest run --passWithNoTests"` — `--passWithNoTests` keeps `npm test` green for the early scaffold tasks (01-A–01-D) that ship no test files yet (vitest otherwise exits 1 on an empty suite and would block the validation trio).
  - `"typecheck": "tsc --noEmit"`
  - `"lint": "biome check src"`
  - `"format": "biome format --write src"`

### `tsconfig.json`
- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"target": "ES2022"`, `"lib": ["ES2022"]`.
- `"strict": true` plus: `skipLibCheck`, `esModuleInterop`, `resolveJsonModule`, `forceConsistentCasingInFileNames`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, `erasableSyntaxOnly`, `verbatimModuleSyntax`.
- **`.ts` import extensions:** `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` (tsc rewrites `.ts`→`.js` on emit). Relative imports use `.ts` (e.g. `import { resolveToCwd } from "./path-utils.ts";`) — matches pi's source so ports are verbatim. `import type` for type-only imports is enforced by `verbatimModuleSyntax`.
- **Deferred (off):** `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` — revisit after the port lands.
- `"outDir": "dist"`, `"rootDir": "src"`, `"declaration": false`, `"sourceMap": true`, `"include": ["src/**/*"]`.

### `biome.json`
- `recommended` preset. **Formatter matched to pi** so verbatim ports pass `biome check` unchanged: tabs, **indentWidth 3**, **lineWidth 120**, double quotes; `organizeImports: on`.
- **Stricter rules ON:** `style/useConst`=error, `style/useNodejsImportProtocol`=error (force `node:` built-ins), `suspicious/noExplicitAny`=error. `style/noNonNullAssertion` OFF for now (pi uses `!`). (`useImportType` etc. come from `recommended`.)
- Authoritative detail: `docs/coding-standards.md`.

### `.env.example`
Documents every env var with its default and a one-line explanation:
```
PORT=3000                       # HTTP port
HOST=127.0.0.1                  # bind address (use 0.0.0.0 to expose on LAN)
MCP_ROOT_DIR=                   # tool filesystem root; empty = launch cwd
MCP_AUTH_TOKEN=                 # override the minted bearer token (optional)
MCP_MAX_RESPONSE_BYTES=512000   # universal tools/call size backstop
LOG_LEVEL=info                  # pino level
```

### `src/config.ts`
`loadConfig(env = process.env): Config` parses env into a typed object. No external dep (no dotenv — Fastify/Node read `process.env`; operators use `--env-file` or shell env).
```ts
export interface Config {
  port: number;            // PORT, default 3000
  host: string;            // HOST, default "127.0.0.1"
  rootDir: string;         // MCP_ROOT_DIR resolved absolute; default process.cwd()
  authToken: string | undefined; // MCP_AUTH_TOKEN override; undefined → mint on boot
  maxResponseBytes: number;      // MCP_MAX_RESPONSE_BYTES, default 512_000
  logLevel: string;              // LOG_LEVEL, default "info"
}
```
- Coerce `PORT` / `MCP_MAX_RESPONSE_BYTES` with `Number(...)`; fall back to defaults if NaN/empty.
- `rootDir`: `path.resolve(env.MCP_ROOT_DIR || process.cwd())` — always absolute.
- Do NOT fail boot if `rootDir` doesn't exist (the `bash` tool reports that at call time).

### Directory skeleton (empty dirs / placeholder)
```
src/
├── main.ts            (spec 14)
├── config.ts          (this spec)
├── server.ts          (spec 12)
├── startup-print.ts   (spec 14)
├── auth/              (spec 11)
├── mcp/               (specs 10, 11, 12)
├── tunnel/            (spec 13)
└── tools/             (specs 02–10)
```

## Acceptance criteria
- `npm install` succeeds with no peer-dep errors.
- `npm run typecheck` passes on an empty-but-typed `src/config.ts`.
- `npm run build` emits `dist/`.
- `loadConfig({})` returns the documented defaults; `loadConfig({ PORT: "4242", MCP_ROOT_DIR: "/tmp/x" })` returns `{ port: 4242, rootDir: "/tmp/x", ... }`.
- `.env.example` lists all five vars with defaults.

## Decisions & deviations
- **Biome over ESLint/Prettier** — one tool for lint+format, matches pi's toolchain, faster. (the-reference uses ESLint+Prettier; we diverge for simplicity.)
- **No `dotenv`** — Node 20 `--env-file` / shell env suffice; keeps deps minimal.
- **No `jose`, no `sharp`** — see auth (spec 11) and read (spec 03).

## Suggested plan items (atomic checkboxes)
- [ ] Create `package.json` (deps, scripts, engines) and run `npm install`
- [ ] Create `tsconfig.json`
- [ ] Create `biome.json`
- [ ] Create `.env.example` and the `src/` directory skeleton
- [ ] Implement `src/config.ts` (`Config` type + `loadConfig`) with unit tests
