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
import { type Component, ProcessTerminal, type Terminal, TUI } from "@earendil-works/pi-tui";

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
