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
[![npm](https://img.shields.io/npm/v/openhammer.svg)](https://www.npmjs.com/package/openhammer)

**<https://openhammer.dev>** · [Discussions](https://github.com/harry-hathorn/openhammer/discussions) · [Issues](https://github.com/harry-hathorn/openhammer/issues)

**OpenHammer is a server that turns any computer into a secure, MCP-controlled surface.** Run it on
your laptop for a local agent, or **deploy it on a server — or a fleet — to give any authenticated
MCP client controlled access to that machine's filesystem and shell** over a single HTTP endpoint.
Point Claude Desktop, Claude Code, Cursor, OpenCode, the MCP Inspector, or your own client (anything built on `@modelcontextprotocol/client`) at `/mcp` with a
token, and that box becomes a bounded agent workspace. No per-app connectors, no SDK lock-in: one
server per machine, any client, filesystem + shell as the surface — local-first, and at scale a
fleet of safe compute surfaces for AI.

```text
   any MCP client                (optional) tunnel              your computer
 ┌─────────────────┐   https   ┌───────────────────┐   ┌──────────────────────────────┐
 │ Claude Desktop  │ ────────▶ │ ngrok / cloudflare│ ─▶│ OpenHammer  /mcp  (auth gate)│
 │ Claude Code     │           │  …or 127.0.0.1    │   │   ↓ read bash edit write     │
 │ Cursor / custom │ ◀──────── │                    │ ◀│     grep find ls             │
 └─────────────────┘   tool    └───────────────────┘   └──────────────────────────────┘
                       results                         bounded by MCP_ROOT_DIR + size caps
```

> **Secure by construction.** Every connection is authenticated — bearer token, OAuth
> client-credentials, or auth-code + PKCE. Every tool is bounded: file tools are scoped to
> `MCP_ROOT_DIR`, and all output is size-capped (`MAX_RESPONSE_BYTES`). Run it in a container and
> the container *is* the sandbox. See [Security](#security).

> "What better way to ``bash`` than with a hammer? OpenHammer allows you to serve a file system and
> shell over MCP. The same way all the best harnesses use the file system to drive agentic workflows,
> like OpenClaw, Hermes, PI, OpenCode, Claude Code, etc. The OGs know that the best agents aren't
> heavily abstracted behind sdks like Crew AI, LangChain or N8N, but are simply an LLM iterating over
> a filesystem with bash. You'll be able to tunnel your local environment straight to any MCP client,
> so no need for a million connectors to share your code with an AI chat, and turns any streaming chat
> loop into a harness. Or, you could launch a web server for any AI to drive. A few simple tools with
> the right access make this possible. This allows you to use any MCP compatible client to control a
> computer." — Harry Hathorn

> **No LLM, by design.** OpenHammer only *executes* tools. The intelligence — the agent loop, model
> calls, and compaction — lives in the **MCP client** (your LLM provider, e.g. Claude Code). Point it
> at OpenHammer's `/mcp` endpoint with the bearer token and it gets a bounded filesystem+shell surface
> to drive.

> **It runs real shell + filesystem ops as you.** A connected client can do anything your OS user
> can. Bound it with `MCP_ROOT_DIR`, gate it with a bearer token / OAuth client, and for true isolation
> **run it in a container** (mount only the target dir). See [Security](#security).

> **Start here — the TUI is the entrance.** Run **`openhammer`** (or `npx openhammer`; from a source
> checkout, `node dist/cli.js`) with no arguments: it boots the server and opens the dashboard in one.
> Everything below — channels, clients,
> settings, doctor, monitor — is reachable from that control center; the one-shot
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
npx openhammer@latest          # run it without installing
# or
npm install -g openhammer      # installs the `openhammer` command on your PATH, then: openhammer
```

From source (development):

```bash
git clone https://github.com/harry-hathorn/openhammer && cd openhammer
npm install && npm run build   # builds dist/, including the `openhammer` CLI (dist/cli.js)
node dist/cli.js               # boot the TUI control center
```

On first boot OpenHammer mints a bearer token to `~/.openhammer/credentials.json` (`0600`) and prints the
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

### Connect any client — three auth paths

A connected MCP client is an agent with shell+filesystem access, so every path is authenticated.
OpenHammer's `/mcp` gate accepts, in fall-through order:

- **Raw bearer token** — any client that can set an `Authorization: Bearer` header (simplest; the
  token is minted on first boot, or set via `MCP_AUTH_TOKEN`).
- **OAuth client-credentials** — a `client_id` / `client_secret` pair for machine clients
  (`POST /oauth/token`).
- **OAuth authorization-code + PKCE** — the full login flow Claude web and Claude Code use, with
  dynamic registration (`/register`) and an operator login at `/oauth/authorize`.

```bash
openhammer auth set-login                  # the username + password the /authorize login prompts for
openhammer auth add-client                 # → pick "Authorization code (login)"; paste its client_id into Claude Code
# (Claude web registers its own client at /register and just needs the login above)
```

> **Behind a tunnel, set `MCP_PUBLIC_URL`.** OAuth discovery advertises the issuer/endpoints from the
> server's base URL. With a manual ngrok/cloudflare URL in front, export
> `MCP_PUBLIC_URL=https://<your-tunnel>.app` so the metadata points at the public https URL (an
> OpenHammer-managed ngrok/cloudflare channel auto-derives this). Then connect Claude web and Claude Code to
> `https://<your-tunnel>.app/mcp` — it discovers the AS, you log in once, and it reaches `/mcp`.

> **Running the CLI:** installed from npm, the **`openhammer`** command is on your `PATH` (`npx openhammer`
> works too). From a source checkout npm doesn't link a package's own bin, so use **`node dist/cli.js …`**
> after `npm run build`, **`npm link`** once for the bare `openhammer …` shortcut, or **`npx tsx src/cli.ts …`**
> during development without building.

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
full-screen, colored menu (built on [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui))
instead of juggling commands. Move with `↑`/`↓`, open a section with `Enter`, go back with `Esc`/`←`,
quit with `q`/`Ctrl-C`:

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

## Channels (how a client reaches you)

A **channel** is how a remote MCP client reaches the server. Add one with `openhammer channel add`
and it is persisted to `~/.openhammer/config.json` (secrets go to `~/.openhammer/credentials.json`,
`0600`).

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
- **Non-interactive CLI** (scripted / CI): `openhammer channel add --provider ngrok --authtoken "$T"`, `openhammer config set mcp.allowedClients claude-code`, `openhammer auth add-client --label ci` — flag-driven, no wizard, validated.

## Security

OpenHammer deliberately exposes a powerful surface — a connected client can run shell and touch the
filesystem **as the OS user running the server**. Treat the bearer token / OAuth client secret like a
password to your machine:

- **Bound the workspace.** Set `MCP_ROOT_DIR` to the directory you want the file tools scoped to.
  `read`/`write`/`edit`/`find`/`ls`/`grep` resolve under it — but **`bash` is not jailed** and reaches
  anything the OS user can.
- **Authenticate every connection.** Use the minted bearer, an OAuth client, or both. Secrets are
  stored `0600`; OAuth client secrets are kept only as a SHA-256 hash.
- **Run it in a container for isolation.** The container *is* the sandbox — mount only the target
  directory, set `MCP_ROOT_DIR`, and the blast radius is the container, not your host.
- **Don't tunnel without auth.** A public `ngrok`/`cloudflare` URL without a strong token gives the
  internet shell access to your machine.

## Architecture

- **Stateless MCP.** Per-request `Server` + `StreamableHTTPServerTransport` (`enableJsonResponse:true`),
  no `sessionIdGenerator` (the SDK's stateless mode).
- **Three auth paths.** The `/mcp` gate accepts, in fall-through order: the per-instance **opaque
  bearer** (constant-time compared; `MCP_AUTH_TOKEN` overrides) **or** an AS-issued HS256 JWT. The
  Authorization Server mints those JWTs via three grants — **client-credentials**
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
- **Result error model.** Tool `execute → Promise<Result<ToolOk, Error>>`; expected failures return
  `err(new Error(msg))`, never throw. The MCP `CallTool` handler is the single narrowing point, with a
  universal size backstop.

## Testing

Deterministic, no LLM — the "real client" is the MCP SDK `Client` driven by a script that asserts on
`callTool` text. Five tiers build on each other:

- **Hermetic trio** (`npm test`): Tier-0 units → Tier-1 in-process MCP E2E → Tier-2 boot + CLI E2E.
- **Containerized** (on-demand): `npm run test:compose`, `npm run test:compose:real`,
  `npm run test:in-container`.
- **Tunnel E2E** (gated, non-blocking — traverses a live edge): `npm run test:tunnel` (cloudflare) /
  `npm run test:tunnel:ngrok` (needs `NGROK_AUTHTOKEN` + the `ngrok` binary).

## Development

```bash
npm install
npm run build        # tsc → dist/
npm run typecheck    # tsc --noEmit over src + tests
npm run lint         # biome check
npm run format       # biome format --write
npm test             # vitest unit + in-process E2E suite
```

Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`). Coding standards live in
[`AGENTS.md`](./AGENTS.md) (high-signal) and [`docs/coding-standards.md`](./docs/coding-standards.md)
(detail). CI runs lint + typecheck + build on every PR; see [`.github/workflows/ci.yml`](./.github/workflows/ci.yml).

```text
src/{tools,mcp,auth,tunnel/providers,config,tui/wizards,cli,diagnostics,observability}
test/{e2e-hermetic,fixtures,compose}   Dockerfile · docker-compose.yml
docs/{coding-standards,agent-harness-design}.md
```

## Community

- **[openhammer.dev](https://openhammer.dev)** — the project home page.
- **[GitHub Discussions](https://github.com/harry-hathorn/openhammer/discussions)** — Q&A, ideas, and show-and-tell. The best place to ask questions.
- **[GitHub Issues](https://github.com/harry-hathorn/openhammer/issues)** — bugs and feature requests.
- Contributing — see [`CONTRIBUTING.md`](./CONTRIBUTING.md); vulnerability reports see [`SECURITY.md`](./SECURITY.md).
- Star the [repo](https://github.com/harry-hathorn/openhammer) if it's useful.

## License

[MIT](./LICENSE) © harry-hathorn
