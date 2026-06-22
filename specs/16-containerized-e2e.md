# 16 — Containerized E2E (Docker Compose)

## Purpose
The Tier-3/Tier-4 tests: build the real OpenHammer image and exercise it over the MCP
protocol from a **separate container**, deterministically, with `docker compose up --exit-code-from
test-runner`. No LLM, no API key, no browser, no MCP Inspector. This is the containerized
analogue of the Tier-1 canary — same SDK-client logic, just across the Docker network.

## Source references (copy/adapt)
- Topology + `--exit-code-from` pattern: the user's docker-compose reference (adapted from SSE to **Streamable HTTP**).
- Server wiring copied from `the-reference/src/mcp-server/{server,http-transport}.ts` (spec 12) and mirrored by `test/fixtures/minimal-mcp-server.ts`.
- Files: `Dockerfile`, `docker-compose.yml`, `.dockerignore`, `test/compose/run-e2e.ts`, `test/fixtures/minimal-mcp-server.ts`, `scripts/test-tunnel.sh`.

## Depends on
- `src/server.ts` → `buildFastify` **must not call `listen` internally** (spec 12 edit) so tests can own binding/lifecycle.
- The `dev` Docker stage (full deps incl `tsx`); the `prod` stage (built `dist/`, lands with spec 14).
- `npm run build` producing `dist/main.js` for the **real** `server` service (post-14b).

## Topology (single shared multi-stage image)

| Service | Stage | Role | When |
|---|---|---|---|
| `dev` | dev | reproducible env: `docker compose run --rm dev npm test\|typecheck\|lint` | profile `dev` (never auto-starts) |
| `fixture-server` | dev | deterministic Streamable-HTTP MCP server (`test/fixtures`), `/health` + one `echo` tool behind a fixed bearer | always (the green reference target) |
| `test-runner` | dev | deterministic SDK-client runner (`test/compose/run-e2e.ts`); `assert` + `process.exit(0\|1)` | always; `--exit-code-from` reports its code |
| `server` | prod | real `node dist/main.js` | profile `real` (post-14b) |
| `cloudflared` | cloudflare/cloudflared | quick-tunnel bridging `server` to a public URL | profile `tunnel` (task T-tunnel-e2e) |

Startup sync uses a **`/health` healthcheck** (`depends_on: condition: service_healthy`), not a sleep —
node 22's global `fetch` runs the probe. `--abort-on-container-exit` tears everything down when
`test-runner` exits; `--exit-code-from test-runner` propagates its code to compose.

## `Dockerfile` (multi-stage)
- `dev` — `node:22-bookworm-slim`, `npm ci` (all deps incl `tsx`/`vitest`), `COPY . .`, `CMD ["npm","test"]`. No build step — fixtures/tests run `.ts` via tsx.
- `build` — same base, `npm ci` + `npm run build` → `dist/`.
- `prod` — `npm ci --omit=dev`, `COPY --from=build /app/dist`, `ENV MCP_ROOT_DIR=/data`, `CMD ["node","dist/main.js"]`.

`.dockerignore` excludes `node_modules`, `dist`, `.git`, `.env`, `.loop-complete`, `.claude`, `coverage`, logs.

## `test/compose/run-e2e.ts`
Reads `MCP_URL` (default `http://fixture-server:3000/mcp`) + `MCP_TOKEN`. `new Client` over
`StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit:{ headers:{ Authorization:`Bearer ${MCP_TOKEN}` } } })` →
`connect` (initialize) → `listTools` → `callTool` → `assert` on the text → `process.exit(0\|1)`. Identical client
logic to the Tier-1 canary; only the URL differs. When the `real` profile retargets it at `http://server:3000/mcp`,
the assertions grow to cover all 7 tools.

## `test/fixtures/minimal-mcp-server.ts`
Exports `buildFixtureServer({ token, maxResponseBytes?, logLevel? }): Promise<FastifyInstance>` (build-only, **no
listen**) and a standalone `main()`. Mirrors OpenHammer's shape: `@fastify/cors`, open `/health`, bearer-gated
stateless `POST /mcp` over `StreamableHTTPServerTransport`, GET/DELETE `/mcp` → 405, universal size backstop, one
deterministic `echo` tool. Doubles as a spec-12 reference and the permanent target for the canary + compose runner.

## Gating (Tier 4 tunnel)
`scripts/test-tunnel.sh` exits 0 with a clear skip message unless **both** `OPENHAMMER_TUNNEL_E2E=1` and
`cloudflared` on PATH are present. It must never fail the hermetic trio. Full orchestration (parse the
`https://*.trycloudflare.com` URL from cloudflared stderr, retarget the runner through it) lands with task
T-tunnel-e2e (spec 13).

## Acceptance criteria
- `npm run test:compose` → images build, fixture-server goes healthy, test-runner connects/lists/calls/asserts,
  compose exits 0. No LLM, no key.
- `npm run test:in-container` → `npm test` passes inside the `dev` container.
- (post-14b) `test:compose:real` retargets the same runner at the real `server` service and all 7 tools pass.
- `npm run test:tunnel` skips cleanly when `cloudflared` is absent; runs the tunnel E2E (through the public URL)
  when the flag + binary are present (task T-tunnel-e2e).
- `dev` is profile-gated so plain `docker compose up` starts only `fixture-server` + `test-runner`.

## Decisions & deviations
- **Streamable HTTP, not SSE** (OpenHammer's transport); the reference snippet's SSE + `setTimeout` is replaced by
  `StreamableHTTPClientTransport` + a `/health` healthcheck.
- **One shared image**, no per-service `package.json` (avoids dep duplication vs the reference).
- **`dev` profile-gated** so the deterministic E2E (`up`) isn't aborted by the dev service exiting.
- **`tsx` via `./node_modules/.bin/tsx`** (not `npx`) to avoid the npm wrapper and its teardown noise.
