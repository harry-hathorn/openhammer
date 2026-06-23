/**
 * The settings-section wizard (spec 17l) — the `openhammer config set` flow.
 *
 * Mirrors the channel-add wizard (17k) over the section registry: pick a
 * {@link ConfigSection} → seed {@link runWizard} from `section.read(settings)` →
 * `section.write(settings, answers)` → return the updated {@link Settings} for the
 * CLI to `saveSettings`. The same `runWizard` engine as channels — proving the
 * scalability seam (a new section needs zero wizard edits, only a registry entry).
 *
 * **Composition — one banner, from {@link runWizard}.** The section `io.select`
 * leads (a bare `io.select`), then `runWizard` frames the field-editing phase with
 * the banner + `intro`/`outro` (its single source is `withSession`). The section
 * wizard prints no banner of its own — that would double it — exactly the pattern
 * the channel wizard (17k) established.
 *
 * **Boundary posture — doc via the caller.** The wizard returns the updated
 * {@link Settings}; the CLI owns `saveSettings` (matching 17k's secret-here /
 * doc-via-caller split, minus the secret half — a section holds no secrets). A
 * cancelled run writes nothing.
 *
 * **Result spine:** `ok(Settings)` (section applied — the caller saves the doc),
 * `err(Error)` (the registry has no sections — defensive; `mcp` always ships), or
 * `null` (cancel / a required field left empty — no write, silent).
 *
 * **Hermetic by injection:** `io` + the registry default to production but are
 * passed by the unit tests, so clack's TTY never touches the hermetic trio — the
 * `11a`/`13`/`17b`–`17k` injection-arg precedent.
 */
import { CONFIG_SECTIONS, type ConfigSection } from "../../config/sections.ts";
import type { Settings } from "../../config/settings.ts";
import { err, ok, type Result } from "../../tools/result.ts";
import type { BannerStream } from "../banner.ts";
import { defaultIo } from "../prompts.ts";
import type { ConfigField } from "../schema.ts";
import { runWizard, type WizardIo } from "../wizard.ts";

/** Read the global registry's sections at call time (tests mutate CONFIG_SECTIONS — never snapshot at load). */
function registrySections(): ConfigSection[] {
	return Object.values(CONFIG_SECTIONS).filter((s): s is ConfigSection => s !== undefined);
}

/** Injectable seams so {@link setSection} is hermetic (the `11a`/`13`/`17b`–`17k` injection-arg precedent). */
export interface SetSectionDeps {
	/** The io driving the section select + field prompts (defaults to {@link defaultIo}). */
	io?: WizardIo;
	/** Banner destination for {@link runWizard} (defaults to `process.stdout`). */
	stream?: BannerStream;
	/** Sections to pick from (defaults to the global {@link CONFIG_SECTIONS} registry, read at call time). */
	sections?: ConfigSection[];
}

/**
 * The {@link setSection} outcome: `ok(Settings)` (section applied — the CLI saves
 * the returned doc), `err(Error)` (no sections registered), or `null` (cancelled /
 * incomplete — no write).
 */
export type SetSectionResult = Result<Settings, Error> | null;

/**
 * Seed a section's fields with its current values (the `section.read(settings)`
 * map) so the operator sees and edits what's already set. Each field's `default` is
 * overridden from the seed — a `text`/`secret`/`select` field takes the string
 * verbatim; a `confirm` field's `"true"`/`"false"` seed is coerced back to a
 * boolean (mirroring how `reduceFields` coerces confirms to those strings). A field
 * the seed omits is left unchanged. Pure — unit-tested directly, the part worth
 * testing without a terminal.
 */
export function seedDefaults(fields: ConfigField[], seed: Record<string, string>): ConfigField[] {
	return fields.map((field) => {
		const v = seed[field.key];
		if (v === undefined) return field;
		if (field.kind === "confirm") return { ...field, default: v === "true" };
		// text | secret | select — `default` is a string.
		return { ...field, default: v };
	});
}

/**
 * Run the `openhammer config set` flow and return the updated {@link Settings} (the
 * caller `saveSettings`s the doc). Returns:
 * - `ok(Settings)` — the section was applied (`section.write` over the answers).
 * - `err(Error)` — the registry has no sections (defensive; `mcp` always ships).
 * - `null` — the operator cancelled the select or a field, or left a required field
 *   empty (nothing written; silent).
 *
 * With the production defaults this is the CLI call; tests inject a fake `io` +
 * `sections` (a fake section drives the wizard unchanged — the scalability seam).
 */
export async function setSection(settings: Settings, deps: SetSectionDeps = {}): Promise<SetSectionResult> {
	const io = deps.io ?? defaultIo;
	const sections = deps.sections ?? registrySections();

	if (sections.length === 0) {
		return err(new Error("No settings sections are registered"));
	}

	// 1. Pick a section to edit.
	const chosen = await io.select({
		message: "Settings section",
		options: sections.map((s) => ({ value: s.id, label: s.label })),
	});
	if (chosen === null) return null; // cancel
	const section = sections.find((s) => s.id === chosen);
	if (!section) return null; // defensive: `chosen` came from `sections`' options

	// 2. Seed the fields from the current settings, then run the wizard (it prints
	//    the banner + intro/outro).
	const seeded = seedDefaults(section.fields, section.read(settings));
	const answers = await runWizard(section.label, seeded, io, { stream: deps.stream });
	if (answers === null) return null; // cancel / required-empty

	// 3. Apply the answers and return the updated Settings (the caller saves).
	return ok(section.write(settings, answers));
}
