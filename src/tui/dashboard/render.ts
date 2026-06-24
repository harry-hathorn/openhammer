/**
 * The dashboard render substrate (spec 19a).
 *
 * A live, full-screen control center needs a render loop — full-screen,
 * differential redraw, resize-safe — that `@clack/prompts` (prompts/Q&A only)
 * cannot provide. This module is the `DashboardRenderer` seam (the terminal
 * I/O abstraction the dashboard logic talks to) plus its pi-tui implementation.
 *
 * **Why pi-tui (decided, evidence-based):** pi's own live interactive dashboard
 * runs on `@earendil-works/pi-tui` (0.80.x, 2 runtime deps, ~1.7MB, updated
 * daily), so the render loop + differential redraw + resize handling +
 * synchronized output are proven for exactly this use. We use only the general
 * rendering half — a `TUI` with one root `Component` — not the chat half
 * (`Markdown`/`Editor`/…), which is dead weight accepted for the render loop.
 * It is a **devDependency**: the dashboard is CLI-only; the prod image runs
 * `main.js`, which never imports this module (19e will lazy-`import()` it from
 * the CLI so the headless path never loads it).
 *
 * **The seam keeps the dashboard unit-testable** (spec 19f): `runDashboard`
 * (19b) and its tests drive a *fake* `DashboardRenderer` (no terminal at all);
 * the pi-tui implementation here is itself tested with a *fake* `Terminal` (no
 * real TTY) — `createDashboardRenderer({ terminal: fake })`.
 *
 * **Lifecycle bar:** `stop()` restores the terminal (cooked mode, cursor,
 * bracketed-paste / Kitty sequences) and is idempotent. The caller (19e) MUST
 * invoke it on every exit path (Ctrl-C, signal, error) so raw mode never leaks —
 * matching pi's `ui.stop()`-on-every-exit posture.
 *
 * Deviation from spec 19 line 34's sketched
 * `{ start(loop: () => void); stop(); onKey(cb: (key) => void); clear() }`:
 * - `loop: () => void` → `start(produceFrame: (width, height) => string[])`.
 *   pi-tui's root `Component.render(width): string[]` *is* the frame source the
 *   `TUI` differentially redraws; making the loop *return* the frame (and receive
 *   the terminal size for layout) is the natural pull model that is also directly
 *   testable — a `void` loop would need an out-of-band frame-push method not in
 *   the spec interface.
 * - `cb: (key) => void` → `cb: (data: string) => void`. pi-tui delivers raw
 *   input sequences; `matchesKey(data, "ctrl+c")` / `parseKey(data)` operate on
 *   that raw string, so delivering it verbatim (rather than re-parsing into a
 *   narrower shape) is the faithful, flexible contract the dashboard's key menu
 *   (19d) builds on.
 */
import { type Component, ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";

/**
 * Produce the dashboard frame as a list of screen lines for the given terminal
 * size. Called on every render tick (after a key, on resize, and on the refresh
 * cadence); the return value is what pi-tui differentially redraws. Pure with
 * respect to the terminal — read live state (settings, the status-socket feed)
 * and return lines; never write to the terminal from here.
 */
export type FrameProducer = (width: number, height: number) => string[];

/**
 * The dashboard's terminal I/O abstraction. The render loop + panel logic
 * (19b/19c/19d) talk only to this interface, so they run under a fake in the
 * hermetic trio; the pi-tui implementation ({@link createDashboardRenderer}) is
 * the production surface.
 *
 * - `start(produceFrame)`: enter raw mode and begin the render loop. The frame
 *   producer is pulled on each tick for the current screen.
 * - `stop()`: tear down + restore the terminal. Idempotent.
 * - `onKey(cb)`: register the key handler; `data` is the raw pi-tui input
 *   sequence (match it with `matchesKey`/`parseKey` from pi-tui).
 * - `clear()`: force a full screen clear + redraw on the next tick.
 * - `suspend()`/`resume()`: temporarily hand the terminal to a cooked-mode modal
 *   (a pi-tui wizard, 19d) and take it back. `stop()`/`start()` is NOT reentrant
 *   here (`stop()` removes the input listener permanently + sets a final flag),
 *   so modals use this lighter pair: `suspend()` = `tui.stop()` (cooked mode) with
 *   the cadence paused, `resume()` = `tui.start()` + a forced full redraw. The
 *   pi-tui input listener survives the cycle (its `Set` is untouched by `stop()`),
 *   so keys work again once resumed — the proven pi modal pattern
 *   (`interactive-mode`'s external-editor bracket).
 */
export interface DashboardRenderer {
	start(produceFrame: FrameProducer): void;
	stop(): void;
	onKey(cb: (data: string) => void): void;
	clear(): void;
	/**
	 * Release the terminal for a cooked-mode modal (a pi-tui wizard, 19d): stop the
	 * render loop + refresh cadence and restore cooked mode (the inverse of
	 * {@link DashboardRenderer.start}'s raw-mode entry). Pair with
	 * {@link DashboardRenderer.resume}. No-op if not started, already suspended, or
	 * permanently stopped.
	 */
	suspend(): void;
	/**
	 * Resume the render loop after {@link DashboardRenderer.suspend}: re-enter raw
	 * mode and force a full redraw (a pi-tui modal uses the alternate/cleared screen,
	 * so the resumed dashboard must repaint fully). No-op if not currently suspended.
	 */
	resume(): void;
}

/**
 * Default re-render cadence. The dashboard subscribes to async state (the
 * status-socket NDJSON stream, 17s/19c) that arrives outside the key/resize
 * path; this interval pulls a fresh frame so live updates reach the screen
 * without the dashboard poking the renderer per event. pi-tui coalesces renders
 * to ≥16ms, so a 150ms tick (~7fps) is cheap and responsive. Set
 * `refreshIntervalMs: 0` to disable (tests drive renders manually).
 */
const DEFAULT_REFRESH_INTERVAL_MS = 150;

/** Injection seam for {@link createDashboardRenderer} (the `11a`/`13`/`17b`–`17t` precedent). */
export interface DashboardRendererDeps {
	/** The pi-tui terminal to drive. Defaults to a real `ProcessTerminal` (`process.stdin`/`stdout`). Tests inject a fake. */
	terminal?: Terminal;
	/** Show a hardware cursor (pi-tui `showHardwareCursor`). Default `false` — the dashboard is view-only. */
	showHardwareCursor?: boolean;
	/** Re-render cadence in ms (see {@link DEFAULT_REFRESH_INTERVAL_MS}). `0` disables. */
	refreshIntervalMs?: number;
}

/**
 * The dashboard's root component: its `render(width)` returns whatever the
 * latest frame producer yields. pi-tui owns the differential redraw + resize
 * detection + synchronized output — this component is just the frame source the
 * `TUI` diffs against each tick. `render` receives only `width` (pi-tui's
 * `Component` contract); the height is folded in by the closure that adapts the
 * width-only producer to the {@link FrameProducer} `(width, height)` signature.
 */
class FrameComponent implements Component {
	produce: ((width: number) => string[]) | undefined;

	render(width: number): string[] {
		return this.produce?.(width) ?? [];
	}

	invalidate(): void {
		// No cached state — the producer reads live state on every render.
	}
}

/**
 * Build the pi-tui-backed `DashboardRenderer`. Mounts a root frame component on
 * a `TUI` driven by `terminal` (a real `ProcessTerminal` by default), enters raw
 * mode + the differential render loop on `start`, and restores the terminal on
 * `stop`. Keys are intercepted before any (non-existent) focused component and
 * forwarded to the `onKey` handler; because a *consumed* input short-circuits
 * pi-tui's own post-input `requestRender`, the listener requests the redraw
 * itself. A refresh interval pulls fresh frames for async state.
 */
export function createDashboardRenderer(deps: DashboardRendererDeps = {}): DashboardRenderer {
	const terminal: Terminal = deps.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal, deps.showHardwareCursor ?? false);
	const root = new FrameComponent();
	tui.addChild(root);

	let keyHandler: ((data: string) => void) | undefined;
	// Intercept every keypress before it reaches a focused component (the dashboard
	// has none — it is a key-menu view) and forward it to the handler. The dashboard
	// owns all input, so every key consumes and triggers a redraw: a *consumed* input
	// returns early from the TUI's handleInput — before its own requestRender — and
	// an *unconsumed* one with no focused component never reaches that requestRender
	// either, so the redraw must be requested here either way. (Modals suspend the
	// loop entirely and run a pi-tui wizard, so this listener is idle then.)
	const removeInputListener = tui.addInputListener((data) => {
		keyHandler?.(data);
		tui.requestRender();
		return { consume: true };
	});

	const interval = deps.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS;
	let refreshTimer: ReturnType<typeof setInterval> | undefined;
	let started = false;
	let stopped = false;
	/** True while a modal (19d) holds the terminal via {@link suspend}. While set,
	 * the refresh cadence is paused and the TUI is in cooked mode. */
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
		start(produceFrame) {
			root.produce = (width) => produceFrame(width, terminal.rows);
			tui.start();
			started = true;
			startTimer();
		},
		suspend() {
			// No-op unless running and not already suspended: pause the cadence and
			// restore cooked mode (tui.stop) so a pi-tui modal can drive the terminal.
			// The input listener (added once at construction) is left in place — pi-tui
			// keeps its input-listener Set across stop/start, so keys return on resume.
			if (!started || stopped || suspended) {
				return;
			}
			suspended = true;
			stopTimer();
			tui.stop();
		},
		resume() {
			// Re-enter raw mode + force a full redraw (a modal used the alt/cleared
			// screen), then restart the cadence. The input listener is still registered.
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
		},
		onKey(cb) {
			keyHandler = cb;
		},
		clear() {
			if (!stopped) {
				tui.requestRender(true); // force a full clear + redraw next tick
			}
		},
	};
}
