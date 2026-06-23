```text
                                         ████████
                                         ██╳╳╳╳██
                                         ██╳╳╳╳██
                                         ██╳╳╳╳██
                                         ██╳╳╳╳██
                                         ████████
                            ██████████████████████████████████
                            ██╔════════════════════════════╗██
                            ██║                            ║██
                            ██║   ᚦ   ᛟ   ᚱ   ᛞ   ᚱ   ᛟ    ║██
                            ██║                            ║██
                            ██╚════════════════════════════╝██
                            ██████████████████████████████████

 ██████╗ ██████╗ ███████╗███╗   ██╗██╗  ██╗ █████╗ ███╗   ███╗███╗   ███╗███████╗██████╗
██╔═══██╗██╔══██╗██╔════╝████╗  ██║██║  ██║██╔══██╗████╗ ████║████╗ ████║██╔════╝██╔══██╗
██║   ██║██████╔╝█████╗  ██╔██╗ ██║███████║███████║██╔████╔██║██╔████╔██║█████╗  ██████╔╝
██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██╔══██║██╔══██║██║╚██╔╝██║██║╚██╔╝██║██╔══╝  ██╔══██╗
╚██████╔╝██║     ███████╗██║ ╚████║██║  ██║██║  ██║██║ ╚═╝ ██║██║ ╚═╝ ██║███████╗██║  ██║
 ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝╚═╝     ╚═╝╚══════╝╚═╝  ╚═╝
```

# OpenHammer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node: ≥20](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-purple.svg)](https://modelcontextprotocol.io)

A **standalone MCP server with no LLM** that mints a per-instance bearer token and exposes 7 local
shell & filesystem tools — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — to a remote agent
over Fastify + stateless Streamable HTTP, rooted at `MCP_ROOT_DIR`, gated by the credential, with an
optional `cloudflared` quick-tunnel.

> **No LLM, by design.** OpenHammer only *executes* tools. The intelligence — the agent loop, model
> calls, and compaction — lives in the **MCP client** (your LLM provider, e.g. Claude Code). Point it
> at OpenHammer's `/mcp` endpoint with the bearer token and it gets a safe, bounded filesystem+shell
> surface to drive.

---

## The 7 tools

| Tool | What it does |
|---|---|
| `read` | Read a file (text or image), truncated to 2000 lines / 50KB (head). |
| `bash` | Run a shell command; merged stdout+stderr, tail-truncated, full output spilled to a temp file. |
| `edit` | Exact-text replacement (BOM/CRLF-preserving, fuzzy whitespace/quotes). |
| `write` | Create/overwrite a file (creates parent dirs). |
| `grep` | `ripgrep` content search (`.gitignore`-aware), NDJSON, capped matches. |
| `find` | `fd` file search (`.gitignore`-aware) by glob. |
| `ls` | List a directory (alphabetical, `/` on dirs, dotfiles included). |

`grep` needs `rg`, `find` needs `fd` — both presence-checked at runtime with a graceful install hint
(no auto-download, no Node fallback). All output is bounded by per-tool truncation **and** a universal
`MAX_RESPONSE_BYTES` (512KB) backstop that emits a structured `response_too_large` block.

## Quick start

```bash
npm install
MCP_ROOT_DIR=/path/to/workspace npm start
```

On first boot OpenHammer mints a bearer token to `~/.openhammer/credential.json` (`0600`) and prints the
URL, the token (once), and a ready-to-paste MCP client config block:

```json
{
  "mcpServers": {
    "openhammer": {
      "type": "http",
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

To expose it publicly (ephemeral, no account): `npm start -- --tunnel` (needs the `cloudflared` binary;
falls back to localhost-only if absent).

Verify with the MCP Inspector: `npx @modelcontextprotocol/inspector` → POST `…/mcp` with the bearer →
`initialize` → `tools/list` (expect 7 tools) → call each.

## Configuration (env)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on LAN). |
| `MCP_ROOT_DIR` | launch cwd | Tool filesystem root; resolved absolute. |
| `MCP_AUTH_TOKEN` | _minted_ | Override the minted bearer (no cred-file I/O). |
| `MCP_MAX_RESPONSE_BYTES` | `512000` | Universal `tools/call` size backstop. |
| `LOG_LEVEL` | `info` | pino level. |

## Architecture

- **Stateless MCP.** Per-request `Server` + `StreamableHTTPServerTransport` (`enableJsonResponse:true`),
  no `sessionIdGenerator` (the SDK's stateless mode).
- **Opaque bearer auth.** Constant-time compared; one token per instance; `MCP_AUTH_TOKEN` overrides.
  No OAuth AS — only a `/.well-known/oauth-protected-resource` discovery pointer.
- **Not hard-jailed.** Tool paths resolve under `MCP_ROOT_DIR` via `resolveToCwd`, but `bash` reaches
  anything the OS user can. **For isolation, run OpenHammer in a container** (mount only the target dir,
  set `MCP_ROOT_DIR`); the container *is* the sandbox.
- **Result error model.** Tool `execute → Promise<Result<ToolOk, Error>>`; expected failures return
  `err(new Error(msg))`, never throw. The MCP `CallTool` handler is the single narrowing point, with a
  universal size backstop.

## Testing

Deterministic, no LLM — the "real client" is the MCP SDK `Client` driven by a script that asserts on
`callTool` text. Five tiers build on each other (see `specs/15` + `specs/16`):

- **Hermetic trio** (`npm test`): Tier-0 units → Tier-1 in-process MCP E2E → Tier-2 boot E2E.
- **Containerized** (on-demand): `npm run test:compose` (Docker Compose server+test-runner),
  `npm run test:in-container`, gated `npm run test:tunnel`.

## Development

This repo ships from an **autonomous build loop** (`loop.sh` + `PROMPT_build.md`): one checkbox in
`IMPLEMENTATION_PLAN.md` = one iteration = one commit, fresh context each time, validated by the trio
(`npm test` / `npm run typecheck` / `npm run lint`), Conventional Commits, tagged per iteration.

- Standards: `AGENTS.md` (high-signal) → `docs/coding-standards.md` (detail).
- Source of truth: `specs/01`–`specs/16` (+ `99`, the future agent-harness roadmap, out of scope for v1).

```text
src/{tools,mcp,auth,tunnel}  config.ts · server.ts · main.ts · startup-print.ts
test/{e2e-hermetic,fixtures,compose}  Dockerfile · docker-compose.yml · loop.sh
specs/01–16 + 99   docs/{coding-standards,agent-harness-design}.md
```

## Status

Greenfield, built incrementally by the loop from the specs. Porting references: tool logic ← pi's
`core/tools/`.

## License

[MIT](./LICENSE) © harry-hathorn
