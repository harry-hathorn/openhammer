/**
 * The generic, schema-driven wizard.
 *
 * {@link runWizard} renders the OpenHammer banner, walks each {@link ConfigField},
 * dispatches its `kind` to a prompt primitive, and reduces the collected answers
 * to a `Record<string, string>`. It resolves to `null` on cancel or a required
 * field left empty.
 *
 * **Logic split from rendering:** {@link reduceFields} is the pure state machine
 * (default application + confirm coercion + required-empty check) and is unit-
 * tested without a terminal; {@link runWizard} is the rendering layer (banner +
 * prompts) and is exercised with an injected fake `io` (clack's TTY never
 * touches the hermetic trio). A new config domain — channels, settings sections,
 * anything declared as `ConfigField[]` — reuses both unchanged.
 */
import type { BannerStream } from "./banner.ts";
import { defaultIo, type PromptIo, withSession } from "./prompts.ts";
import type { ConfigField } from "./schema.ts";

/**
 * The io a wizard drives. An alias for {@link PromptIo} — the 17b adapters take
 * local option-object types so the wizard reuses {@link defaultIo} directly
 * (threading field defaults through) without a parallel interface.
 */
export type WizardIo = PromptIo;

/** Collected answers keyed by `ConfigField.key`; booleans come from `confirm`. */
export type RawAnswers = Record<string, string | boolean>;

/** Optional injection seams for {@link runWizard} (mirrors 17b's `SessionDeps`). */
export interface WizardDeps {
	/** Banner destination; defaults to `process.stdout` via {@link withSession}. */
	stream?: BannerStream;
}

/**
 * Reduce collected raw answers to the final `key → string` map. Applies
 * `default`s, coerces confirm booleans to `"true"`/`"false"`, and returns `null`
 * the moment a required field is left empty (a field with a `default` is never
 * required-empty — the default fills it). runWizard collects the answers; this
 * is their meaning — pure, terminal-free, the part worth unit-testing directly.
 *
 * A missing key reads as empty at runtime (graceful: optional stays `""`/default,
 * required-no-default aborts), so the function never indexes past an absent value.
 */
export function reduceFields(fields: ConfigField[], rawAnswers: RawAnswers): Record<string, string> | null {
	const out: Record<string, string> = {};
	for (const field of fields) {
		const raw = rawAnswers[field.key];
		if (field.kind === "confirm") {
			const b = typeof raw === "boolean" ? raw : (field.default ?? false);
			out[field.key] = b ? "true" : "false";
			continue;
		}
		// text | secret | select
		const s = typeof raw === "string" ? raw.trim() : "";
		if (s !== "") {
			out[field.key] = s;
			continue;
		}
		if (field.default !== undefined) {
			out[field.key] = field.default;
			continue;
		}
		if (field.required) return null;
		out[field.key] = "";
	}
	return out;
}

/**
 * Dispatch one field to its prompt primitive via `io`. The default is threaded
 * through (clack `text` returns it on empty submit; `select`/`confirm` pre-
 * select it) — {@link reduceFields} remains the authoritative fallback. Resolves
 * to `null` on cancel (propagated by the caller). The `default` for `secret` is
 * not shown (clack's masked `password` has none) but is still honored by
 * `reduceFields` on an empty answer.
 */
async function promptField(field: ConfigField, io: WizardIo): Promise<string | boolean | null> {
	switch (field.kind) {
		case "text":
			return io.text({ message: field.label, defaultValue: field.default });
		case "secret":
			return io.password({ message: field.label });
		case "select":
			return io.select({ message: field.label, options: field.options, initialValue: field.default });
		case "confirm":
			return io.confirm({ message: field.label, initialValue: field.default });
		default: {
			// Exhaustiveness guard: adding a `kind` forces a branch here.
			const _exhaustive: never = field;
			return _exhaustive;
		}
	}
}

/**
 * Render the banner, then walk `fields`, dispatching each to its primitive via
 * `io` (injectable — defaults to the production {@link defaultIo}). Resolves to
 * the reduced `key → string` answers, or `null` on cancel / required-empty.
 * The banner + `intro`/`outro` framing reuses {@link withSession} (single
 * source); the banner stream is injectable via `deps.stream` so tests stay
 * hermetic (no stdout pollution).
 */
export async function runWizard(
	title: string,
	fields: ConfigField[],
	io: WizardIo = defaultIo,
	deps: WizardDeps = {},
): Promise<Record<string, string> | null> {
	return withSession(
		title,
		async () => {
			const raw: RawAnswers = {};
			for (const field of fields) {
				const answer = await promptField(field, io);
				if (answer === null) return null; // cancel propagation — stop on the first cancel
				raw[field.key] = answer;
			}
			return reduceFields(fields, raw);
		},
		{ io, stream: deps.stream },
	);
}
