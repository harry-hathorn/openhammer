# 19 — TUI Control Center (live dashboard)

## Purpose
One live, full-screen TUI — the **control center** — that replaces running isolated subcommands for interactive use. From a single screen you see: **server status** (URL / tunnel URL / token), **channels** (configured + live state), **connected clients**, and a streaming **monitor** feed — and you drive everything from a key menu (add/manage channels, edit config, run doctor, start/stop the server). The dashboard is a **view over the running server** (it subscribes to the existing status socket + reads settings), not a second server; it can also manage the server's lifecycle (start/stop a child) so `openhammer` is the single entry point. `openhammer` with no args in a TTY launches it.

## Source references
- Built on (spec 17): the status socket + NDJSON stream (`src/observability/status-socket.ts`, 17s), `monitor` (17t), the channel/settings registries + wizards (`src/tui/wizards/`, 17k/17l), the CLI (`src/cli.ts`, 17n/17o), settings (`src/config/settings.ts`).
- pi model + pi-tui API: its interactive mode (`packages/coding-agent/src/modes/interactive/interactive-mode.ts`) — a long-running live TUI over a running agent — is the **host-side driver pattern** OpenHammer follows. **Component API:** `packages/coding-agent/docs/tui.md` documents the pi-tui component system (`Component { render(width): string[]; handleInput?(data); invalidate() }`, `Container`/`Text`/`Box`/`Spacer`/`SelectList`/`SettingsList`, `matchesKey`/`Key`, `visibleWidth`/`truncateToWidth`/`wrapTextWithAnsi`, theming, overlays). **Note:** `tui.md` shows the *extension* surface (`ctx.ui.custom`); OpenHammer uses the *host-side* primitives (`TUI`, `ProcessTerminal`, the components) directly, like `interactive-mode.ts` — not the extension API.
- Node CLI best-practices (`/home/haz/source/nodejs-cli-apps-best-practices`): §1.5 rich interactions, §1.4 color.

## Depends on
- spec 17 (status socket, monitor, channels, wizards, CLI), spec 18 (guide), spec 14 (server boot, for lifecycle management).

## Architecture — a view over the running server
The dashboard is a **client** of the running server, not a host:
- **Live data** flows from the status socket (`~/.openhammer/openhammer.sock`, 17s): the **clients** panel + **monitor** feed subscribe to its NDJSON stream (the same source `openhammer monitor` tails today).
- **Channels panel** reads `~/.openhammer/config.json` (configured channels) + queries the server for live state (up/down, URL) — the server exposes channel state over the socket (a small addition to the status protocol).
- **Server lifecycle** (optional): the dashboard can start the server as a child if it's down (`openhammer` no-args + server unreachable → spawn `dist/main.js` + attach) and stop/restart it. This makes `openhammer` the single entry: launch the dashboard, which runs the server.

## The render substrate — **pi-tui** (decided, evidence-based)
A live dashboard needs a **render loop** (full-screen, differential redraw, resize-safe). `@clack/prompts` **cannot** do this — it is prompts/Q&A only — so spec 19 adds a render layer, and clack stays for the add/config **wizards**, which run as **modals** over the dashboard. The dashboard is built on **`@earendil-works/pi-tui`** (0.80.x, **2 runtime deps**, ~1.7MB, updated daily): pi's own live interactive dashboard (`modes/interactive/interactive-mode.ts`) runs on it, so the render loop + resize handling + layout components are proven for exactly this use. Wrapped behind a `DashboardRenderer` seam so the panel/render logic stays unit-testable.

Rejected (evidence-based):
- **ink** — **25 runtime deps** + React (`react-reconciler`, `yoga-layout`, `ws`…); too heavy a conceptual + transitive shift for a vanilla-TS project.
- **Hand-rolled ANSI** — zero deps, but the streaming monitor feed + resize-safe differential redraw + scrollback is the finicky, bug-prone part; a maintained lib wins on correctness + maintenance.

This is a **layer-specific** choice, not a reversal of spec 17: clack for *wizards* (prompts), pi-tui for the *dashboard* (render loop). The earlier "drop pi-tui" was for the wizard (its chat half was dead weight there); a dashboard uses the render-loop half, which is the point. `@earendil-works/pi-tui` → **`devDependencies`** (dashboard is CLI-only; the prod image runs `main.js`).
## Files
### `src/tui/dashboard.ts` — the control center
`runDashboard({ socketPath, settings, serverControl })` — the render loop. Renders four panels + a footer menu; subscribes to the status socket for live clients/monitor; reads settings for channels; handles keys. One process, one screen.
### `src/tui/dashboard/panels.ts` — status / channels / clients / monitor
Each panel is a **pure** `(state) => RenderOutput` function (unit-tested without a terminal); the loop composes them and feeds them live state from the socket + settings.
### `src/tui/dashboard/render.ts` — the `DashboardRenderer` abstraction
`interface DashboardRenderer { start(loop: () => void): void; stop(): void; onKey(cb: (key) => void): void; clear(): void }` — the seam; `19a` provides the **pi-tui** impl. Keeps the panel/render logic testable.
### `src/tui/dashboard/server-control.ts` — start/stop the server (lifecycle)
`ensureServer({ port })`: if the server isn't reachable (`GET /health`), spawn `dist/main.js` as a child (arg array, no shell — spawn hygiene); track it and stop it on dashboard exit. Makes `openhammer` a single entry that runs the server + the dashboard. `ensureServer`/`stopServer` return **`Result`** — a spawn failure or early child exit (`EADDRINUSE` surfaces as a non-zero exit code, not a throw) is an *expected* failure the dashboard surfaces, never a crash; matches the repo's "domain/ops → Result" split.
### `src/cli.ts` — `openhammer` (no args, TTY) → dashboard
Currently `openhammer` (no args) boots the server headless. Change: in a **TTY** with no subcommand, launch the **dashboard** (which starts/manages the server); the headless boot stays for non-TTY / `start` / containers.

## Acceptance criteria
- `openhammer` (no args, in a terminal) opens **one live screen**: server status, channels (configured + live), connected clients, monitor feed, and a key menu.
- Add a channel from the menu (a key) → the clack wizard runs as a **modal** → on finish the channels panel updates live (new channel appears; if started, its URL shows).
- The dashboard reflects server state in real time (a client connects → clients panel updates; a `tools/call` runs → monitor feed appends) over the status socket.
- If the server isn't running, `openhammer` starts it (child) and attaches; quitting the dashboard stops the child (no orphan server).
- Hermetic trio green: panel logic via the pure panel functions; rendering via the injectable `DashboardRenderer`.

## Decisions & deviations
- **Dashboard = view, not host.** It subscribes to the running server's status socket (already built, 17s) + reads settings; it does not re-implement server state. It may manage the server lifecycle (start/stop child) for a single-entry UX.
- **Reuse, don't reimplement** — the dashboard *calls the existing functions*, it does not fork them: `addChannel`/`setSection` (wizards → run as modals; their injectable `io` lets the dashboard host them instead of stdio), `doctorCommand` (injectable `io`), `listChannels`/`removeChannel`/`setDefaultChannel` (manage ops), and the status-socket protocol (`statusSocketPath` + `RequestEvent` NDJSON) for the monitor panel. The **only new code** is the render loop + panels + `ensureServer` (which spawns the existing `dist/main.js`). There is no second copy of the channel wizard, monitor, or doctor — one source of truth, used by both the one-line CLI and the dashboard.
- **Render substrate is layer-appropriate, not a reversal of spec 17.** clack stays the wizard substrate (prompts); the dashboard adds a render loop on **pi-tui** because clack cannot render a live screen. The earlier "drop pi-tui" was for the *wizard* (its chat half was dead weight there); a dashboard uses the render-loop half, which is exactly its purpose.
- **What we use vs don't in pi-tui** — we use the **general rendering half**: the `TUI` render loop, `Container`/`Text`/`Box`/`Spacer`/`SelectList`, `matchesKey`/`Key`, the width utils. We do **not** use the chat-oriented half (`Markdown` + its `marked` transitive dep, the multi-line `Editor`, slash-`autocomplete`, `Image`/terminal-image) — dead weight we accept (~1.7MB, `marked` installed transitively) because the render loop + components are worth it; forking pi-tui to strip them isn't worth the maintenance. **clack is kept, not removed** — it powers the wizard *prompts* (`channel add`/`config set`/`auth add-client`), which run as **modals** over the dashboard (suspend pi-tui → run the clack prompt → resume). Two complementary libs (pi-tui = dashboard render loop; clack = wizard prompts), one UX — not redundant.
- **Wizards are modals.** The add-channel/config wizards (clack) suspend the render loop, run, resume — one UX, two substrates composed.
- **`openhammer` no-args becomes the dashboard** in a TTY; headless boot stays for non-TTY / `start` / containers.
- **Footprint:** if pi-tui is chosen, it is a documented re-adoption for the dashboard layer only (§2.1 acknowledged — the dashboard is the justified case). Hand-rolled keeps zero new deps.

## Suggested plan items (atomic checkboxes)
- [ ] 19a — **pi-tui** `DashboardRenderer` adapter (raw-mode stdin via pi-tui, differential redraw, resize; substrate decided above). Add `@earendil-works/pi-tui` to **devDependencies**. *deps: 17.*
- [ ] 19b — dashboard layout + panels (status / channels / clients / monitor) as pure `(state) => RenderOutput` functions. *deps: 19a, 17.*
- [ ] 19c — status-socket client (subscribes via the **existing** `statusSocketPath()` + `RequestEvent` NDJSON — reuses 17s, **not a new socket** → live clients + monitor feed).
- [ ] 19d — key menu + the dashboard **calls the existing functions** as modals (`addChannel`/`setSection`/`doctorCommand`, injectable `io` — no reimplementation). *deps: 19b, 17k, 17l.*
- [ ] 19e — server lifecycle (start/stop the server as a child; `openhammer` no-args launches dashboard + server; clean shutdown). *deps: 19b, 14b.*
- [ ] 19f — tests (panel pure functions; renderer via injectable `DashboardRenderer`; lifecycle start/stop). *deps: 19b.*
