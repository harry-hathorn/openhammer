/**
 * The Guest setup wizard (spec 28, tier (a)) — the `guest.json` build-config flow.
 *
 * **Composition — not a `ConfigSection`.** The guest doc is a DIFFERENT STORE with a
 * different posture than the settings doc (26a: whole-doc granularity, an atomic 0600
 * file, secrets never here), so this is a standalone wizard beside `section.ts` rather
 * than a registry entry — but the `runWizard` ENGINE still renders the fields (the
 * schema stays `text|secret|select|confirm`; no new kind, per spec 28's requirement).
 * The section-wizard shape — seed from the store → run → write through the store's
 * normalizer — is mirrored exactly, with `loadGuestConfig`/`saveGuestConfig` in the
 * places `section.read`/`section.write` + the CLI's `saveSettings` occupy there.
 *
 * **The save path funnels through the REAL normalize (the 27b vm-section precedent).**
 * Answers are first LOCALIZED against `normalizeGuestConfig` — each edited field is
 * probed one-at-a-time over the valid seed, so `null` means exactly "this answer broke
 * the doc" and the error names the field (27b's `vmIntField` actionable-error posture,
 * without restating 26a's module-private patterns: the single validity source can never
 * drift) — then the whole candidate is normalize-gated before `saveGuestConfig` ever
 * runs. The wizard never persists a doc `loadGuestConfig` would silently default away.
 *
 * **The post-golden warning (spec 28 tier (a) edge case).** When a golden already
 * exists, the wizard PRECEDES the fields with a warning — these edits apply to the
 * NEXT `vm install` (the manifest is the record of what was baked); edits are allowed,
 * declining writes nothing. The probe is {@link newestGoldenId} (vm/provision/install.ts)
 * — 28d's deliberate divergence: golden EXISTENCE (the doctor's dir-level notion),
 * deliberately NOT `goldenManifestExists` bootability — a corrupt-manifest golden is
 * exactly the tree the next install rebuilds, and the warning's `<id>` needs the id a
 * boolean probe cannot give. The import direction is safe (vm/provision never imports
 * tui; `src/tui/dashboard.ts` already imports `runInstall` from the same module).
 *
 * **Owned-agnostic by nature.** `guest.json` is a LOCAL build input — this configures
 * what the next `vm install` bakes, never a (possibly remote) running server — so the
 * flow takes no owned-server gate anywhere (the one Sandbox action without one).
 *
 * **Result spine:** `ok(GuestConfig)` (saved — the doc on disk IS the return),
 * `err(Error)` (an answer no valid doc can carry, or a write failure), or `null`
 * (cancelled, or the post-golden warning declined — no write, silent). Hermetic by
 * injection (the `11a`/`13`/`17b`–`17k` precedent): io/stream/dirs/probe all default
 * to production and are overridden by the tests.
 */
import { err, ok, type Result } from "../../tools/result.ts";
import {
	GUEST_AGENTS,
	type GuestAgent,
	type GuestConfig,
	loadGuestConfig,
	normalizeGuestConfig,
	saveGuestConfig,
} from "../../vm/provision/guest-config.ts";
import { newestGoldenId } from "../../vm/provision/install.ts";
import { resolveVmDirs, type VmDirs } from "../../vm/session.ts";
import type { BannerStream } from "../banner.ts";
import { defaultIo } from "../prompts.ts";
import type { ConfigField } from "../schema.ts";
import { runWizard, type WizardIo } from "../wizard.ts";

/** The wizard's title — the banner `runWizard` frames the field phase with. */
export const GUEST_SETUP_TITLE = "Guest setup";

/**
 * The post-golden warning's confirm message (spec 28 tier (a)): the warning verbatim,
 * then the ask. Exported so tests pin the exact surface.
 */
export function goldenWarningMessage(goldenId: string): string {
	return `a golden image already exists (${goldenId}) — these edits apply to the next \`vm install\`. Continue?`;
}

/**
 * Parse the extra-packages answer — comma-separated pacman tokens (spec 28 tier (a)).
 * PINNED: split on `,`; each token trimmed; empty tokens dropped; duplicates
 * deduplicated with first-occurrence order kept (a dup in a pacman argument list is at
 * best a warning). Token VALIDITY is deliberately not parsed here — the normalize probe
 * in {@link guestConfigFromAnswers} owns it, so 26a's pattern stays the single source.
 * Lossless for any valid doc: a valid token (26a's charset) holds no comma or
 * whitespace, so `join(", ")` → this parser round-trips the list exactly.
 */
export function parsePackageList(raw: string): string[] {
	const out: string[] = [];
	for (const token of raw.split(",")) {
		const t = token.trim();
		if (t !== "" && !out.includes(t)) out.push(t);
	}
	return out;
}

/**
 * Parse the boot-commands answer — newline-separated operator-authored lines, written
 * verbatim into Omarchy's post-boot hook (26a). PINNED: split on `\n`; each LINE
 * trimmed (canonicalizing — a single-line bash command's leading/trailing whitespace is
 * insignificant); blank lines dropped; duplicates NOT deduplicated — the lines run in
 * order and a repeat can be intentional (e.g. two `sleep 5`s around a wait loop), so
 * dedupe could silently merge deliberate commands. No content validation by design
 * (26a's posture — the operator authors them; non-empty-only is what the blank-drop
 * guarantees, and it is exactly 26a's one normalize constraint).
 */
export function parseBootCommands(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

/**
 * The tier-(a) field list, seeded from `cfg` (the current doc, or 26a's defaults when
 * absent) so the operator sees and edits what is already set — the section wizard's
 * seed posture. Every kind comes from the existing four (`text|secret|select|confirm` —
 * spec 28 forbids new kinds); `extraPackages`/`bootCommands` ride `text` fields whose
 * parsing lives in {@link parsePackageList}/{@link parseBootCommands} (the vm section's
 * numbers-ride-text precedent: shape policy in the write path, never a new kind). Pure
 * — unit-tested directly.
 */
export function guestSetupFields(cfg: GuestConfig): ConfigField[] {
	return [
		{
			key: "hostname",
			label: "Hostname",
			kind: "text",
			default: cfg.hostname,
			help: "The installer's hostname — letters, digits, hyphens (e.g. omarchy-sandbox).",
		},
		{
			key: "timezone",
			label: "Timezone",
			kind: "text",
			default: cfg.timezone,
			help: "IANA zone token (UTC, America/New_York).",
		},
		{
			key: "keyboard",
			label: "Keyboard layout",
			kind: "text",
			default: cfg.keyboard,
			help: "Console/xkb layout token (us, de-latin1).",
		},
		{
			key: "username",
			label: "Username",
			kind: "text",
			default: cfg.username,
			help: "The Linux user the installer creates — letters, digits, hyphens.",
		},
		{
			key: "gitName",
			label: "Git name",
			kind: "text",
			default: cfg.gitName,
			help: "In-guest git commits attribute to this name.",
		},
		{
			key: "gitEmail",
			label: "Git email",
			kind: "text",
			default: cfg.gitEmail,
			help: "In-guest git commits attribute to this address.",
		},
		{
			key: "encrypt",
			label: "Encrypt the disk (LUKS)?",
			kind: "confirm",
			default: cfg.encrypt,
			help: "Off (the default) is the unattended unencrypted install.",
		},
		{
			key: "agent",
			label: "Default agent",
			kind: "select",
			options: GUEST_AGENTS.map((a) => ({ value: a, label: a })),
			default: cfg.agent,
			help: "The agent `omarchy default agent` bakes into the golden.",
		},
		{
			key: "extraPackages",
			label: "Extra packages",
			kind: "text",
			default: cfg.extraPackages.join(", "),
			help: "Comma-separated pacman package names; blank = none.",
		},
		{
			key: "bootCommands",
			label: "Boot-with commands",
			kind: "text",
			default: cfg.bootCommands.join("\n"),
			help: "Newline-separated commands run post-boot; blank = none.",
		},
	];
}

/** Narrow one `GUEST_AGENTS` membership check — `.some` over the tuple, no cast. */
function isGuestAgentValue(v: string): v is GuestAgent {
	return GUEST_AGENTS.some((a) => a === v);
}

/** Order-sensitive list equality (skip the probes when a parsed list equals the seed's). */
function sameList(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Reduce the wizard's answers (every key present — `reduceFields` fills each seeded
 * default) over the valid seed to a {@link GuestConfig}, or `err` naming the offending
 * field. Pure, terminal-free. Every shape check probes the REAL
 * `normalizeGuestConfig` — the seed is valid by 26a's contract
 * (`loadGuestConfig` returns normalized-or-defaults), so replacing ONE field at a
 * time makes `null` mean exactly "this answer broke the doc"; `gitName`/`gitEmail`
 * are free-form strings in 26a (nothing to localize) and `bootCommands` are
 * non-empty by construction ({@link parseBootCommands}). The final whole-doc gate
 * stays load-bearing: never persist a doc normalize rejects (27b).
 */
export function guestConfigFromAnswers(seed: GuestConfig, answers: Record<string, string>): Result<GuestConfig, Error> {
	const str = (key: string, fallback: string): string => {
		const v = answers[key];
		return v === undefined ? fallback : v;
	};
	const agentAnswer = str("agent", seed.agent);
	if (!isGuestAgentValue(agentAnswer)) {
		// The select only offers members, so an out-of-set answer can only arrive
		// non-interactively — `vmSelectValue`'s posture and voice (27b).
		return err(new Error(`agent must be one of ${GUEST_AGENTS.join(", ")} (got "${agentAnswer}")`));
	}
	const candidate: GuestConfig = {
		hostname: str("hostname", seed.hostname),
		timezone: str("timezone", seed.timezone),
		keyboard: str("keyboard", seed.keyboard),
		username: str("username", seed.username),
		gitName: str("gitName", seed.gitName),
		gitEmail: str("gitEmail", seed.gitEmail),
		encrypt: answers.encrypt === undefined ? seed.encrypt : answers.encrypt === "true",
		agent: agentAnswer,
		extraPackages: parsePackageList(str("extraPackages", seed.extraPackages.join(", "))),
		bootCommands: parseBootCommands(str("bootCommands", seed.bootCommands.join("\n"))),
	};
	const breaks = (mutated: GuestConfig): boolean => normalizeGuestConfig(mutated) === null;
	if (candidate.hostname !== seed.hostname && breaks({ ...seed, hostname: candidate.hostname })) {
		return err(new Error(`hostname "${candidate.hostname}" is not a valid host label (letters, digits, hyphens)`));
	}
	if (candidate.timezone !== seed.timezone && breaks({ ...seed, timezone: candidate.timezone })) {
		return err(
			new Error(`timezone "${candidate.timezone}" is not a valid timezone token (e.g. UTC, America/New_York)`),
		);
	}
	if (candidate.keyboard !== seed.keyboard && breaks({ ...seed, keyboard: candidate.keyboard })) {
		return err(new Error(`keyboard "${candidate.keyboard}" is not a valid layout token (e.g. us, de-latin1)`));
	}
	if (candidate.username !== seed.username && breaks({ ...seed, username: candidate.username })) {
		return err(new Error(`username "${candidate.username}" is not a valid user name (letters, digits, hyphens)`));
	}
	if (!sameList(candidate.extraPackages, seed.extraPackages)) {
		// Per-token probes: 26a's package charset is per-token, so one bad token fails alone.
		for (const token of candidate.extraPackages) {
			if (breaks({ ...seed, extraPackages: [token] })) {
				return err(new Error(`extra packages: "${token}" is not a valid package name`));
			}
		}
	}
	if (breaks(candidate)) {
		// Defensive — every reachable rejection is localized above; the gate mirrors
		// 27b's "write must never persist a shape the loader rejects" contract.
		return err(new Error("the answers do not form a valid guest config"));
	}
	return ok(candidate);
}

/** Injectable seams so {@link runGuestSetup} is hermetic (the `11a`/`13`/`17b`–`17k` precedent). */
export interface GuestSetupDeps {
	/** The io driving the warning confirm + field prompts (defaults to {@link defaultIo}). */
	io?: WizardIo;
	/** Banner destination for {@link runWizard} (defaults to `process.stdout`). */
	stream?: BannerStream;
	/**
	 * The vm tree the doc reads/writes (default: `resolveVmDirs({ homeDir })`).
	 * Pass `homeDir` instead to move BOTH the doc and the default golden probe to
	 * one tree — the single-tree guarantee.
	 */
	dirs?: VmDirs;
	/** The HOME the default dirs + default golden probe resolve against (tests: temp dir). */
	homeDir?: string;
	/**
	 * The golden-existence probe behind the post-golden warning (default:
	 * {@link newestGoldenId} over `homeDir` — 28d's dir-level existence probe, whose
	 * id the warning names). Tests inject a constant so the branch is hermetic.
	 */
	goldenId?: () => string | null;
}

/** The {@link runGuestSetup} outcome: `ok(saved config)`, `err(reason)`, or `null` (cancelled / warning declined — no write). */
export type GuestSetupResult = Result<GuestConfig, Error> | null;

/**
 * Run the Guest setup flow (spec 28, tier (a)): the post-golden warning (when a
 * golden exists — declining returns `null` with nothing written), then the fields
 * through the generic {@link runWizard} (one banner, from `withSession`), then the
 * answers reduced through the REAL normalize ({@link guestConfigFromAnswers}) and
 * persisted with 26a's atomic 0600 writer. Returns `ok(config)` on a saved doc,
 * `err` on an invalid answer or a write failure, `null` on cancel/decline.
 */
export async function runGuestSetup(deps: GuestSetupDeps = {}): Promise<GuestSetupResult> {
	const io = deps.io ?? defaultIo;
	const dirs = deps.dirs ?? resolveVmDirs({ homeDir: deps.homeDir });

	// 1. The post-golden warning PRECEDES the fields (spec 28 tier (a)): a bare
	//    `io.confirm` (the dashboard stop-confirm idiom) — the wizard banner frames
	//    only the field phase, exactly how `section.ts`'s bare select leads.
	const goldenId = (deps.goldenId ?? (() => newestGoldenId(deps.homeDir)))();
	if (goldenId !== null) {
		const proceed = await io.confirm({ message: goldenWarningMessage(goldenId), initialValue: true });
		if (proceed !== true) return null; // declined — no write (the cancelled-modal idiom)
	}

	// 2. Seed from the current doc and run the wizard engine unchanged.
	const seed = loadGuestConfig(dirs);
	const answers = await runWizard(GUEST_SETUP_TITLE, guestSetupFields(seed), io, { stream: deps.stream });
	if (answers === null) return null; // cancel / required-empty

	// 3. Answers → config through the real normalize, then persist via 26a's writer.
	const parsed = guestConfigFromAnswers(seed, answers);
	if (!parsed.ok) return parsed;
	try {
		saveGuestConfig(dirs, parsed.value);
	} catch (e) {
		// 26a's persistence boundary throws with a dir/file-scoped message; the wizard
		// converts it to err so the dashboard's flash renders it inline.
		return err(new Error(`cannot save the guest config: ${e instanceof Error ? e.message : String(e)}`));
	}
	return ok(parsed.value);
}
