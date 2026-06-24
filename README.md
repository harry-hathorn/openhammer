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

> "OpenHammer allows you to serve a file system and shell over MCP. The same way all the best harnesses use the file system to drive agentic workflows, like OpenClaw, Hermes, PI, OpenCode, Claude Code, etc. The OGs know that the best agents aren't heavily abstracted behind sdks like Crew AI, LangChain or N8N, but are simply an LLM iterating over a filesystem with bash. You'll be able to tunnel your local environment straight to any MCP client, so no need for a million connectors to share your code with an AI chat, and turns any streaming chat loop into a harness. Or, you could launch a web server for any AI to drive. A few simple tools with the right access make this possible. This allows you to use any MCP compatible client to control a computer. Once the base tools are done, I'll be adding all the tools needed for managing agents, from memories, skills, tools, sessions, all persisting, cross compatible and portable to any MCP client." — Harry Hathorn

A **standalone MCP server with no LLM** that mints a per-instance bearer token and exposes 7 local
shell & filesystem tools — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — to a remote agent
over Fastify + stateless Streamable HTTP, rooted at `MCP_ROOT_DIR` and gated by the credential. It is
configured and operated through the **`openhammer` CLI**: set up public **channels** (ngrok,
cloudflared, or a static URL), run health checks, and watch live tool activity.

> **No LLM, by design.** OpenHammer only *executes* tools. The intelligence — the agent loop, model
> calls, and compaction — lives in the **MCP client** (your LLM provider, e.g. Claude Code). Point it
> at OpenHammer's `/mcp` endpoint with the bearer token and it gets a safe, bounded filesystem+shell
> surface to drive.

---

## Tools

| Tool | What it does |
|---|---|
| `guide` | Read-first orientation: the working-root contract + the tools (no params). |
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
npm run build                 # builds dist/, including the `openhammer` CLI (dist/cli.js)
npm start                     # run the server (node dist/main.js)
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

Point your MCP client (Claude Code, Cursor, the MCP Inspector, …) at that URL with the bearer. Verify
with the inspector: `npx @modelcontextprotocol/inspector` → POST `…/mcp` with the bearer → `initialize`
→ `tools/list` (expect 8 tools: `guide` + the 7 capability tools) → call each.

> **Running the CLI:** after `npm run build`, invoke it as **`node dist/cli.js …`** — npm does *not* link
> a package's own bin into `node_modules/.bin`, so `./node_modules/.bin/openhammer` won't exist. For the
> bare `openhammer …` shortcut, run **`npm link`** once (puts it on your `PATH`); during development
> without building, use **`npx tsx src/cli.ts …`**.

## The `openhammer` CLI

```text
openhammer                       Start the server (same as `openhammer start` / `npm start`)
openhammer start [--channel ID]  Start, optionally resolving a persisted channel
openhammer channel add           TUI wizard — configure an ingress channel (ngrok/cloudflare/static)
openhammer channel list          List configured channels
openhammer channel use <id>      Set the default channel
openhammer channel remove <id>   Remove a channel (and its stored credentials)
openhammer config get            Show persisted settings
openhammer config set [section]  Edit a settings section via the wizard (default: mcp)
openhammer doctor                Run health checks (config, channels, credentials, rg/fd)
openhammer monitor               Stream live client + tool-call activity (Ctrl-C to stop)
```

Interactive commands print the OpenHammer banner first.

## Channels (how OpenHammer is reached)

A **channel** is how a remote agent reaches the server. Add one with `openhammer channel add` and it is
persisted to `~/.openhammer/config.json` (secrets go to `~/.openhammer/credentials.json`, `0600`).

| Channel | Mode | Needs | How the URL is obtained |
|---|---|---|---|
| `ngrok` | live | the `ngrok` binary + authtoken | drives `ngrok http`; read from its `:4040` inspector API |
| `cloudflare` | live | the `cloudflared` binary | quick-tunnel URL scraped from cloudflared |
| `nginx` / `static-url` | static | you stand up the endpoint (nginx/reverse-proxy on a server) | you declare the public URL; OpenHammer probes `/health` |

Live channels start a process at boot (`openhammer start --channel <id>` or the default channel);
static channels just record the URL you operate. To pick a different default, `openhammer channel use <id>`.

## Configuration

Settings persist under `~/.openhammer` (`config.json` for non-secret config + `defaultChannel`;
`credentials.json`, `0600`, for secrets like the ngrok authtoken). **Precedence:** CLI flags
(`--channel <id>`) > environment variables > persisted settings — so env stays a working override.

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | HTTP port. |
| `HOST` | `127.0.0.1` | Bind address (`0.0.0.0` to expose on LAN). |
| `MCP_ROOT_DIR` | launch cwd | Tool filesystem root; resolved absolute. |
| `MCP_AUTH_TOKEN` | _minted_ | Override the minted bearer (no cred-file I/O). |
| `MCP_MAX_RESPONSE_BYTES` | `512000` | Universal `tools/call` size backstop. |
| `MCP_ALLOWED_CLIENTS` | _any_ | Comma-list of allowed MCP client `User-Agent`s (opt-in `403` gate). |
| `LOG_LEVEL` | `info` | pino level. |

`mcp.allowedClients` (set via `openhammer config set mcp`) is a secondary, best-effort client-type
filter on top of the bearer token; default is any client. The bearer token remains the real gate.

## Headless / server deployment

No TUI required — a server deploy (Docker / systemd / k8s) is configured via **environment variables** and/or **provisioning the dotfile**:

- **Env (simplest):** `HOST=0.0.0.0 MCP_ROOT_DIR=/srv/web MCP_AUTH_TOKEN=… LOG_LEVEL=info node dist/main.js`. Env overrides the dotfile, so a server can run with **zero** `~/.openhammer` state. Point `MCP_ROOT_DIR` at the filesystem you want to serve to the agent.
- **Provision the dotfile** for what env can't express (a persisted channel + its secret, an OAuth client pair): write `~/.openhammer/config.json` + `credentials.json` (`0600`) directly — bake into the image, mount a volume, or cloud-init; `node dist/main.js` reads them at boot. (Precedence: CLI flags > env > dotfile.)
- **Non-interactive CLI** (scripted / CI — *planned, `20g`*): `openhammer channel add --provider ngrok --authtoken "$T"`, `openhammer config set mcp.allowedClients claude-code`, `openhammer auth add-client --label ci` — flag-driven, no wizard, validated. Until then, script those via env (`NGROK_AUTHTOKEN`, `MCP_ALLOWED_CLIENTS`) or by writing the dotfile JSON.

## Architecture

- **Stateless MCP.** Per-request `Server` + `StreamableHTTPServerTransport` (`enableJsonResponse:true`),
  no `sessionIdGenerator` (the SDK's stateless mode).
- **Opaque bearer auth.** Constant-time compared; one token per instance; `MCP_AUTH_TOKEN` overrides.
  No OAuth AS — only a `/.well-known/oauth-protected-resource` discovery pointer.
- **Channels & config are pluggable.** A channel provider registry (`live`/`static`) + a settings-section
  registry drive a schema-based TUI wizard (`@clack/prompts`) — adding a channel or a settings section is
  one file + one registry line.
- **Live monitoring.** A non-blocking recorder streams client + tool-call activity over a local-only
  Unix socket (`~/.openhammer/openhammer.sock`, `0600`); `openhammer monitor` tails it.
- **Not hard-jailed.** Tool paths resolve under `MCP_ROOT_DIR` via `resolveToCwd`, but `bash` reaches
  anything the OS user can. **For isolation, run OpenHammer in a container** (mount only the target dir,
  set `MCP_ROOT_DIR`); the container *is* the sandbox.
- **Result error model.** Tool `execute → Promise<Result<ToolOk, Error>>`; expected failures return
  `err(new Error(msg))`, never throw. The MCP `CallTool` handler is the single narrowing point, with a
  universal size backstop.

## Testing

Deterministic, no LLM — the "real client" is the MCP SDK `Client` driven by a script that asserts on
`callTool` text. Five tiers build on each other (see `specs/15` + `specs/16`):

- **Hermetic trio** (`npm test`): Tier-0 units → Tier-1 in-process MCP E2E → Tier-2 boot + CLI E2E.
- **Containerized** (on-demand): `npm run test:compose`, `npm run test:compose:real`,
  `npm run test:in-container`.
- **Tunnel E2E** (gated, non-blocking — traverses a live edge): `npm run test:tunnel` (cloudflare) /
  `npm run test:tunnel:ngrok` (needs `NGROK_AUTHTOKEN` + the `ngrok` binary).

## Development

This repo ships from an **autonomous build loop** (`loop.sh` + `PROMPT_build.md`): one checkbox in
`IMPLEMENTATION_PLAN.md` = one iteration = one commit, fresh context each time, validated by the trio
(`npm test` / `npm run typecheck` / `npm run lint`), Conventional Commits, tagged per iteration.

- Standards: `AGENTS.md` (high-signal) → `docs/coding-standards.md` (detail).
- Source of truth: `specs/01`–`specs/18` (+ `99`, the future agent-harness roadmap, out of scope for v1).

```text
src/{tools,mcp,auth,tunnel/providers,config,tui/wizards,cli,diagnostics,observability}
test/{e2e-hermetic,fixtures,compose}  Dockerfile · docker-compose.yml · loop.sh
specs/01–18 + 99   docs/{coding-standards,agent-harness-design}.md
```

## Status

Greenfield, built incrementally by the loop from the specs. Porting references: tool logic ← pi's
`core/tools/`; terminal/TUI/session model ← pi (`packages/coding-agent/src/cli`, `packages/agent/src/harness`).

## License

[MIT](./LICENSE) © harry-hathorn
