/**
 * The dashboard render substrate (spec 19a + the spec-19 rebuild).
 *
 * A live, full-screen control center needs a render loop — full-screen,
 * differential redraw, resize-safe — that `@clack/prompts` (prompts/Q&A only)
 * cannot provide. This module is the `DashboardRenderer` seam (the terminal
 * I/O abstraction the dashboard logic talks to) plus its pi-tui implementation.
 *
 * **Why pi-tui (decided, evidence-based):** pi's own live interactive dashboard
 * runs on `@earendil-works/pi-tui`, so the render loop + differential redraw +
 * resize handling + synchronized output are proven for exactly this use. We use
 * only the general rendering half — a `TUI` with one root `Component` — not the
 * chat half (`Markdown`/`Editor`/…), which is dead weight accepted for the loop.
 * It is a **devDependency**: the dashboard is CLI-only; the prod image runs
 * `main.js`, which never imports this module (lazy-`import()`ed from the CLI so
 * the headless path never loads it).
 *
 * **The seam keeps the dashboard unit-testable** (spec 19f): `runDashboard` and its
 * tests drive a *fake* `DashboardRenderer` (no terminal at all); the pi-tui
 * implementation here is itself tested with a *fake* `Terminal` (no real TTY) —
 * `createDashboardRenderer({ terminal: fake, root })`.
 *
 * **Mounts a root `Component`** (the spec-19 rebuild): the dashboard is now a real
 * pi-tui component tree (the {@link DashboardRoot}), not a flat line buffer. The
 * renderer mounts `root` once, forwards every raw keystroke to `root.handleInput`,
 * and re-renders. (Was a `FrameProducer` returning `string[]`; the component tree
 * owns its own layout/color now.) `onKey` is gone — the root is the single input
 * handler (navigation + quit), so the renderer just forwards to it.
 *
 * **Lifecycle bar:** `stop()` restores the terminal (cooked mode, cursor,
 * bracketed-paste / Kitty sequences) and is idempotent. The caller (`runDashboard`)
 * MUST invoke it on every exit path (Ctrl-C, signal, error) so raw mode never leaks —
 * matching pi's `ui.stop()`-on-every-exit posture.
 */
import { type Component, ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";

/** Enter / exit the alternate screen buffer (xterm `smcup`/`rmcup`). The dashboard
 *  runs on the alt screen so its force-redraws never touch the main-screen banner. */
const ENTER_ALT_SCREEN = "\x1b[?1049h";
const EXIT_ALT_SCREEN = "\x1b[?1049l";

/**
 * The dashboard's terminal I/O abstraction. The dashboard logic (`runDashboard`)
 * talks only to this interface, so it runs under a fake in the hermetic trio; the
 * pi-tui implementation ({@link createDashboardRenderer}) is the production surface.
 *
 * - `start()`: enter raw mode and begin the render loop (renders the mounted root).
 * - `stop()`: tear down + restore the terminal. Idempotent.
 * - `clear()`: force a full screen clear + redraw on the next tick.
 * - `suspend()`/`resume()`: temporarily hand the terminal to a cooked-mode modal
 *   (a pi-tui wizard/command run by an action) and take it back. `stop()`/`start()`
 *   is NOT reentrant here (`stop()` removes the input listener permanently + sets a
 *   final flag), so modals use this lighter pair: `suspend()` = `tui.stop()` (cooked
 *   mode) with the cadence paused, `resume()` = `tui.start()` + a forced full redraw.
 *   The pi-tui input listener survives the cycle (its `Set` is untouched by
 *   `stop()`), so keys work again once resumed — the proven pi modal pattern.
 */
export interface DashboardRenderer {
	start(): void;
	stop(): void;
	clear(): void;
	/**
	 * Release the terminal for a cooked-mode modal (a pi-tui wizard/command run by an
	 * action): stop the render loop + refresh cadence and restore cooked mode. Pair
	 * with {@link DashboardRenderer.resume}. No-op if not started, already suspended,
	 * or permanently stopped.
	 */
	suspend(): void;
	/**
	 * Resume the render loop after {@link DashboardRenderer.suspend}: re-enter raw
	 * mode and force a full redraw (a modal used the alt/cleared screen). No-op if
	 * not currently suspended.
	 */
	resume(): void;
}

/**
 * Default re-render cadence. The dashboard subscribes to async state (the
 * status-socket NDJSON stream) that arrives outside the key path; this interval
 * pulls a fresh frame so live updates reach the screen without the dashboard
 * poking the renderer per event. pi-tui coalesces renders to ≥16ms, so a 150ms
 * tick (~7fps) is cheap and responsive. Set `refreshIntervalMs: 0` to disable
 * (tests drive renders manually).
 */
const DEFAULT_REFRESH_INTERVAL_MS = 150;

/** Injection seam for {@link createDashboardRenderer} (the `11a`/`13`/`17b`–`19a` precedent). */
export interface DashboardRendererDeps {
	/**
	 * The dashboard root component the TUI renders + whose `handleInput` receives
	 * every keystroke. Built by `runDashboard` ({@link DashboardRoot}); the renderer
	 * mounts it once and forwards input to it.
	 */
	root: Component;
	/** The pi-tui terminal to drive. Defaults to a real `ProcessTerminal` (`process.stdin`/`stdout`). Tests inject a fake. */
	terminal?: Terminal;
	/** Show a hardware cursor (pi-tui `showHardwareCursor`). Default `false` — the dashboard is key-driven, no caret. */
	showHardwareCursor?: boolean;
	/** Re-render cadence in ms (see {@link DEFAULT_REFRESH_INTERVAL_MS}). `0` disables. */
	refreshIntervalMs?: number;
}

/**
 * Build the pi-tui-backed `DashboardRenderer`. Mounts `root` on a `TUI` driven by
 * `terminal` (a real `ProcessTerminal` by default), enters raw mode + the
 * differential render loop on `start`, and restores the terminal on `stop`. Every
 * raw keystroke is forwarded to `root.handleInput` (which routes navigation +
 * actions) and then triggers a re-render; a refresh interval pulls fresh frames for
 * async state (the live socket feed). Modals `suspend()`/`resume()` the loop.
 */
export function createDashboardRenderer(deps: DashboardRendererDeps): DashboardRenderer {
	const terminal: Terminal = deps.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal, deps.showHardwareCursor ?? false);
	tui.addChild(deps.root);
	const root = deps.root;

	// Intercept every keypress before it reaches a focused component (the dashboard
	// root owns all input) and forward it to root.handleInput. Every key consumes and
	// triggers a redraw: the root mutates focus/screen state synchronously in
	// handleInput, so the re-render reflects it immediately. (Actions are async and
	// fire-and-forget from handleInput; they suspend/resume the loop themselves, so
	// this listener is idle while a modal holds the terminal.)
	const removeInputListener = tui.addInputListener((data) => {
		if (typeof root.handleInput === "function") {
			root.handleInput(data);
		}
		tui.requestRender();
		return { consume: true };
	});

	const interval = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let started = false;
	let stopped = false;
	/** True while a modal holds the terminal via {@link suspend}. */
	let suspended = false;

	const stopTimer = (): void => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
			refreshTimer = undefined;
		}
	};
	const startTimer = (): void => {
		if (interval > 0 && !refreshTimer) {
			refreshTimer = setInterval(() => {
				if (!stopped && !suspended) {
					tui.requestRender();
				}
			}, interval);
		}
	};

	return {
		start() {
			// Run on the **alternate screen buffer**. The banner (printed by `runCli`)
			// stays on the main screen and reappears when the dashboard exits — and
			// crucially, a force-clear/redraw on resume (after a modal) only touches the
			// alt screen, so the banner is never wiped (the original compaction bug).
			// `\x1b[H` homes the cursor: `\x1b[?1049h` enters the alt buffer but leaves the
			// cursor where the main screen had it (mid-screen after the banner), which drew
			// the first frame mid-screen (the "hammer in the middle" bug).
			terminal.write(`${ENTER_ALT_SCREEN}\x1b[H`);
			tui.start();
			started = true;
			startTimer();
		},
		suspend() {
			// No-op unless running and not already suspended: pause the cadence and
			// restore cooked mode (tui.stop) so a pi-tui modal can drive the terminal.
			// Stays on the alt screen — the modal renders in place, and resume force-
			// clears + redraws. The input listener (added once at construction) is left
			// in place — pi-tui keeps its input-listener Set across stop/start.
			if (!started || stopped || suspended) {
				return;
			}
			suspended = true;
			stopTimer();
			tui.stop();
		},
		resume() {
			// Re-enter raw mode + **force** a full clear + redraw. The dashboard runs on
			// the alt screen; a modal (runPrompt) rendered in place on it, so a force
			// clear wipes the modal's leftover and repaints the dashboard cleanly. (Safe
			// on the alt screen — the banner is on the main screen, untouched.) A
			// non-force diff after a modal is unreliable (pi-tui's frame cache drifts
			// across the suspend/resume), which is why the screen went blank/froze.
			if (!started || stopped || !suspended) {
				return;
			}
			suspended = false;
			tui.start();
			tui.requestRender(true);
			startTimer();
		},
		stop() {
			if (stopped) {
				return;
			}
			stopped = true;
			started = false;
			stopTimer();
			removeInputListener();
			tui.stop();
			terminal.write(EXIT_ALT_SCREEN); // leave the alt screen → restore the main screen (banner)
		},
		clear() {
			if (!stopped) {
				tui.requestRender(true); // force a full clear + redraw next tick
			}
		},
	};
}
