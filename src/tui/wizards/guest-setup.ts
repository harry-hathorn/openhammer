/**
 * The Guest setup wizards (spec 28) — tier (a), the `guest.json` build-config flow,
 * tier (b), the sandbox-secrets editor over the 0700 store, tier (c), the
 * provision.sh `$EDITOR` escape hatch, and the apply-to-running actions.
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
 * **Tier (b) — the secrets editor ({@link runSecretsSetup})** keeps the same
 * composition posture against a third store: 26a's `secrets.ts` (0700 dir, 0600
 * files — the ONLY home credential material may live in). It is a looped
 * menu editor beside the flat tier-(a) field walk (add/remove rows is not a fixed
 * field list), driven by the same `io` primitives; the masking discipline is
 * structural — the rendered model ({@link secretsModelLines}, the menu
 * descriptions, the removal labels) carries KEYS and "set" states, never a stored
 * VALUE, and a stored value only ever flows into `saveSecrets`. Matrix row 6
 * (apply semantics) lives inside the flow: with a live session the editor
 * PRECEDES with the applies-at-next-boot hint + a *Restart sandbox* shortcut that
 * reuses the wired 28b action — never a silent no-op.
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
 * **Tier (c) — the provision.sh escape hatch ({@link runProvisionEditor})** opens
 * `<vm root>/provision.sh` (provision.ts's module-private PROVISION_SCRIPT, restated)
 * in `$EDITOR`: created from a commented template on first open, never EXECUTED here —
 * it runs as bash in the guest during `vm provision` (provision.ts step (j), which
 * treats the operator's script as authoritative: a non-zero exit fails the run). No
 * $EDITOR idiom existed anywhere in src/, so the spawn is `$EDITOR <file>` as an ARG
 * ARRAY (AGENTS.md spawn hygiene; the editor inherits the terminal while the
 * dashboard's renderer is suspended), and an unset EDITOR is an actionable err naming
 * it — never a silently different editor. The saved flash names the only truth: the
 * script runs during the NEXT `vm provision`.
 *
 * **Apply-to-running ({@link runApplyAgent}/{@link runApplyTheme})** — spec 28's
 * matrix row 7: two curated ONE-ssh-exec actions against the LIVE guest.
 * Unowned-friendly by design: 28c resolved the `VmService` handle is
 * child-process-side, but the GUEST is addressable from any process holding the three
 * local facts the dashboard already has — the session id + live ssh port ride the
 * vm-state line (the store's `latestVmState`), and the pinned key
 * `<vm root>/id_ed25519` + the session dir's known_hosts pin are plain files in the vm
 * tree (the service's `repinKnownHosts` re-keys the pin to `[127.0.0.1]:<port>` for
 * the CURRENT boot, so the file always pins the live port). The target is
 * loopback-only by TYPE (`SshTarget.host`), BatchMode, key-only — no passwords
 * anywhere, and the pin makes an orphan VM on a reused port fail safe. The AGENT
 * action is the DIRECT FILE WRITE of `~/.config/omarchy/defaults/agent` over ssh —
 * deliberately NOT `omarchy default agent <x>`: the CLI setter is a Wayland picker
 * (22-measured finding 12; rc 0 and nothing persisted headless). The write command is
 * a CONSTANT argv whose payload rides `sshExec`'s stdin (provision.ts's `cat >` idiom)
 * so no operator-shaped value ever enters a shell string. The THEME action fetches
 * `omarchy theme list` and — when the list fails — degrades the select to a text field
 * with the failure as the hint (spec 28's documented fallback; it never blocks the
 * screen). Every exec-OUTCOME result, success or failure, carries the row-7 hint:
 * these affect FUTURE agent/theme launches — a running tmux agent keeps the old one
 * until the sandbox restarts.
 *
 * **Result spine:** `ok(GuestConfig)` (saved — the doc on disk IS the return),
 * `err(Error)` (an answer no valid doc can carry, or a write failure), or `null`
 * (cancelled, or the post-golden warning declined — no write, silent). Hermetic by
 * injection (the `11a`/`13`/`17b`–`17k` precedent): io/stream/dirs/probe all default
 * to production and are overridden by the tests.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { VmStateLine } from "../../observability/status-socket.ts";
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
import {
	loadSecrets,
	normalizeSecrets,
	type SecretFileMapping,
	type SecretsStore,
	saveSecrets,
} from "../../vm/provision/secrets.ts";
import { readManifest } from "../../vm/provision/snapshot.ts";
import { resolveVmDirs, type VmDirs } from "../../vm/session.ts";
import { type SshExecResult, type SshTarget, sshExec, sshTargetForPort } from "../../vm/ssh.ts";
import type { BannerStream } from "../banner.ts";
import { defaultIo, type SelectOption, withSession } from "../prompts.ts";
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

// ---- tier (b): the sandbox-secrets editor (spec 28, box 28f) ---------------------

/** The secrets editor's title — the banner `withSession` frames the loop with. */
export const SECRETS_SETUP_TITLE = "Sandbox secrets";

/**
 * The row-6 hint (spec 28's interaction matrix, row 6), verbatim semantics: edits
 * land in the 0700 store and injection happens at session START, so while a
 * session is live the flow PRECEDES the editor with this hint + a *Restart
 * sandbox* shortcut — never a silent no-op. Exported so tests pin the surface.
 */
export const SECRETS_LIVE_HINT = "a sandbox session is live — these secrets apply at the next sandbox boot";

/**
 * The row-6 interstitial's two choices. The restart label deliberately mirrors
 * `SANDBOX_RESTART_LABEL`'s wording (tui/dashboard/screens.ts): the shortcut IS
 * that action — {@link SecretsSetupDeps.restartSandbox} carries the wired 28b
 * action itself, so only the wording is restated (the wizards layer must not
 * import the dashboard layer).
 */
export const SECRETS_EDIT_CHOICE = "Edit secrets";
export const SECRETS_RESTART_CHOICE = "Restart sandbox…";

// The 26a grammar, restated as the TUI's contract. src/vm/provision/secrets.ts is
// UNTOUCHED — its rules are THE single validity source; these constants exist only
// so the editor's errors can NAME the rule the operator broke, and every candidate
// is re-gated through the REAL `normalizeSecrets` before any save, so a drift here
// can never persist a shape the store rejects.

/** 26a's env-key grammar (secrets.ts's ENV_KEY_PATTERN). */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/**
 * 26a's forbidden characters in values and paths: newlines would corrupt the
 * line-based env file, NUL would truncate C-string consumers.
 */
const FORBIDDEN_CHARS = /[\r\n\0]/;

/**
 * The 26a rejection for one env pair, localized for the editor: `null` when the
 * pair is valid, else the message naming the exact rule it breaks (the key
 * grammar / the line-based value rule). Pure — the flow surfaces it as the
 * wizard's err and writes nothing (the tier-(a) invalid-answer posture).
 */
export function envPairError(key: string, value: string): string | null {
	if (!ENV_KEY_PATTERN.test(key)) {
		return `"${key}" is not a valid env key — use uppercase letters, digits, and underscores, starting with a letter or underscore`;
	}
	if (FORBIDDEN_CHARS.test(value)) {
		return `the value for ${key} contains a newline or NUL — env values are single lines`;
	}
	return null;
}

/**
 * The 26a rejection for one host→guest mapping against the current set: both
 * paths absolute (leading `/`) with no newline/NUL (secrets.ts's
 * `isAbsolutePath`), and the duplicate-guestPath rule — 26a's normalizeSecrets
 * rejects the whole store because two mappings to one guest path would silently
 * clobber at consumption (spec 29). `null` when the mapping is addable.
 */
export function fileMappingError(
	hostPath: string,
	guestPath: string,
	existing: readonly SecretFileMapping[],
): string | null {
	for (const p of [hostPath, guestPath]) {
		if (!p.startsWith("/") || FORBIDDEN_CHARS.test(p)) {
			return `"${p}" is not an absolute path — it must start with "/" and hold no newline or NUL`;
		}
	}
	if (existing.some((f) => f.guestPath === guestPath)) {
		return `"${guestPath}" is already mapped — each guest path may be used once`;
	}
	return null;
}

/** One env key's masked row — the "set" state; the stored VALUE never renders. */
export function envKeyLine(key: string): string {
	return `${key} — set`;
}

/**
 * One host→guest mapping's row. Existence on the host is checked SOFTLY via the
 * `hostFileExists` probe (spec 26: a credential may be mapped before it exists;
 * consumption checks at session start) — the note renders, nothing blocks.
 */
export function fileMapLine(mapping: SecretFileMapping, hostFileExists: (path: string) => boolean): string {
	return `${mapping.hostPath} → ${mapping.guestPath}${hostFileExists(mapping.hostPath) ? "" : " (file missing on host)"}`;
}

/** The env half's one-line masked state ("none set" / "2 set (values hidden)") — the menu's descriptions. */
export function envSummary(env: Record<string, string>): string {
	const n = Object.keys(env).length;
	if (n === 0) return "none set";
	return n === 1 ? "1 set (value hidden)" : `${n} set (values hidden)`;
}

/** The files half's one-line masked state, with any missing-host-file count folded in. */
export function fileSummary(files: readonly SecretFileMapping[], hostFileExists: (path: string) => boolean): string {
	const n = files.length;
	if (n === 0) return "none mapped";
	const missing = files.filter((f) => !hostFileExists(f.hostPath)).length;
	const base = n === 1 ? "1 mapped" : `${n} mapped`;
	return missing > 0 ? `${base} — ${missing} missing on host` : base;
}

/**
 * The editor's rendered model — the canonical masked render (the menu's row
 * descriptions and removal labels are built from the same pieces). Keys,
 * "set" states, path mappings, and the soft missing-file notes; a stored VALUE
 * never appears (the secrecy test greps every line for seeded values). Pure.
 */
export function secretsModelLines(store: SecretsStore, hostFileExists: (path: string) => boolean): string[] {
	return [
		`env: ${envSummary(store.env)}`,
		...Object.keys(store.env).map(envKeyLine),
		`files: ${fileSummary(store.files, hostFileExists)}`,
		...store.files.map((f) => fileMapLine(f, hostFileExists)),
	];
}

/** The editor menu's rows — the remove rows only when there is something to remove; the descriptions carry the MASKED state. */
function menuOptions(
	env: Record<string, string>,
	files: readonly SecretFileMapping[],
	hostFileExists: (path: string) => boolean,
): SelectOption[] {
	return [
		{ value: "add-env", label: "Add an env pair…", hint: envSummary(env) },
		...(Object.keys(env).length > 0
			? [{ value: "remove-env", label: "Remove an env pair…", hint: envSummary(env) }]
			: []),
		{ value: "add-file", label: "Add a credential file…", hint: fileSummary(files, hostFileExists) },
		...(files.length > 0
			? [{ value: "remove-file", label: "Remove a credential file…", hint: fileSummary(files, hostFileExists) }]
			: []),
		{ value: "save", label: "Save and exit", hint: "write the 0700 store (env + file map, both 0600)" },
		{ value: "cancel", label: "Cancel", hint: "leave without writing" },
	];
}

/** Injectable seams so {@link runSecretsSetup} is hermetic (the tier-(a) precedent). */
export interface SecretsSetupDeps {
	/** The io driving the interstitial + the editor's prompts (defaults to {@link defaultIo}). */
	io?: WizardIo;
	/** Banner destination for `withSession` (defaults to `process.stdout`). */
	stream?: BannerStream;
	/**
	 * The vm tree the store reads/writes (default: `resolveVmDirs({ homeDir })`).
	 * Pass `homeDir` instead to move the store to one tree — the single-tree
	 * guarantee.
	 */
	dirs?: VmDirs;
	/** The HOME the default dirs resolve against (tests: temp dir). */
	homeDir?: string;
	/**
	 * The row-6 liveness probe (spec 28's matrix row 6) — the wiring passes 28d's
	 * `() => vmSessionActive(store.latestVmState)` over the vm-state line. Default:
	 * no live session (no interstitial).
	 */
	sessionActive?: () => boolean;
	/**
	 * The 28b *Restart sandbox* action the live-session shortcut invokes — the
	 * wiring passes the WIRED action (`actions.restartSandbox`), so the shortcut
	 * inherits the owned-server gate, the single-flight guard, and the
	 * pending-flag clearing instead of duplicating any of it. Absent → the picked
	 * shortcut errs (never a silent no-op).
	 */
	restartSandbox?: () => Promise<Result<void, Error> | null>;
	/** The host-existence probe behind the soft note (default `existsSync` — never throws). */
	hostFileExists?: (path: string) => boolean;
}

/** The {@link runSecretsSetup} outcome: `ok(saved store)`, `err(reason)`, or `null` (cancelled — no write). */
export type SecretsSetupResult = Result<SecretsStore, Error> | null;

// The editor's prompt messages (module-private; the tests match on them verbatim).
const SECRETS_MENU_MESSAGE = "Secrets editor — stored values stay hidden";
const ENV_KEY_PROMPT = "Env key (uppercase letters, digits, underscores — an existing key re-enters its value)";
const HOST_PATH_PROMPT = "Credential file — host path (absolute, leading /)";
const GUEST_PATH_PROMPT = "Credential file — guest target path (absolute, leading /)";
const REMOVE_ENV_PROMPT = "Remove which env pair?";
const REMOVE_FILE_PROMPT = "Remove which credential file?";

/**
 * Run the secrets editor (spec 28, tier (b), box 28f): the row-6 interstitial
 * when a session is live, then a looped masked menu (add/remove env pairs on the
 * 26a grammar; add/remove host→guest file mappings on the absolute-path +
 * duplicate-guestPath rules) over a WORKING COPY seeded from the store, then —
 * only on Save — the whole candidate through the REAL `normalizeSecrets` gate and
 * 26a's `saveSecrets` (0700 dir / 0600 files, the only writer). Host files are
 * NEVER read or copied here (consumption is session-start, spec 29); existence
 * renders only as the soft "(file missing on host)" note. Masking is structural:
 * prompts, labels, and the model carry keys/paths/"set" states — a stored VALUE
 * is never re-rendered, and "changing a key" is re-entering its full value.
 *
 * Result spine (the tier-(a) shape): `ok(saved store)` — the store on disk IS the
 * return; `err(Error)` — an answer no valid store can carry, an unwired restart
 * shortcut, or a write failure (surfaced inline by the dashboard's flash); `null`
 * — cancelled at any prompt, the interstitial, or a declined removal-adjacent
 * cancel. Hermetic by injection: io/stream/dirs/probes/action all default to
 * production and are overridden by the tests.
 */
export async function runSecretsSetup(deps: SecretsSetupDeps = {}): Promise<SecretsSetupResult> {
	const io = deps.io ?? defaultIo;
	const dirs = deps.dirs ?? resolveVmDirs({ homeDir: deps.homeDir });
	const hostFileExists = deps.hostFileExists ?? existsSync;

	// 1. Seed from the 0700 store (26a: loadSecrets NEVER throws — absent/corrupt
	//    halves read empty) and take edits on a working copy: nothing is written
	//    until the save step's normalize gate + saveSecrets.
	const seed = loadSecrets(dirs);
	const env: Record<string, string> = { ...seed.env };
	const files: SecretFileMapping[] = [...seed.files];

	// 2. The row-6 interstitial (spec 28's matrix row 6): with a LIVE session the
	//    flow PRECEDES the editor with the apply hint + the *Restart sandbox*
	//    shortcut (the wired 28b action — reused, not duplicated). Never a silent
	//    no-op: the hint is unconditional when a session is live, and a picked-but-
	//    unwired shortcut errs. No live session → no interstitial (the tier-(a)
	//    warning's precedes-the-fields shape: a bare select before the banner).
	if ((deps.sessionActive ?? (() => false))()) {
		const choice = await io.select({
			message: SECRETS_LIVE_HINT,
			options: [
				{ value: "edit", label: SECRETS_EDIT_CHOICE, hint: "saved secrets load at the next boot" },
				{ value: "restart", label: SECRETS_RESTART_CHOICE, hint: "stop, then a fresh boot — then edit" },
			],
			initialValue: "edit",
		});
		if (choice === null) return null; // cancelled — silent
		if (choice === "restart") {
			if (deps.restartSandbox === undefined) {
				return err(new Error("no sandbox restart action is wired here"));
			}
			const restarted = await deps.restartSandbox();
			if (restarted === null) return null; // the action declined — silent (the modal idiom)
			if (!restarted.ok) return restarted; // the unowned/in-flight hint, surfaced inline
			// Accepted — teardown + a fresh boot are in flight; THESE edits still load
			// at the NEXT boot after it (the flash restates the honesty).
		}
	}

	// 3. The editor loop, framed by withSession (one banner — the tier-(a) shape).
	return withSession(
		SECRETS_SETUP_TITLE,
		async () => {
			for (;;) {
				const action = await io.select({
					message: SECRETS_MENU_MESSAGE,
					options: menuOptions(env, files, hostFileExists),
					initialValue: "add-env",
				});
				if (action === null || action === "cancel") return null; // nothing written
				if (action === "save") {
					// The whole-store gate through the REAL normalize (27b's contract:
					// never persist a shape the loader rejects). Defensive — every
					// reachable rejection is localized at entry (envPairError /
					// fileMappingError).
					const gate = normalizeSecrets({ env, files });
					if (gate === null) {
						return err(new Error("the edited secrets do not form a valid store — nothing was written"));
					}
					try {
						saveSecrets(dirs, gate);
					} catch (e) {
						// 26a's throwing persistence boundary, converted so the dashboard's
						// flash renders it inline (the tier-(a) save posture).
						return err(new Error(`cannot save the secrets: ${e instanceof Error ? e.message : String(e)}`));
					}
					return ok(gate);
				}
				if (action === "add-env") {
					const rawKey = await io.text({ message: ENV_KEY_PROMPT });
					if (rawKey === null) return null; // cancelled — nothing written
					const key = rawKey.trim();
					if (key === "") return null; // required-empty — the cancelled idiom
					const value = await io.password({ message: `Value for ${key} (masked — stored verbatim, never shown)` });
					if (value === null) return null;
					const problem = envPairError(key, value);
					if (problem !== null) return err(new Error(problem));
					// An existing key overwrites: the stored value is never re-rendered,
					// so changing a key IS re-entering the full value. Values are stored
					// verbatim (no trim — a secret may legitimately carry whitespace).
					env[key] = value;
					continue;
				}
				if (action === "remove-env") {
					const key = await io.select({
						message: REMOVE_ENV_PROMPT,
						options: Object.keys(env).map((k) => ({
							value: k,
							label: envKeyLine(k), // keys only — the stored value stays hidden
							hint: "the stored value stays hidden",
						})),
					});
					if (key === null) return null;
					const sure = await io.confirm({ message: `Remove env pair ${key}?`, initialValue: false });
					if (sure === null) return null;
					if (sure) delete env[key];
					continue;
				}
				if (action === "add-file") {
					const rawHost = await io.text({ message: HOST_PATH_PROMPT });
					if (rawHost === null) return null;
					const hostPath = rawHost.trim();
					if (hostPath === "") return null;
					const rawGuest = await io.text({ message: GUEST_PATH_PROMPT });
					if (rawGuest === null) return null;
					const guestPath = rawGuest.trim();
					if (guestPath === "") return null;
					const problem = fileMappingError(hostPath, guestPath, files);
					if (problem !== null) return err(new Error(problem));
					// NOT read or copied here — consumption is session-start (spec 29);
					// existence renders only as the soft note (fileMapLine).
					files.push({ hostPath, guestPath });
					continue;
				}
				if (action === "remove-file") {
					const picked = await io.select({
						message: REMOVE_FILE_PROMPT,
						options: files.map((f, i) => ({
							value: String(i),
							label: fileMapLine(f, hostFileExists),
							hint: f.guestPath,
						})),
					});
					if (picked === null) return null;
					const index = Number(picked); // our own option values — NaN routes to the guard below
					const victim: SecretFileMapping | undefined = files[index];
					if (victim === undefined) continue; // a foreign answer never routes into a deletion
					const sure = await io.confirm({
						message: `Remove credential file ${victim.hostPath} → ${victim.guestPath}?`,
						initialValue: false,
					});
					if (sure === null) return null;
					if (sure) files.splice(index, 1);
				}
			}
		},
		{ io, stream: deps.stream },
	);
}

// ---- tier (c): the provision.sh escape hatch (spec 28, box 28g) -------------------

/**
 * The provision.sh file name — provision.ts's module-private `PROVISION_SCRIPT`,
 * restated (not exported there; the SERIAL_LOG_FILE precedent in dashboard.ts). The
 * SAME name the provisioner reads at `<vm root>/provision.sh` and streams into the
 * guest during `vm provision` step (j) — one restatement, never a drift.
 */
const PROVISION_SCRIPT_FILE = "provision.sh";

/**
 * The saved flash (the root shows it on `ok`): the editor wrote the file and NOTHING
 * ran here — the script's only execution is inside the guest during the next
 * `vm provision`. Exported so the root and these tests share the single surface.
 */
export const PROVISION_SAVED_FLASH = "provision.sh saved — it runs during the next `vm provision`.";

/**
 * The exact err when `$EDITOR` is unset: actionable (names the variable AND the fix,
 * which documents the plain-vi fallback the box calls for) — never a silent spawn of
 * some other editor. Exported so tests pin the surface.
 */
export const PROVISION_NO_EDITOR_ERROR =
	"no $EDITOR is set — export EDITOR=vim (or vi, nano) to edit the sandbox's provision.sh";

/**
 * The first-open template: a header explaining what the file IS (run as bash IN THE
 * GUEST during `vm provision`; operator-authored; authoritative — a non-zero exit
 * fails the provision run) and a two-line example, everything commented so saving it
 * untouched is a harmless no-op at provision time (every line a comment). Verbatim —
 * the tests pin this exact string.
 */
export function provisionTemplate(): string {
	return [
		"#!/usr/bin/env bash",
		"# OpenHammer's provision.sh — the operator's escape hatch (specs 26/28).",
		"# Runs as bash IN THE GUEST during `vm provision`, after the base provisioning.",
		"# Operator-authored and authoritative: a non-zero exit FAILS the provision run.",
		"#",
		"# Example:",
		"#   pacman -Sy --noconfirm htop",
		"#   git config --global init.defaultBranch main",
		"",
	].join("\n");
}

/** `<vm root>/provision.sh` — the exact path provision.ts's step (j) reads. Pure. */
export function provisionScriptPath(dirs: VmDirs): string {
	return join(dirs.root, PROVISION_SCRIPT_FILE);
}

/** The editor runner's seam: spawn `$EDITOR <file>` and resolve on a clean exit. */
export type RunEditor = (argv: readonly string[]) => Promise<void>;

// The production runner: stdio inherited (the editor IS the foreground program while
// the dashboard's renderer is suspended — the withModal handoff), env inherited. No
// host shell, no detachment, no kill surface: the operator closes the editor.
const runEditorDefault: RunEditor = (argv) =>
	new Promise<void>((resolve, reject) => {
		const child = spawn(argv[0] ?? "", argv.slice(1), { stdio: "inherit" });
		child.on("error", (error: Error) => reject(error));
		child.on("close", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`exited ${code ?? "on a signal"}`));
		});
	});

/** Injectable seams so {@link runProvisionEditor} is hermetic (the tiers-(a)/(b) precedent). */
export interface ProvisionEditorDeps {
	/**
	 * The vm tree the script lives in (default: `resolveVmDirs({ homeDir })`).
	 * Pass `homeDir` instead to move the whole tree to one place — the single-tree
	 * guarantee.
	 */
	dirs?: VmDirs;
	/** The HOME the default dirs resolve against (tests: temp dir). */
	homeDir?: string;
	/** The env `$EDITOR` is read from (default `process.env`; tests inject `{}` for the unset case). */
	env?: NodeJS.ProcessEnv;
	/** The editor runner (default {@link runEditorDefault}; tests record argv + "edit"). */
	runEditor?: RunEditor;
}

/**
 * Open the operator's `provision.sh` in `$EDITOR` (spec 28, tier (c)): with no
 * `$EDITOR` set, err naming it BEFORE anything is written; on the first open create
 * the file from {@link provisionTemplate} (0700 dir, 0600 file — the vm-tree
 * posture); then hand the file to the editor and wait. NOTHING executes here — the
 * script's only run is in the guest during `vm provision` (provision.ts step (j)),
 * which is exactly what {@link PROVISION_SAVED_FLASH} says. The flow is
 * owned-agnostic like its sibling editors (a local build input, not a server
 * setting). Result spine: `ok(undefined)` (the editor exited cleanly — flash the
 * saved line), `err(Error)` (no editor, an unwritable tree, or an editor failure),
 * `null` is never returned (there is nothing to cancel — the editor's own exit IS
 * the outcome).
 */
export async function runProvisionEditor(deps: ProvisionEditorDeps = {}): Promise<Result<void, Error>> {
	const dirs = deps.dirs ?? resolveVmDirs({ homeDir: deps.homeDir });
	// 1. The editor gate PRECEDES any write: failing fast with the actionable err must
	//    not leave a template behind as a side effect of a failed open.
	const editor = (deps.env ?? process.env).EDITOR;
	if (editor === undefined || editor.trim() === "") {
		return err(new Error(PROVISION_NO_EDITOR_ERROR));
	}
	// 2. First open: create from the commented template. Existing file → opened as-is.
	const file = provisionScriptPath(dirs);
	if (!existsSync(file)) {
		try {
			mkdirSync(dirs.root, { recursive: true, mode: 0o700 });
			writeFileSync(file, provisionTemplate(), { mode: 0o600 });
		} catch (e) {
			return err(new Error(`cannot create ${file}: ${e instanceof Error ? e.message : String(e)}`));
		}
	}
	// 3. The editor, as an ARG ARRAY (`$EDITOR <file>` — spawn hygiene; the value is
	//    whatever the operator exported, one token).
	try {
		await (deps.runEditor ?? runEditorDefault)([editor, file]);
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		return err(new Error(`cannot run $EDITOR ("${editor}"): ${reason}`));
	}
	return ok(undefined);
}

// ---- apply-to-running: the two curated ssh actions (spec 28, box 28g) -------------

/**
 * The row-7 hint (spec 28's interaction matrix, row 7) — appended to EVERY
 * apply-to-running exec outcome's result text, success or failure: these writes
 * affect FUTURE agent/theme launches; a running tmux agent keeps the old one until
 * the sandbox restarts. Exported so tests pin the surface.
 */
export const APPLY_TO_RUNNING_HINT =
	"affects future agent/theme launches — a running agent keeps the old one until the sandbox restarts";

/** The two flows' banner titles (framed by `withSession`; the dashboard passes a silent stream). */
export const APPLY_AGENT_TITLE = "Set default agent";
export const APPLY_THEME_TITLE = "Set theme";

// The prompt messages (module-private; the tests match on their stable substrings).
const AGENT_SELECT_MESSAGE = "Set the default agent — written to ~/.config/omarchy/defaults/agent in the guest";
const THEME_SELECT_MESSAGE = "Set the theme — the guest's own `omarchy theme list`";
const THEME_TEXT_MESSAGE = "Theme (the guest's theme list failed — enter one manually, e.g. tokyo-night)";

/**
 * Is the vm-state line READY ENOUGH to apply to — the Sandbox screen's visibility
 * signal for the two apply rows? {@link ./view.ts}'s `vmSessionActive` shape
 * (state `booting` or `ready`) PLUS the two fields the ssh construction consumes:
 * a session id (the session dir to pin against) and a discovered ssh port. Re-stated
 * here — not imported — because the wizards layer must not import the dashboard
 * layer (dashboard → wizards is the live direction). The vm-side truth beyond the
 * line stays the runtime's: the exec's own result is the authority.
 */
export function applyToRunningReady(line: VmStateLine | null): boolean {
	return (
		line !== null &&
		(line.state === "booting" || line.state === "ready") &&
		line.sessionId !== null &&
		line.sshPort !== null
	);
}

// service.ts's mint-time SESSION_ID_PATTERN, restated: the vm-state line is WIRE data
// (a hostile/buggy status socket could say anything), and the session id becomes a
// PATH SEGMENT below — an id outside the minted charset refuses the whole action.
const SESSION_ID_SAFE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

/**
 * The pinned ssh target for the LIVE session, composed entirely from existing
 * exports (src/vm/** is untouched): `sshTargetForPort` completes the port discovered
 * by the boot; the key is `<vm root>/id_ed25519` (cidata.ts mints it, the service
 * targets it); the known_hosts + ControlMaster socket live in the session dir —
 * `known_hosts` is RE-KEYED PER BOOT by the service's `repinKnownHosts` to
 * `[127.0.0.1]:<current port>`, so StrictHostKeyChecking=yes (part of every
 * `sshBaseArgv` these execs ride) pins exactly the live guest, and BatchMode +
 * IdentitiesOnly keep it key-only with no prompts. Loopback-only by type. Errs (no
 * hint — these are pre-exec guards, not launch-affecting outcomes) when the line is
 * absent/port undiscovered, the session id is not a safe path segment, or no guest
 * user is resolvable. Pure path math; nothing on disk is read here.
 */
export function sshTargetForVmLine(
	dirs: VmDirs,
	line: VmStateLine | null,
	guestUser: string | undefined,
): Result<SshTarget, Error> {
	if (line === null || line.sessionId === null || line.sshPort === null) {
		return err(new Error("no ready sandbox session to apply to — boot one first (Configure → set the boot mode)"));
	}
	if (!SESSION_ID_SAFE.test(line.sessionId)) {
		return err(
			new Error("the vm-state line's session id is not a safe path segment — refusing to address the session tree"),
		);
	}
	if (guestUser === undefined) {
		return err(
			new Error(
				"cannot resolve the guest user — no readable golden manifest under the vm tree (images/<id>/manifest.json)",
			),
		);
	}
	const sessionDir = join(dirs.sessions, line.sessionId);
	return ok(
		sshTargetForPort(
			{
				user: guestUser,
				host: "127.0.0.1",
				keyPath: join(dirs.root, "id_ed25519"),
				knownHostsPath: join(sessionDir, "known_hosts"),
				controlPath: join(sessionDir, "cm.sock"),
			},
			line.sshPort,
		),
	);
}

/**
 * The default-agent write's remote argv — a CONSTANT (the agent itself rides
 * `sshExec`'s `stdin`, so the operator-shaped value never enters ANY shell string):
 * `bash -c 'mkdir -p … && cat > …'`. bash because the guest shell is bash
 * (22-measured finding 11) and the command needs `$HOME` + `&&` + `>` — the inner
 * string is a shell command BY DESIGN (AGENTS.md's bash exception; the ssh layer
 * remoteQuote's the whole element so it arrives verbatim); `$HOME` is the ssh login's
 * home (sshd sets it from passwd — the same path 22-measured measured: the getter
 * reads `$HOME/.config/omarchy/defaults/agent`). THE DIRECT FILE WRITE per
 * 22-measured finding 12 — the `omarchy default agent` CLI setter is a Wayland
 * picker (rc 0, nothing persisted headless). The stdin pattern is provision.ts's own
 * `cat > file` provisioning step.
 */
export const AGENT_DEFAULTS_ARGV: readonly string[] = [
	"bash",
	"-c",
	'mkdir -p "$HOME/.config/omarchy/defaults" && cat > "$HOME/.config/omarchy/defaults/agent"',
];

/** The theme-list fetch's remote argv — each word arrives as one remoteQuote'd argument. */
export const THEME_LIST_ARGV: readonly string[] = ["omarchy", "theme", "list"];

/**
 * The theme-set remote argv: `omarchy theme set <t>` as an ARG ARRAY — sshExecArgv
 * remoteQuote's every element, so a theme containing spaces/quotes arrives as ONE
 * verbatim argument (never split, never re-evaluated by the remote shell).
 */
export function themeSetRemoteArgv(theme: string): string[] {
	return ["omarchy", "theme", "set", theme];
}

/**
 * Parse `omarchy theme list`'s stdout: split lines, trimmed, blanks dropped. The
 * output's exact shape is the guest CLI's business — this takes every non-empty line
 * as a theme token, which is exactly what the select offers; an empty parse degrades
 * to the text field like a failed fetch (the spec's never-blocks posture).
 */
export function parseThemeList(stdout: string): string[] {
	return stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "");
}

// snapshot.ts's module-private MANIFEST_FILE, restated (the SERIAL_LOG_FILE precedent).
const MANIFEST_FILE = "manifest.json";

/**
 * The newest golden manifest's `guestUser` — the ssh LOGIN for the apply actions
 * (SshTarget.user is "the manifest's guestUser — never the host user's name", and the
 * vm-state line carries no user). The newest golden is what a boot boots, so its
 * manifest is the live session's user record. `undefined` when no golden exists or
 * the manifest is absent/corrupt (`readManifest` never throws; the caller turns
 * `undefined` into the actionable target err). Reads the LOCAL vm tree only.
 */
export function newestGoldenGuestUser(homeDir?: string): string | undefined {
	const goldenId = newestGoldenId(homeDir);
	if (goldenId === null) return undefined;
	const manifest = readManifest(join(resolveVmDirs({ homeDir }).images, goldenId, MANIFEST_FILE));
	return manifest?.guestUser;
}

/** The ssh exec seam ({@link typeof sshExec}): production spawns the real pinned ssh; tests record. */
export type ApplySshExec = typeof sshExec;

/** One recorded ssh exec — the tests' assertion surface (target facts + argv + stdin). */
export interface RecordedSshExec {
	readonly target: SshTarget;
	readonly remoteArgv: readonly string[];
	readonly stdin: string | undefined;
}

/** Injectable seams so the apply flows are hermetic (the tiers-(a)/(b) precedent). */
export interface ApplyToRunningDeps {
	/** The io driving the agent/theme choice (defaults to {@link defaultIo}). */
	io?: WizardIo;
	/** Banner destination for `withSession` (defaults to `process.stdout`). */
	stream?: BannerStream;
	/**
	 * The vm tree the key/session-dir paths resolve from (default:
	 * `resolveVmDirs({ homeDir })`).
	 */
	dirs?: VmDirs;
	/** The HOME the default dirs resolve against (tests: temp dir). */
	homeDir?: string;
	/**
	 * The live vm-state line (the wiring passes the store's `latestVmState`).
	 * Absent/null → the actionable no-ready-session err (the rows are hidden when not
	 * ready; the flow still refuses, never silently no-ops).
	 */
	vmLine?: VmStateLine | null;
	/**
	 * The golden manifest's guest user (the wiring passes {@link newestGoldenGuestUser}'s
	 * result). Undefined → the actionable target err.
	 */
	guestUser?: string;
	/** The ssh exec (default: the real pinned {@link sshExec}; tests record + script exits). */
	sshExec?: ApplySshExec;
}

/** The apply flows' outcome: `ok(report line — hint included)`, `err(failure — hint included)`, or `null` (cancelled choice). */
export type ApplyToRunningResult = Result<string, Error> | null;

/**
 * One ssh failure's surfaced text: what was attempted, the exit code, the guest's
 * own words (both pipes' tails), then the row-7 hint — a failure is STILL a
 * future-launch hint carrier (the write may have half-landed; the sandbox restart
 * advice stands either way).
 */
function applySshFailure(what: string, ran: SshExecResult): string {
	const tail = [ran.stdoutTail.trim(), ran.stderrTail.trim()].filter((s) => s !== "").join(" | ");
	return `${what} failed in the guest (exit ${ran.exitCode}${tail === "" ? "" : `: ${tail}`}) — ${APPLY_TO_RUNNING_HINT}`;
}

/**
 * Set the RUNNING guest's default agent (spec 28, apply-to-running #1): a select of
 * the 13 `GUEST_AGENTS` seeded from the LOCAL `guest.json`'s agent (what the next
 * install bakes — the honest starting point for what the guest probably runs), then
 * ONE ssh exec: {@link AGENT_DEFAULTS_ARGV} with `<agent>\n` on stdin — the DIRECT
 * FILE WRITE of `~/.config/omarchy/defaults/agent` (22-measured finding 12: the CLI
 * setter is a Wayland picker, unusable headless). The exec outcome — success or
 * failure — carries {@link APPLY_TO_RUNNING_HINT} (matrix row 7); a cancelled select
 * is `null` (silent). Idempotent by nature (rewriting the same token is a no-op), so
 * no single-flight guard: these are not VmService lifecycle actions.
 */
export async function runApplyAgent(deps: ApplyToRunningDeps = {}): Promise<ApplyToRunningResult> {
	const io = deps.io ?? defaultIo;
	const dirs = deps.dirs ?? resolveVmDirs({ homeDir: deps.homeDir });
	return withSession(
		APPLY_AGENT_TITLE,
		async () => {
			const target = sshTargetForVmLine(dirs, deps.vmLine ?? null, deps.guestUser);
			if (!target.ok) return target;
			const agent = await io.select({
				message: AGENT_SELECT_MESSAGE,
				options: GUEST_AGENTS.map((a) => ({ value: a, label: a })),
				initialValue: loadGuestConfig(dirs).agent,
			});
			if (agent === null) return null; // cancelled — silent
			if (!isGuestAgentValue(agent)) {
				// The select only offers members — an out-of-set answer is non-interactive
				// only (the tier-(a) guard's voice).
				return err(new Error(`agent must be one of ${GUEST_AGENTS.join(", ")} (got "${agent}")`));
			}
			const ran = await (deps.sshExec ?? sshExec)(target.value, AGENT_DEFAULTS_ARGV, { stdin: `${agent}\n` });
			if (ran.exitCode !== 0) {
				return err(new Error(applySshFailure("writing the default agent", ran)));
			}
			return ok(`default agent written to ~/.config/omarchy/defaults/agent (${agent}) — ${APPLY_TO_RUNNING_HINT}`);
		},
		{ io, stream: deps.stream },
	);
}

/**
 * Set the RUNNING guest's theme (spec 28, apply-to-running #2): fetch the guest's
 * own `omarchy theme list` over ssh and offer it as a select; when the fetch fails
 * (or lists nothing) DEGRADE to a free-text field carrying the failure as its hint —
 * the spec's documented fallback, never a blocked screen — then ONE ssh exec of
 * `omarchy theme set <t>` ({@link themeSetRemoteArgv}: arg array, every word
 * remoteQuote'd, so any theme token arrives verbatim). Whether the headless CLI
 * honors a set is the runtime result's to say — the outcome is surfaced either way,
 * with {@link APPLY_TO_RUNNING_HINT} appended (matrix row 7).
 */
export async function runApplyTheme(deps: ApplyToRunningDeps = {}): Promise<ApplyToRunningResult> {
	const io = deps.io ?? defaultIo;
	const dirs = deps.dirs ?? resolveVmDirs({ homeDir: deps.homeDir });
	return withSession(
		APPLY_THEME_TITLE,
		async () => {
			const target = sshTargetForVmLine(dirs, deps.vmLine ?? null, deps.guestUser);
			if (!target.ok) return target;
			const exec = deps.sshExec ?? sshExec;
			// 1. The guest's own list.
			const listed = await exec(target.value, THEME_LIST_ARGV);
			const themes = listed.exitCode === 0 ? parseThemeList(listed.stdoutTail) : [];
			// 2. The choice: the select when the list came back; the degrade-to-text
			//    fallback (the failure IS the hint) when it did not. Empty text = cancelled
			//    (the required-empty idiom).
			let theme: string | null;
			if (themes.length > 0) {
				theme = await io.select({
					message: THEME_SELECT_MESSAGE,
					options: themes.map((t) => ({ value: t, label: t })),
				});
			} else {
				const detail =
					listed.exitCode === 0
						? "it listed no themes"
						: `exit ${listed.exitCode}: ${[listed.stdoutTail.trim(), listed.stderrTail.trim()].filter((s) => s !== "").join(" | ")}`;
				const raw = await io.text({ message: `${THEME_TEXT_MESSAGE} (${detail})` });
				theme = raw === null || raw.trim() === "" ? null : raw.trim();
			}
			if (theme === null) return null; // cancelled — silent
			// 3. The one set exec.
			const ran = await exec(target.value, themeSetRemoteArgv(theme));
			if (ran.exitCode !== 0) {
				return err(new Error(applySshFailure(`omarchy theme set ${theme}`, ran)));
			}
			return ok(`theme set to ${theme} — ${APPLY_TO_RUNNING_HINT}`);
		},
		{ io, stream: deps.stream },
	);
}
