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
 OpenHammer

  → Status          server up
    Channels        1 configured
    Clients & JWT   1 client
    Monitor         quiet
    Settings        037c083b-5923-4b9d-9f33-d7b4ec4828a6
    Doctor          run diagnostics
    Quit            exit OpenHammer
```

# OpenHammer

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node: ≥20](https://img.shields.io/badge/node-%E2%89%A520-green.svg)](https://nodejs.org)
[![TypeScript: strict](https://img.shields.io/badge/TypeScript-strict-blue.svg)](./tsconfig.json)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-purple.svg)](https://modelcontextprotocol.io)

> "What better way to ``bash`` than with a hammer? OpenHammer allows you to serve a file system and shell over MCP. The same way all the best harnesses use the file system to drive agentic workflows, like OpenClaw, Hermes, PI, OpenCode, Claude Code, etc. The OGs know that the best agents aren't heavily abstracted behind sdks like Crew AI, LangChain or N8N, but are simply an LLM iterating over a filesystem with bash. You'll be able to tunnel your local environment straight to any MCP client, so no need for a million connectors to share your code with an AI chat, and turns any streaming chat loop into a harness. Or, you could launch a web server for any AI to drive. A few simple tools with the right access make this possible. This allows you to use any MCP compatible client to control a computer. Once the base tools are done, I'll be adding all the tools needed for managing agents, from memories, skills, tools, sessions, all persisting, cross compatible and portable to any MCP client." — Harry Hathorn

A **standalone MCP server with no LLM** that exposes 7 local shell & filesystem tools — `read`,
`bash`, `edit`, `write`, `grep`, `find`, `ls` — to a remote agent over Fastify + stateless Streamable
HTTP, rooted at `MCP_ROOT_DIR`. **The entrance is the TUI**: run `openhammer` (no args) for a
full-screen control center that runs the server, manages **channels** (ngrok / cloudflared / a static
URL), issues **OAuth clients**, and streams live tool activity. Authenticate any MCP client three ways
— a raw **bearer token**, an OAuth **client-credentials** pair, or a full **authorization-code + PKCE**
login (Claude web & Claude Code connect natively through a tunnel).

> **No LLM, by design.** OpenHammer only *executes* tools. The intelligence — the agent loop, model
> calls, and compaction — lives in the **MCP client** (your LLM provider, e.g. Claude Code). Point it
> at OpenHammer's `/mcp` endpoint with the bearer token and it gets a safe, bounded filesystem+shell
> surface to drive.

> **Start here — the TUI is the entrance.** After `npm run build`, run **`node dist/cli.js`** (or
> `npm link` once for the bare `openhammer` shortcut, or `npx tsx src/cli.ts` in development) with no
> arguments: it boots the server and opens the dashboard in one. Everything below — channels,
> clients, settings, doctor, monitor — is reachable from that control center; the one-shot
> `openhammer <command>` forms are the same flows, scriptable/headless.

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

### OAuth clients (Claude web / Claude Code)

Clients that can't set a raw `Authorization: Bearer` header connect via OAuth. OpenHammer ships a full
Authorization Server — the **client-credentials** grant (machine clients) **and** the
**authorization-code + PKCE** flow with dynamic registration (`/register`), which is what Claude web
and Claude Code use. For an auth-code client you also need a login for `/oauth/authorize`:

```bash
openhammer auth set-login                  # the username + password Claude will prompt for
openhammer auth add-client                 # → pick "Authorization code (login)"; paste its client_id into Claude Code
# (Claude web registers its own client at /register and just needs the login above)
```

> **Behind a tunnel, set `MCP_PUBLIC_URL`.** OAuth discovery advertises the issuer/endpoints from the
> server's base URL. With a manual ngrok/cloudflare URL in front, export
> `MCP_PUBLIC_URL=https://<your-tunnel>.app` so the metadata points at the public https URL (an
> OpenHammer-managed ngrok/cloudflare channel auto-derives this). Then connect Claude web/Code to
> `https://<your-tunnel>.app/mcp` — it discovers the AS, you log in once, and it reaches `/mcp`.

> **Running the CLI:** after `npm run build`, invoke it as **`node dist/cli.js …`** — npm does *not* link
> a package's own bin into `node_modules/.bin`, so `./node_modules/.bin/openhammer` won't exist. For the
> bare `openhammer …` shortcut, run **`npm link`** once (puts it on your `PATH`); during development
> without building, use **`npx tsx src/cli.ts …`**.

## The `openhammer` CLI

```text
openhammer                       The TUI control center (live dashboard) — in a terminal
openhammer start [--channel ID]  Start the server headless (or resolve a persisted channel)
openhammer channel add           Add an ingress channel (ngrok/cloudflare/static) — wizard or flags
openhammer channel list          List configured channels
openhammer channel use <id>      Set the default channel
openhammer channel remove <id>   Remove a channel (and its stored credentials)
openhammer config get            Show persisted settings
openhammer config set [section]  Edit a settings section (default: mcp) — wizard or flags
openhammer auth add-client       Issue an OAuth client — client-credentials OR authorization-code (login); id+secret shown once
openhammer auth set-login        Set the /authorize operator login (username + password)
openhammer auth list             List OAuth clients
openhammer auth remove <id>      Remove an OAuth client
openhammer doctor                Run health checks (config, channels, credentials, rg/fd)
openhammer monitor               Stream live client + tool-call activity (Ctrl-C to stop)
```

Interactive commands print the OpenHammer banner first.

## TUI control center (dashboard)

Run `openhammer` with no arguments (in a terminal) and you get a **navigable control center** — a
full-screen, colored menu (built on pi-tui, like pi's own UI) instead of juggling commands. Move
with `↑`/`↓`, open a section with `Enter`, go back with `Esc`/`←`, quit with `q`/`Ctrl-C`:

- **Status** — server up/down, local + tunnel URL, bearer token
- **Channels** — configured channels + their live state/URLs; drill into one to **use**/**remove** it, or **add** a channel via the wizard
- **Clients & JWT** — registered OAuth clients (id + grant type); **issue** a new one and pick its type — **client-credentials** (machine) or **authorization-code (login)** (with redirect URIs + an optional per-client username/password). The `client_id` + `client_secret` are shown once — only the SHA-256 hash is kept. (Set the `/authorize` operator login with `openhammer auth set-login`.)
- **Monitor** — the live streaming feed of tool calls (who, which tool, duration, size)
- **Settings** — allowed-client list + default channel; **edit** via the wizard
- **Doctor** — run the diagnostics checks

It's a **view over the running server** (subscribes to its status socket) and manages the server's
lifecycle, so `openhammer` is the single entry that runs the server + the dashboard; quitting stops
both (no orphan). For headless/container deploys, use `openhammer start`. (The same flows are
available one-shot: `openhammer channel …`, `auth …`, `config …`, `doctor`, `monitor`.)

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
| `MCP_PUBLIC_URL` | _derived_ | Public base URL advertised in OAuth discovery (issuer/endpoints). Auto from a managed tunnel; set it for a manual ngrok/cloudflare URL, else `http://$HOST:$PORT`. |
| `OAUTH_JWT_SECRET` | _minted_ | HS256 secret for the OAuth AS (`POST /oauth/token` — client-credentials + auth-code + refresh); minted into `credentials.json` on first use. |
| `MCP_MAX_RESPONSE_BYTES` | `512000` | Universal `tools/call` size backstop. |
| `MCP_ALLOWED_CLIENTS` | _any_ | Comma-list of allowed MCP client `User-Agent`s (opt-in `403` gate). |
| `LOG_LEVEL` | `info` | pino level. |

`mcp.allowedClients` (set via `openhammer config set mcp`) is a secondary, best-effort client-type
filter on top of the bearer token; default is any client. The bearer token remains the real gate.

## Headless / server deployment

No TUI required — a server deploy (Docker / systemd / k8s) is configured via **environment variables** and/or **provisioning the dotfile**:

- **Env (simplest):** `HOST=0.0.0.0 MCP_ROOT_DIR=/srv/web MCP_AUTH_TOKEN=… LOG_LEVEL=info node dist/main.js`. Env overrides the dotfile, so a server can run with **zero** `~/.openhammer` state. Point `MCP_ROOT_DIR` at the filesystem you want to serve to the agent.
- **Provision the dotfile** for what env can't express (a persisted channel + its secret, an OAuth client pair): write `~/.openhammer/config.json` + `credentials.json` (`0600`) directly — bake into the image, mount a volume, or cloud-init; `node dist/main.js` reads them at boot. (Precedence: CLI flags > env > dotfile.)
- **Non-interactive CLI** (scripted / CI): `openhammer channel add --provider ngrok --authtoken "$T"`, `openhammer config set mcp.allowedClients claude-code`, `openhammer auth add-client --label ci` — flag-driven, no wizard, validated. (Or script via env — `NGROK_AUTHTOKEN`, `MCP_ALLOWED_CLIENTS` — or by writing the dotfile JSON.)

## Architecture

- **Stateless MCP.** Per-request `Server` + `StreamableHTTPServerTransport` (`enableJsonResponse:true`),
  no `sessionIdGenerator` (the SDK's stateless mode).
- **Three auth paths.** The `/mcp` gate accepts, in fall-through order: the per-instance **opaque
  bearer** (constant-time compared; `MCP_AUTH_TOKEN` overrides) **or** an AS-issued HS256 JWT. The
  Authorization Server (spec 20) mints those JWTs via three grants — **client-credentials**
  (`POST /oauth/token` with `client_id`/`client_secret`), **authorization-code + PKCE**
  (`GET/POST /oauth/authorize` username/password login → `POST /oauth/token`), and **refresh_token** —
  plus RFC 7591 **dynamic registration** (`POST /register`), all advertised via RFC 8414/9728 metadata.
  Claude web & Claude Code connect through the auth-code flow; a raw bearer works for any client that
  can set a header. (The `/authorize` login resolves a client's own credentials, else the global
  operator login from `auth set-login`.)
- **Channels & config are pluggable.** A channel provider registry (`live`/`static`) + a settings-section
  registry drive a schema-based TUI wizard (`@earendil-works/pi-tui`) — adding a channel or a settings section is
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
- Source of truth: `specs/01`–`specs/21` (+ `99`, the future agent-harness roadmap, out of scope for v1).

```text
src/{tools,mcp,auth,tunnel/providers,config,tui/wizards,cli,diagnostics,observability}
test/{e2e-hermetic,fixtures,compose}  Dockerfile · docker-compose.yml · loop.sh
specs/01–21 + 99   docs/{coding-standards,agent-harness-design}.md
```

## Status

Greenfield, built incrementally by the loop from the specs. Porting references: tool logic ← pi's
`core/tools/`; terminal/TUI/session model ← pi (`packages/coding-agent/src/cli`, `packages/agent/src/harness`).

## License

[MIT](./LICENSE) © harry-hathorn
