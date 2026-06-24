# 21 — UI consolidation: pi-tui only (drop `@clack/prompts` + `ora`)

## Purpose
Consolidate **all** interactive UI on `@earendil-works/pi-tui` and remove `@clack/prompts` and `ora`. Matches pi (which uses **only** pi-tui — zero prompt libraries). One render model for the dashboard (spec 19) **and** the wizards (channel add / config set / auth add-client), so a wizard launched from the dashboard is a pi-tui overlay — not a clack↔pi-tui modal dance. Fewer deps, one substrate, and the UI behaves consistently everywhere.

## Why (evidence)
pi uses **only pi-tui** for every prompt/select/settings — zero prompt libs in any pi package; its `theme-selector` / `settings-selector` / `session-selector` are pi-tui `SelectList` / `SettingsList` / `Input`. Once pi-tui is adopted for the dashboard (19a), keeping `clack` + `ora` too means extra libraries where pi uses one. The original "clack for wizards" rationale (avoid pi-tui's chat dead-weight for prompts) is **overturned**: pi-tui is a dependency regardless now, and pi proves its components are first-class prompt primitives.

## Approach — the io stays, the impl swaps (bounded by the injectable design)
The wizards (`addChannel` / `setSection`, 17k/17l) and the channel probe runner are **injectable** (`WizardIo`/`PromptIo` + the probe runner dep) and fully unit-tested with fakes — so their **logic + tests do not change**. The consolidation touches only the two **production impls**:
- `src/tui/prompts.ts` (17b) — `defaultIo` + `askSelect` / `askText` / `askSecret` / `askConfirm` / `withSession` (today: clack). → pi-tui.
- `src/tui/wizards/channel.ts` — the default probe runner's spinner (today: `ora`). → pi-tui `Loader`.

Verified scope: `@clack/prompts` is imported **only** in `prompts.ts`; `ora` **only** in the channel wizard's default probe runner. Contained swap, not a rewrite.

## The pi-tui prompt adapter (the crux)
pi-tui is a render-loop **component** system, not a one-shot prompt lib. To use its components as async, clack-shaped prompt functions, add a thin adapter:
- **`src/tui/prompt-loop.ts`** (new) — `runPrompt<T>(mount): Promise<T | null>`: boot a minimal pi-tui loop (`ProcessTerminal` + raw stdin into the `TUI`), mount the component as the root, await its `onSelect` / `onSubmit` / `onCancel` callback, then **tear down + restore the terminal** on every exit path (completion, Ctrl-C, error — no raw-mode leak). This is the load-bearing seam.
- **`prompts.ts`** re-implements the `PromptIo` surface on top of it:
  - `askSelect` → a `SelectList` (items = options) → chosen value / `null` on cancel.
  - `askText` / `askSecret` → an `Input` (masked for secret) → string / `null`.
  - `askConfirm` → a 2-item `SelectList` (yes/no) → boolean.
  - `withSession` → a `Text`/banner header (no clack `intro`/`outro`); the OpenHammer banner prints via `printBanner`.
  This mirrors how pi turns pi-tui components into prompts.

## Spinner: `ora` → pi-tui `Loader`
The channel wizard's default probe runner (the "validating…" spinner) swaps `ora(...)` for a pi-tui `Loader` / `CancellableLoader` (mounted via `prompt-loop`, or a non-blocking status line). `ora` is then removed.

## Files
- `src/tui/prompt-loop.ts` (new) — run-one-pi-tui-component-to-completion + terminal restore.
- `src/tui/prompts.ts` (rewrite 17b) — pi-tui `PromptIo` impl.
- `src/tui/wizards/channel.ts` — default probe runner: `ora` → pi-tui `Loader`.
- `package.json` — remove `@clack/prompts` + `ora` from `devDependencies`; regenerate `package-lock.json`.
- Dashboard (spec 19) — wizards render as pi-tui overlays/components (no clack modal dance); 19d's "calls the existing functions as modals" still holds, just on one substrate.
- Wizards (`channel.ts` / `section.ts`) + `wizard.ts` + their tests — **unchanged** (io-agnostic).

## Acceptance criteria
- `npm ls @clack/prompts ora` → empty; neither in devDeps or the lockfile; no import in `src`.
- `openhammer channel add` / `config set` / `auth add-client` work via pi-tui prompts (select provider, enter masked authtoken, confirm) — same UX as before.
- Terminal restored cleanly on completion / Ctrl-C / error (verify `stty` is sane after Ctrl-C mid-prompt — no raw-mode leak).
- Dashboard + wizards share one pi-tui substrate (a wizard from the dashboard is a pi-tui overlay, not a clack modal).
- Hermetic trio green: wizard tests unchanged (fake io); `prompt-loop` unit-tested via a virtual terminal / fake `ProcessTerminal`; the spinner via the injectable runner.

## Decisions & deviations
- **Consolidate on pi-tui** — match pi, one render model, −2 libs (`clack`, `ora`). Supersedes the earlier "clack for wizards" decision (evidence: pi uses only pi-tui; pi-tui is a dep regardless now).
- **Bounded by the injectable design** — only `prompts.ts` + the probe-runner spinner change; wizard logic + tests untouched. The loop's io-agnostic design is what makes this clean.
- **`prompt-loop` is load-bearing** — terminal restore on every exit path (Ctrl-C / error) is the correctness bar; raw-mode leaks are the classic TUI bug.
- **Supersedes** the clack/ora mentions in 17a (deps), 17b (prompts), and spec 19's "clack modals" → now pi-tui overlays. Spec 17 / 19 / the plan are updated to point here (21e).

## Suggested plan items (atomic checkboxes)
- [ ] 21a — `src/tui/prompt-loop.ts`: `runPrompt` (boot pi-tui loop, mount root, await callback, teardown + terminal restore on completion/Ctrl-C/error). + tests (virtual terminal / fake `ProcessTerminal`; restore-on-Ctrl-C). *deps: 19a.*
- [ ] 21b — rewrite `src/tui/prompts.ts` (17b) on pi-tui over `runPrompt`: `askSelect`=SelectList, `askText`/`askSecret`=Input (masked), `askConfirm`=SelectList, `withSession`=banner header. + tests (PromptIo contract; the existing wizard tests pass unchanged). *deps: 21a.*
- [ ] 21c — channel wizard default probe runner: `ora` → pi-tui `Loader`. + tests (injectable runner unchanged). *deps: 21a.*
- [ ] 21d — remove `@clack/prompts` + `ora` from `devDependencies`; `npm install` (regen lockfile); `grep -rn "@clack/prompts\|ora" src test README docs` → remove stragglers. *deps: 21b, 21c.*
- [ ] 21e — spec/docs sweep: spec 17 (17a deps, 17b prompts), spec 19 (modals → pi-tui overlays), README, the plan's 17a note → "clack/ora dropped, see spec 21." *deps: 21d.*
