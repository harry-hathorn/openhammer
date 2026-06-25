/**
 * pi-tui prompt adapters (spec 21b) — the production {@link defaultIo} drives
 * real pi-tui components (`SelectList` / `Input`) through the one-shot
 * {@link runPrompt} adapter (spec 21a), replacing `@clack/prompts`.
 *
 * **Logic split from rendering:** all interactive UI lives behind the
 * {@link PromptIo} seam. The production {@link defaultIo} wraps real pi-tui
 * (booting a component via `runPrompt`); unit tests inject a fake `io` returning
 * clean `T | null` values, so the TTY/raw-mode requirement never touches the
 * hermetic trio. The adapters + `withSession` are pure orchestration over that
 * contract — which is why the wizard tests (and {@link flagIo}) are byte-identical
 * to the clack era: only the two production impls (`defaultIo` + the probe
 * spinner, 21c) swap substrate.
 *
 * - `askSelect` → a `SelectList` (items = options) → chosen value / `null`.
 * - `askText` / `askSecret` → an `Input` (masked for secret) → string / `null`.
 * - `askConfirm` → a 2-item `SelectList` (Yes/No) → boolean / `null`.
 * - `withSession` → the OpenHammer banner header (no clack `intro`/`outro`).
 *
 * This mirrors how pi turns pi-tui components into prompts
 * (`packages/coding-agent/src/cli/startup-ui.ts`).
 */
import {
	type Component,
	CURSOR_MARKER,
	Input,
	type SelectItem,
	SelectList,
	type Terminal,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { type BannerStream, printBanner } from "./banner.ts";
import { runPrompt } from "./prompt-loop.ts";
import { style } from "./style.ts";

/** A selectable choice; the `SelectList` renders `label` (or `value`) and returns `value`. */
export interface SelectOption {
	value: string;
	label?: string;
	hint?: string;
}

/** Options for {@link askSelect} / `PromptIo.select`. */
export interface AskSelectOptions {
	message: string;
	options: SelectOption[];
	/** Pre-selected value (clack `initialValue`). */
	initialValue?: string;
}

/** Options for `PromptIo.text` (the wizard can pass defaults; `askText` only sets the message). */
export interface AskTextOptions {
	message: string;
	placeholder?: string;
	defaultValue?: string;
	initialValue?: string;
}

/** Options for `PromptIo.confirm`. */
export interface AskConfirmOptions {
	message: string;
	initialValue?: boolean;
}

/**
 * The injectable prompt-primitive bundle. Each method resolves to the chosen
 * value or `null` on cancel. `intro`/`outro` frame a session. The production impl
 * is {@link defaultIo}; tests pass a fake.
 */
export interface PromptIo {
	select(options: AskSelectOptions): Promise<string | null>;
	text(options: AskTextOptions): Promise<string | null>;
	password(options: { message: string }): Promise<string | null>;
	confirm(options: AskConfirmOptions): Promise<boolean | null>;
	intro(title?: string): void;
	outro(message?: string): void;
}

/**
 * The colored `SelectListTheme` for the wizard pickers — {@link style} (the raw-SGR
 * color layer, no `chalk` dep). The selected row renders accent+bold; descriptions
 * are muted; scroll info is dim. Identity fns when color is disabled (`NO_COLOR` /
 * non-TTY), so the prompts render plain in CI/logs. (Was an identity theme before
 * the spec-19 color polish landed; the prompt *logic* is unchanged — only the
 * theme fns colorize.)
 */

/**
 * A masked `Input` — spec 21b's "Input (masked for secret)". pi-tui's `Input`
 * has no built-in masking, so this subclass overrides `render` to show one dot
 * per glyph while the real value stays intact (read via the inherited `getValue`,
 * edited via the inherited `handleInput`: typing, backspace, submit, escape all
 * work unchanged). The caret renders at the end — a masked field's cursor
 * position is visually ambiguous among identical dots anyway, so mid-string
 * cursor positioning (which `Input`'s scroll math exists for) adds nothing here.
 *
 * Masking is enforced at the render boundary: the only NEW rendering logic in
 * the consolidation, and the one thing the 21a loop tests (which exercise plain
 * `Input`) don't cover.
 */
export class MaskedInput extends Input {
	render(width: number): string[] {
		const prompt = "> ";
		const availableWidth = width - prompt.length;
		if (availableWidth <= 0) {
			return [prompt];
		}
		// One dot per glyph of the real value, capped to leave a column for the
		// end caret (so the line never overflows `width`).
		const shown = Math.min(visibleWidth(this.getValue()), Math.max(0, availableWidth - 1));
		const mask = "•".repeat(shown);
		const marker = this.focused ? CURSOR_MARKER : "";
		const caret = "\x1b[7m \x1b[27m"; // inverse-video space — the caret, like `Input`'s at-end case
		return [`${prompt}${mask}${marker}${caret}`];
	}
}

/** Injection seam for {@link createDefaultIo} (the `11a`/`13`/`17b`–`19d` precedent). */
export interface DefaultIoDeps {
	/**
	 * The pi-tui terminal `runPrompt` drives. Defaults to a real `ProcessTerminal`
	 * (`process.stdin`/`stdout`); tests inject a fake so the hermetic trio never
	 * touches a real TTY while still exercising the real component wiring.
	 */
	terminal?: Terminal;
	/**
	 * Where the prompt label/intro header lines are written. Defaults to
	 * `process.stdout`; tests inject a sink so the hermetic trio stays quiet.
	 */
	stdout?: BannerStream;
}

/**
 * Build the production `PromptIo` over pi-tui. Each primitive mounts a component
 * via {@link runPrompt} and resolves its callback: `onSelect`/`onSubmit` → the
 * value, `onCancel`/`onEscape` → `null`. {@link defaultIo} is `createDefaultIo()`
 * (real terminal); tests pass `{ terminal: fake }`.
 */
export function createDefaultIo(deps: DefaultIoDeps = {}): PromptIo {
	// `message` is rendered as a header line ON THE ALT SCREEN (inside the modal), not
	// written to stdout — so the prompt's question is visible inside the alt-screen
	// prompt (writing it to stdout before `runPrompt` would hide it on the underlying
	// screen, which is why a bare `Input` previously looked blank).
	const run = <T>(mount: (resolve: (value: T | null) => void) => Component, message?: string): Promise<T | null> =>
		runPrompt(mount, { header: message, ...(deps.terminal !== undefined ? { terminal: deps.terminal } : {}) });
	const out: BannerStream = deps.stdout ?? process.stdout;

	return {
		async select(o) {
			const items: SelectItem[] = o.options.map((x) => ({
				value: x.value,
				label: x.label ?? x.value,
				description: x.hint,
			}));
			const initialIndex = o.initialValue !== undefined ? items.findIndex((x) => x.value === o.initialValue) : -1;
			return run<string>((resolve) => {
				const list = new SelectList(items, 10, style.selectListTheme);
				if (initialIndex > 0) {
					list.setSelectedIndex(initialIndex);
				}
				list.onSelect = (item) => resolve(item.value);
				list.onCancel = () => resolve(null);
				return list;
			}, o.message);
		},
		async text(o) {
			return run<string>((resolve) => {
				const input = new Input();
				const seed = o.initialValue ?? o.defaultValue;
				if (seed !== undefined) {
					input.setValue(seed);
				}
				input.onSubmit = (value) => resolve(value);
				input.onEscape = () => resolve(null);
				return input;
			}, o.message);
		},
		async password(o) {
			return run<string>((resolve) => {
				const input = new MaskedInput();
				input.onSubmit = (value) => resolve(value);
				input.onEscape = () => resolve(null);
				return input;
			}, o.message);
		},
		async confirm(o) {
			const items: SelectItem[] = [
				{ value: "yes", label: "Yes" },
				{ value: "no", label: "No" },
			];
			const choice = await run<string>((resolve) => {
				const list = new SelectList(items, items.length, style.selectListTheme);
				if (o.initialValue === false) {
					list.setSelectedIndex(1); // default cursor to "No"
				}
				list.onSelect = (item) => resolve(item.value);
				list.onCancel = () => resolve(null);
				return list;
			}, o.message);
			return choice === null ? null : choice === "yes";
		},
		intro(title) {
			// The banner is the session header; `intro` writes the title as a plain line
			// above the prompts (used by the standalone CLI wizards; the dashboard passes
			// a silent stream so it stays quiet).
			if (title) {
				out.write(`\n${title}\n`);
			}
		},
		outro() {
			// No-op — each pi-tui prompt renders and tears itself down via `runPrompt`.
		},
	};
}

/**
 * The production `io` — real pi-tui (a real `ProcessTerminal`). Tests use
 * {@link createDefaultIo} with an injected terminal; everything above this object
 * sees a clean `T | null` (cancel is `null`, never a symbol).
 */
export const defaultIo: PromptIo = createDefaultIo();

/**
 * A flag-derived {@link PromptIo} — the non-interactive seam (spec 20g). `answers`
 * is keyed by the prompt **message** (the picker select's fixed message + each
 * field's `label`, both of which the wizard passes verbatim as `message`). A prompt
 * whose message is present resolves to the flag value; one that is absent falls back
 * so the wizard keeps driving instead of cancelling:
 * - `select` — the provider/section picker. Absent → `null` (cancel); the flag
 *   handler always supplies the picker, so this is defensive.
 * - `text` — a field. Absent → the seeded `defaultValue` (the current value, via
 *   `seedDefaults`) or `""`, so an unspecified field is **left unchanged** rather
 *   than aborting the wizard (a required field is pre-checked by the handler).
 * - `password` — a secret field. Absent → `null` (cancel); a required secret
 *   without its flag is caught by the handler's required-field check first.
 * - `confirm` — absent → the seeded `initialValue`; present → `"true"`/`"false"`.
 *
 * The picker-message keys come from the wizards' exported
 * `CHANNEL_SELECT_PROMPT` / `SECTION_SELECT_PROMPT` (single source — no drift), and
 * the field-label keys are read from the same provider/section `fields` the wizard
 * renders, so message and key agree by construction.
 *
 * Unchanged by the 21b consolidation — it never touches a TTY.
 */
export function flagIo(answers: Record<string, string>): PromptIo {
	const lookup = (message: string): string | undefined =>
		Object.hasOwn(answers, message) ? answers[message] : undefined;
	return {
		async select(o) {
			return lookup(o.message) ?? null;
		},
		async text(o) {
			const v = lookup(o.message);
			if (v !== undefined) return v;
			return o.defaultValue ?? "";
		},
		async password(o) {
			return lookup(o.message) ?? null;
		},
		async confirm(o) {
			const v = lookup(o.message);
			if (v === undefined) return o.initialValue ?? null;
			return v === "true";
		},
		intro() {},
		outro() {},
	};
}

/**
 * Pick one of `options`. Resolves to the chosen `value`, or `null` on cancel.
 */
export async function askSelect(options: AskSelectOptions, io: PromptIo = defaultIo): Promise<string | null> {
	return io.select(options);
}

/**
 * Read a line of text. `label` becomes the prompt message.
 * Resolves to the trimmed input, or `null` on cancel.
 */
export async function askText(label: string, io: PromptIo = defaultIo): Promise<string | null> {
	return io.text({ message: label });
}

/**
 * Read a masked secret. Resolves to the input, or `null` on cancel.
 */
export async function askSecret(label: string, io: PromptIo = defaultIo): Promise<string | null> {
	return io.password({ message: label });
}

/**
 * Ask a yes/no question. Resolves to a boolean, or `null` on cancel.
 */
export async function askConfirm(label: string, io: PromptIo = defaultIo): Promise<boolean | null> {
	return io.confirm({ message: label });
}

/** Optional injection seam for {@link withSession}. */
export interface SessionDeps {
	/** Defaults to the production {@link defaultIo}. */
	io?: PromptIo;
	/** Banner destination; defaults to `process.stdout`. */
	stream?: BannerStream;
}

/**
 * Frame a prompt sequence: print the OpenHammer banner, `io.intro(title)`, run
 * `fn`, then `io.outro()` (always — even on a thrown error, which rethrows after
 * cleanup). Resolves to whatever `fn` resolves to.
 */
export async function withSession<T>(title: string, fn: () => Promise<T>, deps: SessionDeps = {}): Promise<T> {
	const io = deps.io ?? defaultIo;
	const stream = deps.stream ?? process.stdout;
	printBanner(stream);
	io.intro(title);
	try {
		return await fn();
	} finally {
		io.outro();
	}
}
