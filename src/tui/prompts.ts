/**
 * Thin adapters over `@clack/prompts`.
 *
 * clack owns all TTY/raw-mode rendering — there is no custom render loop here.
 * Every prompt is wrapped so a cancel resolves to `null` (clack's private
 * cancel symbol never escapes this module). `withSession` frames a sequence of
 * prompts with the OpenHammer banner + clack `intro`/`outro`.
 *
 * **Logic split from rendering:** all clack interaction lives behind the
 * {@link PromptIo} seam. The production {@link defaultIo} wraps real clack
 * (and does the `isCancel → null` translation); unit tests inject a fake `io`
 * returning clean `T | null` values, so clack's TTY requirement never touches
 * the hermetic trio. The adapters + `withSession` are pure orchestration over
 * that contract.
 */
import { confirm, intro, isCancel, outro, password, select, text } from "@clack/prompts";
import { type BannerStream, printBanner } from "./banner.ts";

/** A selectable choice; clack renders `label` (or `value`) and returns `value`. */
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
 * The injectable clack-primitive bundle. Each method resolves to the chosen
 * value or `null` on cancel — never clack's cancel symbol. `intro`/`outro`
 * frame a session. The production impl is {@link defaultIo}; tests pass a fake.
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
 * The production `io` — real clack. The `isCancel → null` translation is the
 * single clack boundary; everything above this object sees a clean `T | null`.
 */
export const defaultIo: PromptIo = {
	async select(o) {
		const r = await select({
			message: o.message,
			options: o.options.map((x) => ({ value: x.value, label: x.label, hint: x.hint })),
			initialValue: o.initialValue,
		});
		return isCancel(r) ? null : r;
	},
	async text(o) {
		const r = await text({
			message: o.message,
			placeholder: o.placeholder,
			defaultValue: o.defaultValue,
			initialValue: o.initialValue,
		});
		return isCancel(r) ? null : r;
	},
	async password(o) {
		const r = await password({ message: o.message });
		return isCancel(r) ? null : r;
	},
	async confirm(o) {
		const r = await confirm({ message: o.message, initialValue: o.initialValue });
		return isCancel(r) ? null : r;
	},
	intro: (t) => intro(t),
	outro: (m) => outro(m),
};

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
 * Read a masked secret (clack `password`). Resolves to the input, or `null` on cancel.
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
 * Frame a prompt sequence: print the OpenHammer banner, clack `intro(title)`,
 * run `fn`, then clack `outro()` (always — even on a thrown error, which
 * rethrows after cleanup). Resolves to whatever `fn` resolves to.
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
