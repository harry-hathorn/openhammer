/**
 * The color/style layer — raw-SGR helpers + a colored `SelectListTheme` (spec 19
 * color polish). **No dependency:** the helpers emit standard ANSI SGR sequences
 * directly (the `node:`-free string layer), so this adds nothing to the dep
 * graph — consistent with the small-deps principle (no `chalk`, which isn't even
 * transitively installed). `createStyle(false)` yields identity fns, so the same
 * components render correctly in CI logs / `NO_COLOR` / piped output.
 *
 * **Why raw SGR over `chalk`:** the whole TUI layer consolidated on pi-tui (spec
 * 21) precisely to drop prompt/spinner libs; adding `chalk` for color would
 * reverse that. pi-tui's `SelectListTheme`/`Box` bg fns are plain `(text) =>
 * string`, so a few SGR wrappers are all the color layer needs. pi itself uses a
 * heavyweight theme system (`chalk` + typebox + JSON themes + syntax highlight) —
 * deliberately out of scope for this vanilla-TS project.
 *
 * **SGR choice — the 16-color base set**, not truecolor: cyan/green/red/yellow/
 * bright-black work on every terminal (including the 16-color Linux console and
 * minimal Windows consoles), so the dashboard reads well everywhere without
 * capability detection. Each fn resets only the attribute it set (`\x1b[39m` for
 * foreground, `\x1b[22m` for bold/dim, `\x1b[27m` for inverse) so styles don't
 * bleed across segments within a line. pi-tui appends a full reset + OSC 8 reset
 * at the end of each rendered line (per `packages/.../tui.md`), so styles never
 * carry across lines regardless.
 *
 * **`visibleWidth` is ANSI-aware** (pi-tui `utils.ts`), so wrapping content in
 * these escapes does not corrupt the width math the components use to clip/center
 * lines — the identity-when-disabled posture is the only thing `style.test.ts`
 * needs to assert about widths.
 */
import type { SelectListTheme } from "@earendil-works/pi-tui";

/**
 * The style surface: a set of `(text) => string` wrappers + a ready-made
 * `SelectListTheme`. Every fn is the identity when `enabled` is false, so a
 * component built from a {@link Style} renders plain text in a non-TTY / `NO_COLOR`
 * context and colored text in a terminal — the same code path both ways.
 */
export interface Style {
	/** Color/style wrappers (identity when disabled). */
	accent: (text: string) => string;
	success: (text: string) => string;
	error: (text: string) => string;
	warning: (text: string) => string;
	muted: (text: string) => string;
	dim: (text: string) => string;
	bold: (text: string) => string;
	inverse: (text: string) => string;
	border: (text: string) => string;
	borderAccent: (text: string) => string;
	/** A colored `SelectListTheme` for menus/pickers (identity fns when disabled). */
	selectListTheme: SelectListTheme;
}

/** Wrap `text` in an SGR `on` sequence and reset only that attribute with `off`. */
function sgr(on: string, off: string): (text: string) => string {
	return (text: string) => `${on}${text}${off}`;
}

/** Identity — the disabled-path renderer (and the base every fn falls back to). */
const identity = (text: string): string => text;

// Foreground SGR codes (16-color base — universally supported). `\x1b[39m` resets fg.
const FG = {
	accent: "\x1b[36m", // cyan
	success: "\x1b[32m", // green
	error: "\x1b[31m", // red
	warning: "\x1b[33m", // yellow
	muted: "\x1b[90m", // bright black (gray)
	border: "\x1b[90m", // gray
	borderAccent: "\x1b[36m", // cyan
};
const RESET_FG = "\x1b[39m";

/**
 * Build a {@link Style}. `enabled` decides whether the fns emit SGR codes or are
 * the identity — pass {@link isColorEnabled} for the auto-detected production
 * style, or an explicit boolean for tests (`createStyle(true)` → ANSI-wrapped,
 * `createStyle(false)` → identity). Pure: no shared module state, so tests stay
 * independent/deterministic (the `docs/coding-standards.md` §Tests rule).
 *
 * The `selectListTheme` highlights the selected row in accent+bold (the `→ marker`
 * and the whole selected line) and renders descriptions/scroll info in muted/dim —
 * the readable, single-accent menu look the dashboard's `SelectList`-based menu
 * and the wizard pickers share.
 */
export function createStyle(enabled: boolean): Style {
	if (!enabled) {
		const disabled: Style = {
			accent: identity,
			success: identity,
			error: identity,
			warning: identity,
			muted: identity,
			dim: identity,
			bold: identity,
			inverse: identity,
			border: identity,
			borderAccent: identity,
			selectListTheme: {
				selectedPrefix: identity,
				selectedText: identity,
				description: identity,
				scrollInfo: identity,
				noMatch: identity,
			},
		};
		return disabled;
	}
	const accent = sgr(FG.accent, RESET_FG);
	const bold = sgr("\x1b[1m", "\x1b[22m");
	const highlight = (text: string): string => bold(accent(text));
	const themed: Style = {
		accent,
		success: sgr(FG.success, RESET_FG),
		error: sgr(FG.error, RESET_FG),
		warning: sgr(FG.warning, RESET_FG),
		muted: sgr(FG.muted, RESET_FG),
		dim: sgr("\x1b[2m", "\x1b[22m"),
		bold,
		inverse: sgr("\x1b[7m", "\x1b[27m"),
		border: sgr(FG.border, RESET_FG),
		borderAccent: sgr(FG.borderAccent, RESET_FG),
		selectListTheme: {
			selectedPrefix: highlight,
			selectedText: highlight,
			description: sgr(FG.muted, RESET_FG),
			scrollInfo: sgr("\x1b[2m", "\x1b[22m"),
			noMatch: sgr(FG.warning, RESET_FG),
		},
	};
	return themed;
}

/**
 * Auto-detect whether color should be emitted: disabled when `NO_COLOR` is set
 * (the https://no-color.org convention — any value, even empty) or `FORCE_COLOR`
 * is `"0"`; otherwise enabled when stdout is a TTY. Memoized per process; the
 * dashboard/prompts always run in a TTY (launched only when `isTTY`, per
 * `src/cli.ts`), so this resolves `true` for them and `false` under CI/pipes.
 */
export function isColorEnabled(env: NodeJS.ProcessEnv = process.env, isTTY = process.stdout.isTTY === true): boolean {
	if (env.NO_COLOR !== undefined) return false;
	if (env.FORCE_COLOR === "0") return false;
	return isTTY;
}

/**
 * The production style — auto-detected at module load. `src/tui/prompts.ts` and
 * the dashboard components import this for their default coloring; tests build
 * `createStyle(true)` / `createStyle(false)` explicitly.
 */
export const style: Style = createStyle(isColorEnabled());
