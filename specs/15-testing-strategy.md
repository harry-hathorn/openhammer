# 15 — Testing Strategy & Pipeline

## Purpose
Codify how every piece of OpenHammer is **tested for real, scripted, and part of
the pipeline** — layered so each tier builds on the one below, from per-function
units to containerized end-to-end. The guiding rule: **deterministic, no LLM.** The
"real MCP client" is the official `@modelcontextprotocol/sdk` `Client` driven by a
script that asserts on `callTool` text — free, hermetic, CI-friendly.

## Non-goals
- **No LLM / Claude Code / API key in tests.** A model in the loop is non-deterministic
  and costs money; the SDK client gives exact assertions. (The spec-99 agent-harness
  idea is separate future work.)
- The internet-dependent tier (cloudflare tunnel) **exists but is non-blocking** (gated).

## The five tiers

| Tier | What it proves | Runs via | Activates | Blocking? |
|---|---|---|---|---|
| **0 Unit** | each tool's `execute → Result` directly | `npm test` (vitest) | every tool task 03–09 | ✅ trio |
| **1 In-process MCP** | real SDK `Client` ↔ in-process `buildFastify` over loopback port 0: `initialize`/`tools/list`/`tools/call` per tool, bearer 401, `MAX_RESPONSE_BYTES` backstop | `npm test` (vitest) | task `12b` (canary ships in the scaffold) | ✅ trio |
| **2 Boot** | spawn the real entrypoint; `/health`, token mint + reuse across restarts, clean `SIGINT`/`SIGTERM`, tunnel child reaped | `npm test` (vitest) | task `14b` | ✅ trio |
| **3 Containerized** | real image + deterministic SDK-client runner on a Docker network | `npm run test:compose` | fixture now; real server at `14b` | on-demand / CI |
| **4 Tunnel** | server + `cloudflared` + runner through the public `trycloudflare.com` URL | `npm run test:tunnel` (gated) | task `13` | ❌ gated |

Each tier depends on code delivered by earlier spec tasks, so tests **accumulate** —
Tier N only exists once Tier N−1's underlying code has shipped.

## Repo / test layout
```
src/**/*.test.ts                 # Tier 0 units (co-located, per coding-standards)
test/
  e2e-hermetic/
    harness.canary.test.ts       # Tier 1 walking skeleton (SDK client ↔ fixture) — ships in scaffold
    mcp.e2e.test.ts              # Tier 1 real (SDK client ↔ real buildFastify) — task T-mcp-e2e
    boot.e2e.test.ts             # Tier 2 — task T-boot-e2e
  fixtures/
    minimal-mcp-server.ts        # deterministic Streamable-HTTP MCP server; reference target for canary + compose
  compose/
    run-e2e.ts                   # deterministic SDK-client runner (compose `test-runner`)
Dockerfile                       # multi-stage: dev (full deps + tsx) / prod (runtime, dist/main.js)
docker-compose.yml               # services: dev, fixture-server, test-runner, server(profile=real), cloudflared(profile=tunnel)
vitest.config.ts                 # hermetic trio include: src/** + test/e2e-hermetic/**
tsconfig.test.json               # typechecks src + test (no rootDir restriction)
```
Tier 4 (tunnel) is a **compose profile**, not a vitest file, so the hermetic trio never loads it.

## The pipeline (two paths)
- **Fast path — every loop iteration:** the hermetic trio, unchanged in mechanism:
  `npm test` (Tier 0+1+2), `npm run typecheck` (`tsc -p tsconfig.json --noEmit && tsc -p tsconfig.test.json --noEmit`),
  `npm run lint` (`biome check src test`). Fast, green on any Node 20+ box. `loop.sh` is not modified.
- **Reproducible/container path — on-demand / CI / end-of-integration:** `npm run test:compose`
  (fixture E2E), `npm run test:in-container` (`docker compose run --rm dev npm test`), and later
  `test:compose:real` (post-14b) / `test:tunnel` (gated).

## TDD-in-loop
Within each checkbox: write/extend the relevant test first (red), implement to green. Each task in
`IMPLEMENTATION_PLAN.md` names the **test tier** it activates, so an iteration knows exactly which
test file to grow. Tests build on each other: a tool's unit test (Tier 0) → the in-process MCP test
calls the same tool over the wire (Tier 1) → the compose test calls it across the Docker network (Tier 3).

## npm scripts
- `test` — hermetic trio (vitest: units + in-process + boot).
- `typecheck` — src **and** test (`tsconfig.json` + `tsconfig.test.json`).
- `lint` / `format` — biome over `src` **and** `test`.
- `test:compose` — `docker compose up --build --exit-code-from test-runner --abort-on-container-exit`.
- `test:in-container` — `docker compose run --rm dev npm test`.
- `test:tunnel` — `bash scripts/test-tunnel.sh` (gated; skips unless `OPENHAMMER_TUNNEL_E2E=1` + `cloudflared` present).

## Acceptance criteria
- `npm test` runs Tiers 0–2 and is green on a box with only Node 20+ (no Docker, no internet).
- `npm run typecheck` and `npm run lint` cover `test/` as well as `src/`.
- `npm run test:compose` builds the images and the deterministic SDK-client E2E passes across the Docker network.
- `npm run test:in-container` runs the same vitest suite inside the `dev` container.
- `npm run test:tunnel` exits 0 with a clear skip message when `cloudflared` is absent.
- No tier uses an LLM; all assertions are on `callTool` text output.

## Decisions & deviations
- **SDK client as the real client, not an LLM.** Deterministic and free; mirrors the industry-standard
  pattern (programmatic `tools/call` + `assert`).
- **Docker Compose, not `testcontainers`.** User preference; one shared multi-stage image, no per-service `package.json`.
- **Tunnel is gated/non-blocking** — it traverses Cloudflare's live edge, so it can't be hermetic.
- **Tests typechecked + linted** via `tsconfig.test.json` (drops `rootDir: src`) and `biome check src test`.

## Suggested plan items (atomic checkboxes)
See `IMPLEMENTATION_PLAN.md` → "Testing & pipeline". The scaffold ships T-harness, T-canary, T-dockerfile,
T-compose (all done) plus the first real unit (`01-config`). Later: T-mcp-e2e (`12b`), T-boot-e2e (`14b`),
T-real-compose (`14b`), T-tunnel-e2e (`13`).
