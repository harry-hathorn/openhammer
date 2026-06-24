/**
 * The pi-tui prompt adapter (spec 21a) — the load-bearing seam that makes a
 * pi-tui `Component` usable as a one-shot async prompt function.
 *
 * pi-tui is a render-loop **component** system, not a one-shot prompt library.
 * To use its `SelectList` / `Input` as the clack-shaped `askSelect` / `askText` /
 * `askSecret` / `askConfirm` primitives (21b rewrites `prompts.ts` on top of
 * this), we boot a minimal `TUI`, mount the component as the root, and await its
 * `onSelect` / `onSubmit` / `onCancel` / `onEscape` callback — exactly how pi
 * turns pi-tui components into prompts
 * (`packages/coding-agent/src/cli/startup-ui.ts`'s `showStartupInput` /
 * `showStartupSelector`, and `cli/session-picker.ts`'s `selectSession`).
 *
 * **Input routing (why no manual listener):** the component is {@link TUI.setFocus|
 * focused}, so pi-tui delivers every raw keystroke to `focusedComponent.handleInput`
 * and calls `requestRender()` itself after each one (`tui.js handleInput`). Both
 * `Input` (Focusable) and `SelectList` (has `handleInput`) receive input this way,
 * and their state changes re-render without the adapter poking the loop. The
 * standard pi-tui keybindings — Enter confirms (`tui.select.confirm` /
 * `tui.input.submit`), Escape/Ctrl-C cancels (`tui.select.cancel`) — fire the
 * component's own callback, which calls {@link PromptResolver}, so cancel-on-Ctrl-C
 * is handled by the component, not a second listener here (mirrors pi).
 *
 * **The correctness bar — no raw-mode leak (spec 21 line 47):** the terminal is
 * restored (`tui.stop()` → cooked mode, cursor, Kitty/bracketed-paste off, stdin
 * paused) on **every** exit path via a `finally`: completion, cancel, Ctrl-C, and
 * a thrown `mount`/`start`. A `started` flag gates the `stop()` so a `mount` that
 * throws before `start()` does not call `stop()` on a terminal that never entered
 * raw mode (the `wasRaw`-capture happens in `start()`) — the 19a dashboard
 * renderer's `started`/`stopped` discipline. `TUI.stop()` is idempotent and
 * cancels the pending render timer, so a confirm keystroke's scheduled redraw
 * never fires after teardown.
 */
import { type Component, Loader, ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";

/**
 * Resolve the prompt: pass the chosen value, or `null` for cancel. Handed to a
 * {@link PromptMounter}, which wires the component's `onSelect`/`onSubmit`/
 * `onCancel`/`onEscape` callback to it. Resolves at most once (a second call is
 * a no-op) — the {@link runPrompt} `settled` guard absorbs a component that
 * fires both `onCancel` and `onSelect`.
 */
export type PromptResolver<T> = (value: T | null) => void;

/**
 * Build the component to mount, wiring its completion callback to {@link resolve}.
 * The returned component is mounted as the TUI root and focused (so pi-tui routes
 * raw input to its `handleInput`). The component owns its own confirm/cancel keys
 * (pi-tui defaults: Enter confirms, Escape/Ctrl-C cancels), so it — not the
 * adapter — decides when to call {@link resolve}.
 */
export type PromptMounter<T> = (resolve: PromptResolver<T>) => Component;

/** Injection seam for {@link runPrompt} (the `11a`/`13`/`17b`–`19d` precedent). */
export interface RunPromptDeps {
	/**
	 * The pi-tui terminal to drive. Defaults to a real `ProcessTerminal`
	 * (`process.stdin`/`stdout`); tests inject a fake so the hermetic trio never
	 * touches a real TTY.
	 */
	terminal?: Terminal;
	/**
	 * Show a hardware cursor (pi-tui `showHardwareCursor`). Default `true` — a
	 * focused `Input` emits the cursor marker so its caret shows for text entry.
	 * (Harmless for non-`Focusable` components like `SelectList`, which never
	 * emit the marker.)
	 */
	showHardwareCursor?: boolean;
}

/**
 * Boot a pi-tui loop, mount `mount`'s component, await its completion callback,
 * then restore the terminal. Resolves to the value the component passed to
 * `resolve`, or `null` on cancel.
 *
 * The `tui.stop()` in the `finally` is the raw-mode-restore guarantee — it runs
 * on completion, cancel, Ctrl-C, and any thrown `mount`/`start` (no leak). If
 * `mount` throws, the rejection propagates after the (skipped) teardown — the
 * caller surfaces it like any boot-boundary error.
 *
 * @example
 * // askSelect — a SelectList returns the chosen value or null on cancel
 * const value = await runPrompt<string>((resolve) => {
 *    const list = new SelectList(items, maxVisible, theme);
 *    list.onSelect = (item) => resolve(item.value);
 *    list.onCancel = () => resolve(null);
 *    return list;
 * });
 */
export async function runPrompt<T>(mount: PromptMounter<T>, deps: RunPromptDeps = {}): Promise<T | null> {
	const terminal: Terminal = deps.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal, deps.showHardwareCursor ?? true);

	// The promise the component resolves on completion/cancel. `settled` makes the
	// resolution one-shot; `resolveFn` is set by the (synchronous) Promise
	// executor before `mount` runs, and `?.` narrows it honestly (no `!`/`as`).
	let settled = false;
	let resolveFn: ((value: T | null) => void) | undefined;
	const completion = new Promise<T | null>((resolve) => {
		resolveFn = resolve;
	});
	const finish = (value: T | null): void => {
		if (settled) {
			return;
		}
		settled = true;
		resolveFn?.(value);
	};

	// `started` gates the teardown: a `mount`/`start` that throws before raw mode
	// is entered must NOT call `stop()` (which would restore `wasRaw` from a
	// `start()` that never ran). The body up to `await completion` is synchronous,
	// so `mount`/`addChild`/`setFocus`/`start` all run before the caller `await`s.
	let started = false;
	try {
		const component = mount(finish);
		tui.addChild(component);
		tui.setFocus(component); // pi-tui routes raw input to component.handleInput + re-renders
		tui.start();
		started = true;
		return await completion;
	} finally {
		if (started) {
			tui.stop(); // restore the terminal — no raw-mode leak on any exit path
		}
	}
}

/**
 * Format the spinner's final line from the awaited result (spec 21c). Called once
 * `fn` resolves so the "validating…" line is replaced with a success/failure
 * status before teardown — the `ora` `succeed()`/`fail()` parity. Generic so the
 * spinner stays domain-free: the channel wizard passes a `Result`-shaped
 * formatter (✓/✗), and this module imports no domain types.
 */
export type SpinnerFinalFormatter<T> = (result: T) => string;

/** Injection seam for {@link runSpinner} (the `11a`/`13`/`17b`–`21b` precedent). */
export interface SpinnerDeps {
	/**
	 * The pi-tui terminal to drive. Defaults to a real `ProcessTerminal`
	 * (`process.stdin`/`stdout`); tests inject a fake so the hermetic trio never
	 * touches a real TTY.
	 */
	terminal?: Terminal;
}

/**
 * The minimum delay to let a coalesced render flush. pi-tui coalesces renders to
 * ≥`MIN_RENDER_INTERVAL_MS` (16ms); the spinner's final status is painted by a
 * differential render, and {@link TUI.stop} cancels a pending render timer, so
 * the final line must land before teardown. ~7ms past the throttle is a safe,
 * imperceptible margin (this runs once, on the completion tail of an
 * interactive probe — never on a hot path).
 */
const SPINNER_FLUSH_MS = 25;

/**
 * Run a fallible async op under an animated pi-tui `Loader` spinner (spec 21c —
 * the `ora` replacement for the channel wizard's probe runner). Boots a minimal
 * `TUI`, mounts the `Loader` as the root, awaits `fn`, paints a final status
 * line via {@link SpinnerFinalFormatter}, then restores the terminal — the same
 * lifecycle/teardown discipline as {@link runPrompt}: a `started` flag gates
 * `stop()`, and the `finally` runs on completion, a thrown `fn`, and a thrown
 * `start`, so raw mode never leaks on any exit path.
 *
 * **Why a `Loader`, not `ora`:** consolidating on one render substrate (spec 21)
 * — the `Loader` is a pi-tui component, so it composes with the prompt loop's
 * terminal ownership and drops the `ora` devDependency (removed in 21d). The
 * `Loader` self-animates: its internal ~80ms interval calls
 * `tui.requestRender()`, so the spinner ticks while `fn` runs with no per-tick
 * poke from here. `Loader`'s color/theme fns are identity — v1 ships no color
 * layer (the 21b "selectListTheme is identity" posture).
 *
 * **The final status line is a differential in-place rewrite, not a force
 * render.** On completion the indicator is hidden (`frames: []`) and the message
 * swapped to the formatter's output; the coalesced render diffs the new line
 * against the last spinner frame and rewrites it in place — no stale spinning
 * glyph, no extra line. ({@link TUI.requestRender} `force=true` would reset the
 * diff state and *append* the status line below the frozen frame, so the
 * non-force path is the correct one.) The `await` lets that render flush before
 * `stop()` cancels its timer — without it the last spinning frame would stay
 * frozen on screen.
 *
 * @example
 * // the channel wizard's probe runner (Result → ✓/✗)
 * const r = await runSpinner("Validating nginx…", () => probe(answers),
 *   (result) => (result.ok ? `✓ Validating nginx…` : `✗ ${result.error.message}`));
 */
export async function runSpinner<T>(
	label: string,
	fn: () => Promise<T>,
	formatResult: SpinnerFinalFormatter<T>,
	deps: SpinnerDeps = {},
): Promise<T> {
	const terminal: Terminal = deps.terminal ?? new ProcessTerminal();
	const tui = new TUI(terminal, false); // no caret — a spinner takes no input
	// Identity color fns (no color layer in v1); the label is the spinner message.
	const loader = new Loader(
		tui,
		(s) => s,
		(s) => s,
		label,
	);
	tui.addChild(loader);

	let started = false;
	try {
		tui.start();
		started = true;
		const result = await fn();
		// Hide the spinning glyph and swap in the final status. setMessage →
		// updateDisplay → setText + a (non-force) requestRender; the coalesced
		// differential render rewrites the spinner line in place. Await the flush
		// so it lands before stop() cancels the pending render timer.
		loader.setIndicator({ frames: [] });
		loader.setMessage(formatResult(result));
		await new Promise((resolve) => setTimeout(resolve, SPINNER_FLUSH_MS));
		return result;
	} finally {
		loader.stop(); // clear the animation interval (a no-op after setIndicator)
		if (started) {
			tui.stop(); // restore the terminal — no raw-mode leak on any exit path
		}
	}
}
