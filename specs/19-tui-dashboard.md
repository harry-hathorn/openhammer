# 19 — TUI Control Center (live dashboard)

> **Rebuild (post-v1).** The dashboard was rebuilt from a flat-ASCII panel view into a
> **navigable, colored pi-tui component tree** (pi-style): `↑↓` move, `Enter` drills into a
> section (Status / Channels / Clients & JWT / Monitor / Settings / Doctor), `Esc`/`←` goes back,
> `q`/Ctrl-C quits. The "press `r`/`a`/`c`/`d`/`q`" footer-key model and the identity (colorless)
> theme are gone. New files: `src/tui/style.ts` (raw-SGR color layer — no dep), `src/tui/dashboard/
> {store,view,screens,root}.ts`; `panels.ts` (the flat `composeDashboard`) is removed. The render
> substrate (`render.ts`) now mounts a root `Component` instead of a `FrameProducer`. The live-data
> wiring (socket-client, channel-probe, server-control) and the wizards are unchanged. The banner
> prints once (`runCli`) above the TUI. The rest of this spec is the original design; the rebuild
> supersedes the "flat panels / key-menu" framing in §Files/§Decisions below.

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
A live dashboard needs a **render loop** (full-screen, differential redraw, resize-safe) — a prompt lib like `@clack/prompts` cannot do this (prompts/Q&A only) — so spec 19 adds a render layer on **`@earendil-works/pi-tui`** (0.80.x, **2 runtime deps**, ~1.7MB, updated daily): pi's own live interactive dashboard (`modes/interactive/interactive-mode.ts`) runs on it, so the render loop + resize handling + layout components are proven for exactly this use. The add/config **wizards** run as **overlays** over the dashboard (suspend the dashboard loop, run, resume); **spec 21 moved them onto pi-tui too** (they were originally clack modals), so the dashboard + wizards share one substrate. Wrapped behind a `DashboardRenderer` seam so the panel/render logic stays unit-testable.

Rejected (evidence-based):
- **ink** — **25 runtime deps** + React (`react-reconciler`, `yoga-layout`, `ws`…); too heavy a conceptual + transitive shift for a vanilla-TS project.
- **Hand-rolled ANSI** — zero deps, but the streaming monitor feed + resize-safe differential redraw + scrollback is the finicky, bug-prone part; a maintained lib wins on correctness + maintenance.

This was originally a **layer-specific** choice (clack for *wizards*, pi-tui for the *dashboard*); **spec 21 unified both on pi-tui** — the wizards are now pi-tui overlays, so the dashboard + wizards share one substrate (no clack↔pi-tui modal dance). `@earendil-works/pi-tui` → **`devDependencies`** (dashboard + wizards are CLI-only; the prod image runs `main.js`).
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
- Add a channel from the menu (a key) → the wizard runs as a **pi-tui overlay** (suspends the dashboard loop, runs, resumes) → on finish the channels panel updates live (new channel appears; if started, its URL shows).
- The dashboard reflects server state in real time (a client connects → clients panel updates; a `tools/call` runs → monitor feed appends) over the status socket.
- If the server isn't running, `openhammer` starts it (child) and attaches; quitting the dashboard stops the child (no orphan server).
- Hermetic trio green: panel logic via the pure panel functions; rendering via the injectable `DashboardRenderer`.

## Decisions & deviations
- **Dashboard = view, not host.** It subscribes to the running server's status socket (already built, 17s) + reads settings; it does not re-implement server state. It may manage the server lifecycle (start/stop child) for a single-entry UX.
- **Reuse, don't reimplement** — the dashboard *calls the existing functions*, it does not fork them: `addChannel`/`setSection` (wizards → run as modals; their injectable `io` lets the dashboard host them instead of stdio), `doctorCommand` (injectable `io`), `listChannels`/`removeChannel`/`setDefaultChannel` (manage ops), and the status-socket protocol (`statusSocketPath` + `RequestEvent` NDJSON) for the monitor panel. The **only new code** is the render loop + panels + `ensureServer` (which spawns the existing `dist/main.js`). There is no second copy of the channel wizard, monitor, or doctor — one source of truth, used by both the one-line CLI and the dashboard.
- **Render substrate — superseded for wizards by spec 21.** The dashboard uses **pi-tui** because a prompt lib cannot render a live screen. Originally clack stayed the wizard substrate (layer-appropriate: prompts vs render loop); **spec 21 unified both on pi-tui** — the wizard chat-half "dead weight" no longer matters once pi-tui is a dep regardless.
- **What we use vs don't in pi-tui** — we use the **general rendering half**: the `TUI` render loop, `Container`/`Text`/`Box`/`Spacer`/`SelectList`, `matchesKey`/`Key`, the width utils. We do **not** use the chat-oriented half (`Markdown` + its `marked` transitive dep, the multi-line `Editor`, slash-`autocomplete`, `Image`/terminal-image) — dead weight we accept (~1.7MB, `marked` installed transitively) because the render loop + components are worth it; forking pi-tui to strip them isn't worth the maintenance. **clack/ora were dropped in spec 21** — the wizard *prompts* (`channel add`/`config set`/`auth add-client`) now run as **pi-tui overlays** over the dashboard (suspend the dashboard loop → run the pi-tui prompt → resume), so there is one substrate, not two.
- **Wizards are overlays.** The add-channel/config wizards suspend the render loop, run, resume — one UX, one substrate (pi-tui) post-spec-21 (originally two: pi-tui dashboard + clack wizards).
- **`openhammer` no-args becomes the dashboard** in a TTY; headless boot stays for non-TTY / `start` / containers.
- **Footprint:** if pi-tui is chosen, it is a documented re-adoption for the dashboard layer only (§2.1 acknowledged — the dashboard is the justified case). Hand-rolled keeps zero new deps.

## Suggested plan items (atomic checkboxes)
- [x] 19a — **pi-tui** `DashboardRenderer` adapter (raw-mode stdin via pi-tui, differential redraw, resize; substrate decided above). Add `@earendil-works/pi-tui` to **devDependencies**. *deps: 17.* **Shipped** (see `IMPLEMENTATION_PLAN.md` 19a). **Superseded by the rebuild below** — `FrameProducer`/`FrameComponent` removed; the adapter now mounts a root `Component`.
- [x] 19b — dashboard layout + panels (status / channels / clients / monitor) as pure `(state) => RenderOutput` functions. *deps: 19a, 17.* **Shipped, then superseded** — the flat `panels.ts` (`composeDashboard`) is removed; the rebuild replaces it with the component tree + pure view-models (`view.ts`).
- [x] 19c — status-socket client (subscribes via the **existing** `statusSocketPath()` + `RequestEvent` NDJSON — reuses 17s, **not a new socket** → live clients + monitor feed). **Shipped, unchanged by the rebuild.**
- [x] 19d — key menu + the dashboard **calls the existing functions** as modals (`addChannel`/`setSection`/`doctorCommand`, injectable `io` — no reimplementation). *deps: 19b, 17k, 17l.* **Shipped, then superseded** — the `r`/`a`/`c`/`d`/`q` footer-key model is replaced by the navigable menu; the "calls the existing functions as modals" principle is preserved (now `DashboardActions`).
- [x] 19e — server lifecycle (start/stop the server as a child; `openhammer` no-args launches dashboard + server; clean shutdown). *deps: 19b, 14b.* **Shipped, unchanged by the rebuild.**
- [x] 19f — tests (panel pure functions; renderer via injectable `DashboardRenderer`; lifecycle start/stop). *deps: 19b.* **Shipped, then superseded** — `dashboard-acceptance.test.ts`/`panels.test.ts` removed; replaced by `store`/`view`/`screens`/`root`/`style` tests + a rewritten `render.test.ts`/`dashboard.test.ts`.

## Rebuild (history — pi-style navigable component tree)
The dashboard was rebuilt from a flat-ASCII panel view into a **navigable, colored pi-tui component tree** (pi-style: `↑↓` move, `Enter` drill-in, `Esc`/`←` back, `q`/Ctrl-C quit). The live-data wiring (socket-client, channel-probe, server-control) and the wizards are unchanged. Each item below is checked off as shipped history (mirrors `IMPLEMENTATION_PLAN.md` `19-rebuild`).

- [x] **19r-a — color layer.** `src/tui/style.ts`: raw-SGR color helpers (`accent`/`success`/`error`/`warning`/`muted`/`dim`/`bold`/`inverse`/`border`/`borderAccent`) + a colored `selectListTheme`. **No new dependency** (raw ANSI, not `chalk`); `createStyle(false)` → identity so `NO_COLOR`/non-TTY render plain. `prompts.ts` adopts the colored theme. + `style.test.ts`.
- [x] **19r-b — live state.** `src/tui/dashboard/store.ts`: `DashboardStore` (status, settings/channels, `channelState`, `activeClients` via `MonitorState`, the monitor ring, the OAuth-client snapshot) + pure `apply*`/`set*` reducers. The state shapes (`ServerStatusState`/`ChannelLiveState`/`emptyStatus`) now live here. + `store.test.ts`.
- [x] **19r-c — view-models.** `src/tui/dashboard/view.ts`: pure `(state slice) => rows` helpers per screen (`channelRows`/`channelDetailRows`/`statusRows`/`clientRows`/`secretRevealRows`/`monitorRows`/`settingsRows`). pi-tui-free (returned to the screens, which apply color). + `view.test.ts`.
- [x] **19r-d — screens + root.** `src/tui/dashboard/screens.ts` (pure list/field-row builders + `renderList`/`renderFieldRows` + `MENU_SECTIONS`) and `src/tui/dashboard/root.ts` (`DashboardRoot`: a `Component` with a **discriminated-union** screen state — `menu | section | channel-detail | client-detail` — and `↑↓`/`Enter`/`Esc`/`q` routing; `DashboardActions` injected so it does no I/O). + `screens.test.ts`, `root.test.ts` (key routing via direct `handleInput`+`render`).
- [x] **19r-e — renderer.** `src/tui/dashboard/render.ts` rewritten: `start()` mounts the root `Component` (drops `FrameProducer`/`FrameComponent`); keeps `DashboardRenderer` (`start`/`stop`/`clear`/`suspend`/`resume`) + the refresh cadence; forwards raw input to `root.handleInput`. + `render.test.ts` (FakeTerminal + `flush`, lifecycle/keys/suspend-resume/clear/resize).
- [x] **19r-f — wiring.** `src/tui/dashboard.ts` `runDashboard`: builds store+root+renderer, wires `createSocketSubscriber`/`createChannelProbe` → store, and connects `DashboardActions` (addChannel/editSettings/issueClient/removeChannel/useChannel/removeClient/runDoctor/quit) — each `suspend()`→run→`resume()`, persist+update-store on `ok`. `src/cli.ts` `defaultDashboard` wires `doctorRunner` (captures `doctorCommand` output — `src/tui/` imports no `src/cli/`). Banner prints once (`runCli`), above the TUI. + `dashboard.test.ts` (lifecycle/subscribe/quit/action+doctor wiring).
- [x] **19r-g — debt removed + docs.** `panels.ts`/`panels.test.ts`/`dashboard-acceptance.test.ts` deleted; `view.ts` comment + `specs/19` + `IMPLEMENTATION_PLAN.md` (`19-rebuild`) + `README.md` updated. **Standards:** no new dep; Result spine; `void` fire-and-forget (no floating promises); no `any`/`as`; discriminated-union state; hermetic tests. Trio green (**895 passed** / 1 pre-existing unrelated `doctor` oauth-jwt-secret env failure / 1 skipped); real-PTY smoke: banner once, menu renders, `q` quits cleanly.
