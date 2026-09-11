/**
 * The settings-section registry (spec 17l).
 *
 * A {@link ConfigSection} is "`ConfigField[]` the wizard renders + a place to
 * persist the answers" — the same engine channels use, applied to non-ingress
 * config. The sections are `mcp` (editing `allowedClients`) and `vm` (spec 27,
 * the sandbox's operator-set knobs). Adding a section later is one entry here, no
 * wizard change — the scalability seam the channel registry (17g) already proved,
 * re-proven by the section wizard (17l) reusing the generic {@link runWizard}
 * unchanged.
 *
 * **No secrets here.** A section's fields are non-secret config (an allowlist), so
 * unlike channels there is no credentials-store split — `write` just returns the
 * updated {@link Settings} for the CLI to `saveSettings`.
 *
 * **The vm mode-select guards (spec 28, matrix rows 1–2) live in the write path**
 * — `vmSection.write` — because EVERY mode write funnels through it: the CLI's
 * interactive `openhammer config set vm` wizard, the non-interactive
 * `config set vm.mode vm` flag path, and the dashboard's Configure/Edit-settings
 * flows all call `section.write` via `setSection`, so one guard covers them all.
 * Row 2 (no-golden block) is implementable here in full: the write THROWS the
 * actionable message before any doc is produced. Row 1 (the vm/agent → `off`
 * public-channel warning) is a CONFIRM, not a block — a sync, io-less `write`
 * cannot ask — so the confirm lives in the dashboard's settings-actions wiring
 * (src/tui/dashboard.ts, `createSettingsActions`), which covers both dashboard
 * mode-select surfaces; the bare CLI path's row-1 confirm is a documented v1 gap
 * (the CLI boundary has no post-wizard confirm seam; the dashboard is spec 28's
 * operator control center).
 */

import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseClientList, VM_MODE_VALUES, VM_PERSIST_VALUES } from "../config.ts";
import type { ConfigField, SelectFieldOption } from "../tui/schema.ts";
import { readManifest } from "../vm/provision/snapshot.ts";
import { resolveVmDirs } from "../vm/session.ts";
import type { Settings, VmSettings } from "./settings.ts";

/**
 * Optional write-side injections (the repo's deps-object contract: defaults are
 * the real implementations). Only the sections whose `write` consults the
 * outside world take them; `setSection` passes none, so the production defaults
 * apply on every wizard path.
 */
export interface SectionWriteDeps {
	/**
	 * Override the golden-manifest probe behind the vm no-golden guard (default:
	 * {@link goldenManifestExists}). Tests inject a constant so the guard is
	 * hermetic; the dashboard/store's Install-item visibility reuses the same
	 * default probe, so the guard and the affordance can never disagree.
	 */
	readonly goldenExists?: () => boolean;
	/** The HOME the golden tree roots at (default `os.homedir()`; tests: temp dir). */
	readonly homeDir?: string;
}

/**
 * One settings section. `read` extracts the current values as the string map the
 * wizard seeds from (field key → current string value); `write` applies the
 * wizard's string answers as an immutable {@link Settings} update. `fields` is what
 * the generic `runWizard` renders — declaring a section never touches the wizard.
 * The optional third `deps` parameter carries the write's injection seams (the vm
 * section's no-golden probe); implementations that need none simply ignore it.
 */
export interface ConfigSection {
	/** The section id — also the `config set [section]` argument (e.g. `"mcp"`). */
	id: string;
	/** The human label shown in the section-select prompt + the wizard title. */
	label: string;
	/** The field schema the wizard renders. */
	fields: ConfigField[];
	/** Read the current section values as a `key → string` map (wizard seed). */
	read(s: Settings): Record<string, string>;
	/** Apply the wizard's answers as an immutable {@link Settings} update. */
	write(s: Settings, vals: Record<string, string>, deps?: SectionWriteDeps): Settings;
}

/**
 * The `mcp` settings section — edits `mcp.allowedClients`.
 *
 * The list is a single free-form text field (comma- or newline-separated).
 * `read` joins the current `string[]` (comma + space) for display; `write` parses
 * it back with {@link parseClientList} — the same comma/newline/trim/drop-empty
 * parser {@link resolveConfig} uses for `MCP_ALLOWED_CLIENTS` (single source of the
 * format, so the two paths can never disagree). `[]`/`["*"]` = any client
 * (enforced in the auth middleware, 17r); a non-wildcard list is the User-Agent
 * allowlist.
 */
export const mcpSection: ConfigSection = {
	id: "mcp",
	label: "MCP allowed clients",
	fields: [
		{
			key: "allowedClients",
			label: "Allowed clients",
			kind: "text",
			help: "Comma- or newline-separated User-Agent allowlist. Empty or * = any client.",
		},
	],
	read: (s) => ({ allowedClients: s.mcp.allowedClients.join(", ") }),
	write: (s, vals) => ({ ...s, mcp: { allowedClients: parseClientList(vals.allowedClients ?? "") } }),
};

// ---- the `vm` section's write-side helpers ------------------------------------

/**
 * The no-golden mode guard's actionable message (spec 28, matrix row 2) — the
 * CLI remedy AND the TUI jump affordance in one line. The jump target is real:
 * the dashboard's Sandbox screen shows *Install sandbox* exactly when this guard
 * can fire ({@link goldenManifestExists} is false — one probe, two surfaces).
 */
export const NO_GOLDEN_GUARD_MESSAGE = "no golden image — run: openhammer vm install (or Sandbox → Install sandbox)";

const GOLDEN_PREFIX = "golden-";
const MANIFEST_FILE = "manifest.json";

// preflight.ts's orderKeyOf, verbatim in shape: the manifest's builtAt (digits
// only, so ISO stamps compare), falling back to the id's trailing
// `-YYYYMMDD-HHMMSS` stamp (a corrupt manifest still sorts by when it was
// minted), "" last. Restated here (the readProcDefault precedent) so the guard
// orders goldens exactly the way the boot's preflight does — consolidate with
// preflight/manage when a shared golden-scan module is extracted.
function goldenOrderKey(id: string, builtAt: string | undefined): string {
	if (builtAt !== undefined) {
		return builtAt.replace(/\D/g, "");
	}
	const stamp = /(\d{8}-\d{6})$/.exec(id);
	return stamp === null ? "" : (stamp[1] ?? "").replaceAll("-", "");
}

/**
 * Does a BOOTABLE golden exist — the NEWEST `images/golden-<id>` dir carrying a
 * valid `manifest.json`? This is the no-golden guard's probe (spec 28, matrix
 * row 2) and the dashboard Install-item's visibility probe, and it mirrors
 * preflight's check 5 exactly (preflight.ts's newestGolden posture, restated):
 * newest-first by manifest `builtAt`, falling back to the id's trailing stamp;
 * strays (non-dirs, non-`golden-` names) are not goldens; a corrupt newest is
 * NOT skipped past for an older valid one (the no-degrade rule — the boot would
 * fail, so no bootable golden exists). Synchronous local probes only; an absent
 * images root is simply `false`.
 */
export function goldenManifestExists(homeDir?: string): boolean {
	const imagesDir = resolveVmDirs({ homeDir }).images;
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(imagesDir, { withFileTypes: true });
	} catch {
		return false; // no images root — no goldens
	}
	const goldens: { readonly id: string; readonly key: string; readonly manifestOk: boolean }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(GOLDEN_PREFIX)) {
			continue;
		}
		const manifest = readManifest(join(imagesDir, entry.name, MANIFEST_FILE));
		goldens.push({
			id: entry.name,
			key: goldenOrderKey(entry.name, manifest?.builtAt),
			manifestOk: manifest !== null,
		});
	}
	goldens.sort((a, b) => {
		if (a.key !== b.key) {
			return a.key < b.key ? 1 : -1;
		}
		return a.id < b.id ? 1 : -1;
	});
	return (goldens[0]?.manifestOk ?? false) === true;
}

/**
 * A wizard answer, trimmed: absent or blank reads as `undefined` (an unspecified
 * field is LEFT UNCHANGED — the seed already offered the current value as the
 * prompt default, so an empty submit means "keep it").
 */
function vmAnswer(raw: string | undefined): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse one of the section's number-bearing text fields. The wizard schema
 * (src/tui/schema.ts) has NO number kind — spec 28 keeps the engine at
 * `text|secret|select|confirm`, and the `mcp` section sets no numeric precedent —
 * so the numbers ride `text` fields whose validation lives HERE, in `write`:
 *
 * - a well-formed integer of the right shape is parsed (`Number` +
 *   `Number.isInteger`, the repo's canonized parse — never unary `+`);
 * - a blank answer keeps the current value (the seed's default);
 * - anything else THROWS the actionable error naming the field — surfaced by the
 *   CLI boundary (exit 1 + one-line message), and load-bearing for the doc:
 *   `write` must never persist a shape `isVmSettings` would reject, or the next
 *   `loadSettings` would silently default-fill the whole vm section away.
 *
 * Shape only (integer, at `min`); range policy is preflight's (27c).
 */
function vmIntField(key: string, raw: string | undefined, fallback: number, min: number): number {
	const answer = vmAnswer(raw);
	if (answer === undefined) {
		return fallback;
	}
	const n = Number(answer);
	if (!Number.isInteger(n) || n < min) {
		throw new Error(`${key} must be an integer >= ${min} (got "${answer}")`);
	}
	return n;
}

/**
 * Resolve one of the section's select answers. The wizard only offers the
 * options, so an out-of-set answer can only arrive via the non-interactive
 * `config set vm.<key> <value>` path — and it THROWS rather than persisting a
 * value `isVmSettings` would reject (same load-bearing guard as
 * {@link vmIntField}); blank keeps the current value.
 */
function vmSelectValue<T extends string>(key: string, raw: string | undefined, allowed: readonly T[], fallback: T): T {
	const answer = vmAnswer(raw);
	if (answer === undefined) {
		return fallback;
	}
	for (const candidate of allowed) {
		if (candidate === answer) {
			return candidate;
		}
	}
	throw new Error(`${key} must be one of ${allowed.join(", ")} (got "${answer}")`);
}

/** Select options from a value list + an exhaustive label map (single source per section). */
function vmSelectOptions<T extends string>(values: readonly T[], labels: Record<T, string>): SelectFieldOption[] {
	return values.map((value) => ({ value, label: labels[value] }));
}

const VM_MODE_LABELS: Record<VmSettings["mode"], string> = {
	off: "off — local tools, no VM (default)",
	vm: "vm — tools execute in the guest",
	agent: "agent — guest + in-guest agent (spec 29)",
};

const VM_PERSIST_LABELS: Record<VmSettings["persist"], string> = {
	auto: "auto — vm retains the overlay, agent discards it",
	retain: "retain — keep the overlay across boots",
	discard: "discard — delete the overlay at teardown",
};

/**
 * The `vm` settings section (spec 27) — edits `settings.vm`, the VM sandbox's
 * operator-set knobs. `mode`/`persist` are `select` fields (the wizard engine is
 * untouched, the `mcp` section is the pattern); their options derive from the
 * same value arrays the env parser validates against (`VM_MODE_VALUES`/
 * `VM_PERSIST_VALUES` from config.ts — the `parseClientList` single-source
 * precedent, so the section and `MCP_VM_*` can never disagree).
 *
 * **Numbers ride text fields** — the schema has no number kind (see
 * {@link vmIntField}); each field's `help` states the expected shape, and
 * `write` enforces it. `agentCmd` cannot be emptied (`isVmSettings` requires a
 * non-empty command — blank keeps the current value); an empty `secretsDir`
 * means the default (`null`). The fields are options, never secrets: secrets
 * live in the provisioned-secrets store, not the settings doc.
 *
 * **The no-golden mode guard (spec 28, matrix row 2).** Every write whose
 * RESOLVED mode is `vm`/`agent` (the answer, else the seeded current value) is
 * blocked with {@link NO_GOLDEN_GUARD_MESSAGE} unless a bootable golden exists
 * ({@link goldenManifestExists} — preflight's exact probe). Blocking here covers
 * every write path at once (the CLI wizard, the non-interactive
 * `config set vm.mode vm` flag path, and both dashboard flows), and onboarding
 * order becomes Install → set mode → restart. Firing on the resolved mode (not
 * just a changed one) is deliberate: a doc that says `vm` with no golden is
 * exactly the cannot-boot state the guard exists to catch — editing any other
 * vm field then first demands the install the message names. Boot preflight
 * stays fail-fatal behind this (defense in depth).
 */
export const vmSection: ConfigSection = {
	id: "vm",
	label: "VM sandbox",
	fields: [
		{
			key: "mode",
			label: "Boot mode",
			kind: "select",
			options: vmSelectOptions(VM_MODE_VALUES, VM_MODE_LABELS),
			help: "The operator-imposed sandbox posture: off runs tools locally, vm inside the guest, agent adds the in-guest agent (spec 29).",
		},
		{
			key: "memoryMb",
			label: "Guest memory (MiB)",
			kind: "text",
			help: "Positive integer MiB. Default 4096 (the spec-22 measured default).",
		},
		{
			key: "cpus",
			label: "Guest vCPUs",
			kind: "text",
			help: "Positive integer. Default 4.",
		},
		{
			key: "persist",
			label: "Overlay persist",
			kind: "select",
			options: vmSelectOptions(VM_PERSIST_VALUES, VM_PERSIST_LABELS),
			help: "The session overlay's teardown policy. Default auto.",
		},
		{
			key: "idleTimeoutMs",
			label: "Idle timeout (ms)",
			kind: "text",
			help: "Non-negative integer ms; 0 (the default) never reaps an idle session.",
		},
		{
			key: "agentCmd",
			label: "Agent command",
			kind: "text",
			help: "The in-guest agent command. Default claude.",
		},
		{
			key: "secretsDir",
			label: "Secrets dir",
			kind: "text",
			help: "Where provisioned secrets land; empty (the default) = ~/.openhammer/vm/secrets.",
		},
	],
	read: (s) => ({
		mode: s.vm.mode,
		memoryMb: String(s.vm.memoryMb),
		cpus: String(s.vm.cpus),
		persist: s.vm.persist,
		idleTimeoutMs: String(s.vm.idleTimeoutMs),
		agentCmd: s.vm.agentCmd,
		secretsDir: s.vm.secretsDir ?? "",
	}),
	write: (s, vals, deps) => {
		// The mode is resolved first so an invalid answer throws before the probe runs.
		const mode = vmSelectValue("vm.mode", vals.mode, VM_MODE_VALUES, s.vm.mode);
		// The no-golden guard (spec 28, matrix row 2): vm/agent require a bootable
		// golden — the exact probe a boot's preflight runs (see the doc comment above).
		const goldenReady = deps?.goldenExists ?? ((home?: string) => goldenManifestExists(home));
		if (mode !== "off" && !goldenReady(deps?.homeDir)) {
			throw new Error(NO_GOLDEN_GUARD_MESSAGE);
		}
		return {
			...s,
			vm: {
				mode,
				memoryMb: vmIntField("vm.memoryMb", vals.memoryMb, s.vm.memoryMb, 1),
				cpus: vmIntField("vm.cpus", vals.cpus, s.vm.cpus, 1),
				persist: vmSelectValue("vm.persist", vals.persist, VM_PERSIST_VALUES, s.vm.persist),
				idleTimeoutMs: vmIntField("vm.idleTimeoutMs", vals.idleTimeoutMs, s.vm.idleTimeoutMs, 0),
				agentCmd: vmAnswer(vals.agentCmd) ?? s.vm.agentCmd,
				secretsDir: vmAnswer(vals.secretsDir) ?? null,
			},
		};
	},
};

/**
 * Every registered settings section, keyed by section id. The `config set` flow
 * picks from here; the `config set <id>` form looks up `<id>` directly.
 */
export const CONFIG_SECTIONS: Record<string, ConfigSection> = { mcp: mcpSection, vm: vmSection };
