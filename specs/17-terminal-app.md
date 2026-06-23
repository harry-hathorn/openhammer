# 17 — Terminal App, TUI Configuration, Channels & Settings

## Purpose
Grow OpenHammer from `npm start` into a **`openhammer` CLI** that mirrors pi's terminal-driven model: an interactive **TUI** (on `@clack/prompts`) that prints the README banner and drives configuration through a **schema-driven wizard**, backed by a **persisted settings document** + separate **credentials store**. The doc holds two families of **wizard-editable** configuration:

1. **Channels** — how OpenHammer is *reached*. Two modes: **live** (a process OpenHammer starts — ngrok, cloudflared quick-tunnel) and **static/deployed** (a public URL the operator stands up — nginx on a webserver, a fixed domain, a reverse proxy).
2. **Settings sections** — non-ingress config. The first is **`mcp.allowedClients`** (an MCP client allowlist); more sections arrive later.

A swappable **channel registry** (factory) + a **doctor** diagnostics registry complete the app. The wizard, `ConfigField` schema, and registries are deliberately domain-agnostic so further domains reuse them unchanged — **this is the scalability seam** ("it should also be used for configuring other things in the future").

Setup moves **out of env vars and into the terminal**: `openhammer channel add` / `openhammer config set` run the wizard and write `~/.openhammer`, the way `pi` configures instances/providers. The server still boots the same way (`openhammer start` / `npm start`), now honoring the persisted config with env/flags as an override.

## Source references
- pi terminal model: `packages/coding-agent` — `src/cli/args.ts` (command dispatch + `diagnostics[]`), `src/cli/config-selector.ts` + `modes/interactive/components/settings-selector.ts` (interactive selectors), `src/core/settings-manager.ts` (`Settings`/`SettingsStorage` persistence); `packages/ai/src/utils/diagnostics.ts` (the "doctor" diagnostics shape); the terminal UX mirrors pi's selectors but the **substrate is `@clack/prompts`**, not pi's chat-tuned `packages/tui` (see Decisions). Additional reference: `/home/haz/source/nodejs-cli-apps-best-practices` (§2.1 footprint, §1.5 rich interactions, §3.4 precedence, §1.3 stateful data).
- **Banner (single source):** `README.md` lines 1–22 — the ASCII hammer/anvil + `OPENHAMMER` block. `src/tui/banner.ts` mirrors it; a test parses README's first ```` ```text ```` fence and asserts byte-equality so the two can never drift.
- Existing OpenHammer reused here: `src/tunnel/cloudflare.ts` (`startTunnel`/`extractTunnelUrl` — wrapped as the live `cloudflare` channel), `src/auth/middleware.ts` (the bearer gate — the future `allowedClients` enforcement point), `src/auth/token.ts` (`credentialPath` + the `~/.openhammer` dir, `0700`/`0600`, atomic-write precedent), `src/tools/bin.ts` (`isToolAvailable`), `src/config.ts` (`loadConfig`), `src/main.ts`, `src/startup-print.ts`.

## Depends on
- spec 13 (`src/tunnel/cloudflare.ts` → wrapped live channel).
- spec 14 (`src/main.ts` → boot reads settings + the registry).
- spec 11 (`credentialPath`/`~/.openhammer` + the auth middleware that `allowedClients` later hooks).
- spec 07 (`isToolAvailable`).

## Architecture spine (the scalability seam)

The config doc holds **channels** + **settings sections**. Both are just "`ConfigField[]` the wizard renders + a place to persist the answers" — so the wizard and schema are written once and serve both families:

1. **`ConfigField` schema** (`src/tui/schema.ts`) — discriminated union (`text` | `secret` | `select` | `confirm`, with `options`/`default`/`required`/`help`). Any future domain declares `ConfigField[]`; it needs no UI code.
2. **Generic wizard** (`src/tui/wizard.ts`) — `runWizard(title, fields, io)` renders the banner then each field; `io` injectable so the field→value machine is unit-tested without a terminal.
3. **Channel registry** (`src/tunnel/types.ts` + `src/tunnel/index.ts`) — `ChannelProvider { kind, mode: "live"|"static", fields, isAvailable, probe?, start? }`, keyed by `kind` in `CHANNELS`. Adding a channel = one file + one registry line; no caller or wizard changes.
4. **Settings-section registry** (`src/config/sections.ts`) — `ConfigSection { id, label, fields, read(s), write(s, vals) }`. The first section is `mcp` (`allowedClients`).

## Files

### `src/tui/banner.ts` — `BANNER: string` + `printBanner(stream)`
The README banner (lines 1–22) verbatim. A co-located test reads `README.md`, extracts the first ```` ```text ```` fenced block, and asserts `BANNER === <that block>` — the README is the source of truth; the test refuses drift.

### `src/tui/prompts.ts` — thin adapters over `@clack/prompts`
- One module; **no custom render loop** — clack owns TTY/raw-mode rendering. `askSelect(options)`, `askText(label)`, `askSecret(label)` (masked), `askConfirm(label)` (each → `Promise<string|boolean|null>`, `null` = cancel), plus `withSession(title, fn)` (prints the banner via `printBanner` + clack `intro`/`outro`).
- These are the **production `io`** injected into `runWizard`; unit tests pass a fake `io`, so clack's TTY requirement never touches the hermetic trio.

### `src/tui/schema.ts` + `src/tui/wizard.ts`
```ts
export type ConfigField =
  | { key: string; label: string; kind: "text" | "secret"; default?: string; required?: boolean; help?: string }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[]; default?: string; required?: boolean; help?: string }
  | { key: string; label: string; kind: "confirm"; default?: boolean; help?: string };

export async function runWizard(title: string, fields: ConfigField[], io: WizardIo): Promise<Record<string, string> | null>;
```
- Walks `fields`, dispatching each `kind` to its primitive; `null` on cancel / required-empty. **Logic split from rendering**: a pure `reduceFields(fields, rawAnswers)` is unit-tested directly.

### `src/config/settings.ts` — persisted settings doc
```ts
export type ChannelMode = "live" | "static";
export type ChannelKind = "ngrok" | "cloudflare" | "nginx" | "static-url"; // const-object + derived union (erasableSyntaxOnly-safe); extensible
export interface ChannelEntry { id: string; kind: ChannelKind; mode: ChannelMode; label?: string; options: Record<string, string> }
export interface McpSettings { allowedClients: string[] }                   // [] | ["*"] = any; else a User-Agent allowlist (enforced in 17r; clientInfo needs sessions — deferred)
export interface Settings {
  version: number;
  channels: ChannelEntry[];
  defaultChannel: string | null;
  mcp: McpSettings;
}
```
- `settingsPath(homeDir = homedir())` → `~/.openhammer/config.json` (reuses spec 11's `~/.openhammer` dir). **Location (XDG deviation, §1.3):** best-practices prefer `$XDG_CONFIG_HOME` (`~/.config/openhammer`); we keep everything unified under `~/.openhammer` for consistency with the already-shipped `credential.json` (spec 11) — fragmenting state is worse than the deviation. An `OPENHAMMER_CONFIG_DIR` override can satisfy power users later.
- `loadSettings(path?)`: absent or corrupt → `{ version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } }` (doctor flags corrupt). `saveSettings(path, s)`: **atomic** (temp + `rename`), dir `0700`, file `0600` (spec-11 hygiene). `id` is `crypto.randomUUID()`; **secrets never live here** — only non-secret `options` + a credential `id` reference.

### `src/config/credentials.ts` — secrets store
- Separate `~/.openhammer/credentials.json` (`0700` dir / `0600` file), shape `Record<credId, Record<key, string>>`. `getCredentials(id)` / `setCredentials(id, values)` / `deleteCredentials(id)`. Mirrors pi's OAuth-credential split: the settings doc holds a `credId`, the value lives only in `credentials.json`.

### `src/config/sections.ts` — settings-section registry
```ts
export interface ConfigSection {
  id: string;                 // "mcp"
  label: string;              // wizard title
  fields: ConfigField[];      // the wizard renders these — e.g. allowedClients
  read(s: Settings): Record<string, string>;
  write(s: Settings, vals: Record<string, string>): Settings;   // immutable update
}
export const CONFIG_SECTIONS: Record<string, ConfigSection>;    // { mcp }
```
- The `mcp` section's `allowedClients` field is a comma/newline-list → `string[]` on write. Adding a settings section later = one entry, no wizard change (same engine as channels).

### `src/config.ts` (extend) — precedence merge
- Add `resolveConfig(args, env, settings): Config` following Node.js CLI best-practices §3.4: **CLI flags > env > local/project config > user config** — concretely `--channel <id>` (args) > `MCP_*`/`NGROK_AUTHTOKEN`/`MCP_ALLOWED_CLIENTS` (env) > the persisted `~/.openhammer` `Settings`. Env still wins over file (backward compatible); `loadConfig(env)` (spec 01) unchanged.

### `src/tunnel/types.ts` + `src/tunnel/index.ts` — channel registry
```ts
export interface ChannelHandle { url: string; stop?: () => Promise<void> }   // stop absent for static channels
export interface ChannelProvider {
  kind: ChannelKind;
  mode: ChannelMode;                                                        // "live" spawns; "static" just declares a URL
  fields: ConfigField[];                                                    // the wizard renders these — no per-channel UI
  isAvailable(options: Record<string, string>): Promise<boolean>;
  probe?(options: Record<string, string>): Promise<Result<void, Error>>;    // wizard validation
  start?(localPort: number, options: Record<string, string>): Promise<ChannelHandle | null>; // required for live, absent for static
  resolve?(options: Record<string, string>): ChannelHandle | null;          // static: returns the declared { url } (no spawn)
}
export const CHANNELS: Record<ChannelKind, ChannelProvider>;   // { ngrok, cloudflare, nginx, static-url }
export function getChannel(kind: ChannelKind): ChannelProvider | undefined;
```

### `src/tunnel/providers/cloudflare.ts` — live channel (wrap spec 13)
- `mode: "live"`, `fields: []` (zero-account quick-tunnel). `isAvailable` = `isToolAvailable("cloudflared")`. `start` delegates to `startTunnel(port)` (spec 13), mapping `{ url, child }` → `{ url, stop: async () => child.kill() }`. `null` when the binary is absent (unchanged graceful fallback).

### `src/tunnel/providers/ngrok.ts` — live channel (drives the `ngrok` CLI)
- `mode: "live"`, `fields: [{ key:"authtoken", label:"ngrok authtoken", kind:"secret", required:true, help:"dashboard.ngrok.com" }]`. `isAvailable` = `isToolAvailable("ngrok")` (the `ngrok` binary on PATH — same presence-check as `cloudflared`). `start` spawns `ngrok http <port>` (authtoken via `NGROK_AUTHTOKEN` env or `--authtoken`), then polls the CLI's local inspector API `GET http://127.0.0.1:4040/api/tunnels` for `tunnels[0].public_url` → `{ url, stop: () => child.kill() }`. `probe` = `fetch(url/health)` once the URL is up (under an `ora` spinner). `null` (never throws) when the binary is absent or no URL appears in time. **Why the CLI, not the `@ngrok/ngrok` SDK:** the SDK's bundled core defaults to QUIC/UDP, which hangs on the dev network (its JS API exposes no transport knob to flip it); the system CLI works locally and its `:4040` inspector API returns the URL with **no stdout-scraping**.

### `src/tunnel/providers/static.ts` — static/deployed channels (`nginx`, `static-url`)
- `mode: "static"`, **no `start`** — OpenHammer doesn't spawn anything; the operator stands up the public endpoint (nginx/reverse proxy on a server) that forwards to the local/port OpenHammer binds. `fields`: `publicUrl` (the declared URL), plus `static-url` vs `nginx` differ only in the label/help (nginx adds an optional `upstream` hint). `resolve(opts)` → `{ url: opts.publicUrl }` (no `stop`). `probe` = `fetch(publicUrl/health)` to confirm the operator's proxy actually reaches the server. These make "deploy to a webserver" a first-class persisted channel, not an afterthought.

### `src/tui/wizards/channel.ts` — the channel-add wizard
- select a `ChannelProvider` from `CHANNELS` → `runWizard(provider.fields)` → `provider.probe?.(answers)` (validate, under `ora`) → on success: append a `ChannelEntry` to `Settings`, write secrets via `setCredentials(id, …)`, set `defaultChannel` if first. Driven entirely by registry + schema — a new channel needs **zero wizard edits**.

### `src/tui/wizards/section.ts` — the settings-section wizard (`config set`)
- select a `ConfigSection` from `CONFIG_SECTIONS` → seed `runWizard` from `section.read(settings)` → `section.write(settings, answers)` → `saveSettings`. The `mcp` section edits `allowedClients` this way. Same wizard engine as channels — proves the scalability seam.

### `src/tunnel/manage.ts` — list / remove / use
- Pure `Result` ops over `Settings`: `listChannels`, `removeChannel(settings, id)` (also `deleteCredentials`), `setDefaultChannel(settings, id)`. The CLI calls these then `saveSettings`.

### `src/cli.ts` + `src/cli/args.ts` — dispatcher (mirror pi)
- `package.json` `"bin": { "openhammer": "dist/cli.js" }`. `parseArgs(argv): { command, rest, diagnostics: { type: "warning" | "error"; message }[] }` (pi's shape — unknown-option → diagnostic, never throws). Commands: default **or** `start` → boot (delegate to spec-14 `main()`); `channel { add | list | remove <id> | use <id> }`; `config { get | set [section] }` (set runs the section wizard, default section `mcp`); `doctor`. Interactive commands print the banner first.

### `src/diagnostics/registry.ts` + `src/cli/doctor.ts`
- `DiagnosticCheck { id; run(): Promise<{ status: "pass" | "warn" | "fail"; message }> }`. Checks: `config.json` parses; each `Settings.channels` entry's provider `isAvailable` (live) or `probe`-reachable (static); `credentials.json` perms `0600`; `rg`/`fd` present. `openhammer doctor` runs all, prints grouped by status. Mirrors pi's `diagnostics[]`.

### `src/auth/middleware.ts` (extend, 17r) — `allowedClients` enforcement
- When `settings.mcp.allowedClients` is non-empty and not `["*"]`, the bearer gate **additionally** checks the inbound **`User-Agent`** against the allowlist; a miss → `403` with a clear message. **Why User-Agent, not `clientInfo.name`:** OpenHammer is stateless — `initialize`'s `clientInfo` is **not retained across requests**, so it isn't available on a `tools/call`. `User-Agent` is the only per-request identity signal (true `clientInfo`-based enforcement needs sessions — deferred, spec 18). The **bearer token remains the real gate**; this is a secondary, best-effort client-type filter (spoofable by a token-holder, which is acceptable). Default `[]`/`["*"]` = any → **non-breaking**.

### `src/mcp/telemetry.ts` + `src/observability/status-socket.ts` — live activity capture
- A non-blocking `RequestRecorder` (in-memory ring buffer of the last N events + an active-client set + a subscriber list) fed by a Fastify `onRequest`/`onResponse` hook in the MCP transport: each `POST /mcp` records `{ ts, client (User-Agent; `clientInfo.name` only on `initialize`), method (initialize/tools/list/tools/call), tool?, reqBytes, resBytes, ms, status }`. Best-effort — never breaks the request path.
- A **Unix domain socket** at `~/.openhammer/openhammer.sock` (mode `0600`, local-only — no token, unreachable over the network) serves events as NDJSON: on connect it dumps the recent buffer, then streams live. This is the local "inspector" channel (ngrok's `:4040`, minus the network exposure).

### `src/cli/monitor.ts` + `src/tui/monitor-view.ts` — `openhammer monitor`
- Connects to the socket and prints a **live streaming feed** (tail-`f` style): `[12:01:03] claude-code  tools/call bash  1.2s 200B`, with a rolling header of active clients + call counts. **Streaming, not a full-screen dashboard** — no render loop, so it honors the §2.1 footprint rule (clack `intro` for the banner, then raw line output). A rich full-screen dashboard (which would justify a render lib like pi-tui/ink) is a deliberate future enhancement.

## Acceptance criteria
- `@clack/prompts` + `ora` install cleanly (small footprint, §2.1); ngrok is a **presence-checked binary, not an npm dep**; the hermetic trio stays green.
- The TUI prints the README banner verbatim (test pins `src/tui/banner.ts` to README's first ```` ```text ```` block).
- `openhammer channel add` persists **each** kind to `~/.openhammer/config.json` + secrets to `credentials.json` (`0600`): live (cloudflare, ngrok w/ authtoken) **and** static (nginx / static-url with a declared `publicUrl`), all resolved from the registry with **no wizard changes**.
- `openhammer config set mcp` edits `allowedClients` via the section wizard; `openhammer start` honors persisted `defaultChannel` (live → spawned; static → declared URL printed) while env/flags still override.
- `openhammer doctor` runs the check registry (incl. static-channel reachability) and prints pass/warn/fail, never throws.
- A new channel **and** a new settings section can each be added in one file + one registry line — proven by a unit test that registers a fake channel and a fake section and runs `runWizard` over both.
- With `mcp.allowedClients` set, a disallowed client gets `403`; with it empty/`["*"]`, behavior is unchanged (backward compatible).
- `openhammer monitor` (while the server runs) streams a live feed of connected clients + each inbound `tools/call` (client, tool, bytes, ms) over the local Unix socket — like watching an ngrok inspector, but local-only.
- **Tier-2 E2E** spawns `openhammer doctor` / `channel list` / `start` and asserts banner + output + clean exit. **Tier-4 E2E (gated)** drives a `tools/call` sweep through a public `*.ngrok.app` URL.

## Decisions & deviations
- **TUI substrate = `@clack/prompts`, not pi's `packages/tui`.** openhammer is a no-LLM config tool; pi-tui is a general rendering library that grew up inside a chat agent, so ~half its surface (`Markdown`/`marked`, the prompt `Editor`, slash-`autocomplete`, Kitty/iTerm2 `Image`) is permanent dead weight. The Node.js CLI best-practices guide (§2.1 *Prefer a small dependency footprint*) makes this a **mandate, not an exception**: `@clack/prompts` (MIT, 6 runtime deps) covers select/text/password/confirm (§1.5); `ora` covers the async probe spinner. pi stays the **behavioral** reference; clack is the substrate. Rejected: pi-tui as a published dep (too heavy); `file:../pi/packages/tui` (breaks the `Dockerfile`); rebuilding (forks one source of truth).
- **"Channel" is the umbrella, not "tunnel."** A channel is *how OpenHammer is reached*, and it has two modes: **live** (ngrok/cloudflare — OpenHammer starts a process and discovers the URL) and **static/deployed** (nginx on a webserver, a fixed URL — the operator stands up the endpoint and declares its URL). This makes "deploy to a server behind nginx" a first-class persisted configuration, persisted alongside live tunnels in `channels[]`, exactly as pi/open-claw persist provider/instance choices in `~`.
- **ngrok via the CLI inspector API, not the `@ngrok/ngrok` SDK** — the SDK's bundled core defaults to QUIC/UDP, which hangs on the dev network, and its JS API doesn't expose the tunnel-transport knob to flip it. The system `ngrok` CLI works locally and exposes a local inspector API at `http://127.0.0.1:4040/api/tunnels` that returns the public URL as JSON — so the provider gets the URL **programmatically with no stdout-scraping** (the original reason to prefer the SDK no longer applies). Tradeoff: the operator needs the `ngrok` binary on PATH (presence-checked, graceful `null` + install hint if absent — the same model `cloudflared` uses). **17i originally specced the SDK and shipped SDK-based; revised to the CLI in 17u after the SDK hung locally.**
- **Dependency placement** — `@clack/prompts` + `ora` are **`devDependencies`** (CLI/interactive-only; the prod image runs `node dist/main.js`, so `npm ci --omit=dev` stays lean, §2.1; the `openhammer` CLI runs on the operator's host). ngrok and cloudflare are both **external binaries, presence-checked at runtime** (`isToolAvailable`) — neither ships an npm dependency. (`@ngrok/ngrok` was a `dependencies` entry while 17i used the SDK; removed in 17u once the provider switched to the CLI.)
- **Single package, clean module boundaries** (`src/tui/`, `src/config/`, `src/tunnel/providers/`, `src/cli/`, `src/diagnostics/`) — conforms to the current repo (no monorepo split); boundaries stay package-clean for a future `pi`-style extraction.
- **Schema-driven wizard + dual registry = the scalability seam.** Channels and settings sections are both "`ConfigField[]` + persistence" — `runWizard` serves both; adding either is one file + one registry line, no UI changes. This is the explicit answer to "it should also configure other things in the future."
- **Secrets separated from config** (pi's OAuth-credential split): `config.json` holds `credId` references, `credentials.json` (`0600`) holds values. Atomic writes + `0700`/`0600` match the spec-11 precedent.
- **Configuration precedence (§3.4)** — `resolveConfig` layers CLI flags > env > persisted settings; the env-driven boot keeps working (spec-01 tests stay green) while the persisted doc fills the gaps. Non-breaking.
- **Result model holds** — `manage.ts` + `probe` return `Result`; `isAvailable`/`start`/`resolve` return `null` for the graceful-absent case (unchanged from spec 13). The CLI is the boot boundary (throws → actionable stderr + non-zero exit).
- **`allowedClients` enforcement is opt-in, non-breaking, and User-Agent-based** — default `[]`/`["*"]` = any client; only a non-wildcard list enables the `403` gate. Identity = inbound **`User-Agent`** (the only per-request signal in stateless mode — `initialize`'s `clientInfo.name` isn't retained without sessions, deferred spec 18). The bearer token stays the real gate; this is a secondary best-effort filter.
- **Live monitoring via a local Unix socket + streaming CLI** — the server records inbound activity to an in-memory ring and streams it over `~/.openhammer/openhammer.sock` (mode `0600`, local-only — no token, not network-reachable). `openhammer monitor` tails it. Deliberately a **streaming feed, not a full-screen dashboard**, so no render-loop dependency (§2.1); a richer dashboard is a future enhancement that would re-open the render-lib question.

## Suggested plan items (atomic checkboxes)
- [ ] 17a — deps + banner (`@ngrok/ngrok`→dependencies, `@clack/prompts`+`ora`→devDependencies; `src/tui/banner.ts` + README-pin test)
- [ ] 17b — prompt adapters over `@clack/prompts` (`src/tui/prompts.ts`: askSelect/askText/askSecret/askConfirm + withSession) — no custom render loop
- [ ] 17c — `ConfigField` schema + generic `runWizard` (`src/tui/{schema,wizard}.ts`, injectable io)
- [ ] 17d — settings doc (`src/config/settings.ts`: `channels[]`/`defaultChannel`/`mcp.allowedClients`; load/save atomic `0600`; `~/.openhammer` unified, XDG deviation noted)
- [ ] 17e — credentials store (`src/config/credentials.ts`: separate `0600` secrets keyed by id)
- [ ] 17f — config precedence (`src/config.ts` `resolveConfig`: flags > env > file, §3.4)
- [ ] 17g — channel registry (`src/tunnel/types.ts` + `src/tunnel/index.ts`: `ChannelProvider` w/ `mode` live|static + optional `start`/`resolve`)
- [ ] 17h — cloudflare channel (live; wrap spec 13 `startTunnel`)
- [ ] 17i — ngrok channel (live; **drives the `ngrok` CLI** — spawn + `:4040` inspector URL; presence-checked binary)
- [ ] 17u — *(revision to 17i, shipped SDK-based)* switch `src/tunnel/providers/ngrok.ts` to the CLI + **remove `@ngrok/ngrok`** from `dependencies`; update the test's injected fake (fake CLI spawn + `:4040` JSON). *deps: 17i.* **Why:** the SDK hangs locally (QUIC default, knob unexposed); the CLI works + needs no scraping.
- [ ] 17j — static channels (`nginx` + `static-url`: declared `publicUrl`, no `start`, `resolve()`+`probe`)
- [ ] 17k — channel-add wizard (`src/tui/wizards/channel.ts`)
- [ ] 17l — settings-section registry + section wizard (`src/config/sections.ts` + `src/tui/wizards/section.ts`; `mcp.allowedClients`)
- [ ] 17m — channel manage ops (`src/tunnel/manage.ts`: list/remove/use)
- [ ] 17n — CLI dispatcher (`src/cli.ts` + `src/cli/args.ts`, `bin: openhammer`)
- [ ] 17o — subcommands (`channel add/list/remove/use`, `config get/set`, default→boot)
- [ ] 17p — doctor (`src/diagnostics/registry.ts` + `src/cli/doctor.ts`; incl. static-channel reachability)
- [ ] 17q — `main.ts` via registry (`--channel <id>`/`defaultChannel` → live `start` or static `resolve`; null-safe)
- [ ] 17r — `mcp.allowedClients` enforcement (auth middleware `403` gate; default any, non-breaking)
- [ ] 17s — activity telemetry + status socket (`src/mcp/telemetry.ts` ring buffer + Fastify hook; `src/observability/status-socket.ts` NDJSON over `~/.openhammer/openhammer.sock` `0600`)
- [ ] 17t — `openhammer monitor` (`src/cli/monitor.ts` + `src/tui/monitor-view.ts`: streaming feed of clients + tool calls)
- [ ] T-cli-e2e (Tier-2) + T-ngrok-channel-e2e (Tier-4, gated) — see IMPLEMENTATION_PLAN
