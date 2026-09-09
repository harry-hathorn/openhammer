/**
 * The guest-config store (spec 26): `~/.openhammer/vm/guest.json` — the "Guest setup"
 * answers (spec 28's TUI section) that drive the NEXT golden build: the cidata fields
 * (hostname/timezone/keyboard/username/git identity/encrypt), the agent flavor
 * (`omarchy default agent`), extra packages, and the boot-with commands (written as
 * Omarchy's own post-boot hook by spec 26's provisioner — the guest shell is BASH per
 * the spike, and these lines are operator-authored commands, hence non-empty-only).
 *
 * **Boundary posture** — mirrors `src/config/settings.ts` verbatim (the existing
 * store precedent): persistence, not a tool execution. `loadGuestConfig` NEVER throws —
 * an absent, unreadable, or structurally corrupt doc (the JSON won't parse, or the
 * shape isn't a `GuestConfig`) yields safe `defaultGuestConfig()`, a doctor-flaggable
 * soft failure rather than a boot error; `saveGuestConfig` THROWS on a failure to
 * create/write/rename with a clear, dir/file-scoped message. The decision NOT to make
 * an invalid doc fatal is deliberate: a typo in guest.json must not strand the operator
 * outside the tool that fixes it — defaults build a working sandbox, and the doc is
 * rewritten canonically the next time the Guest-setup wizard saves. Raw `node:fs`, not
 * the `tools/io.ts` Result-wrappers (those keep *tool* bodies try/catch-free; this is
 * the throwing persistence boundary).
 *
 * **Edits apply on the NEXT build** (spec 26 edge case): guest.json changes after a
 * golden exists never mutate the existing image — the manifest is the record of what
 * was actually baked.
 *
 * Everything lives under `~/.openhammer/vm/` with 0600/0700 perms; nothing here ever
 * touches `MCP_ROOT_DIR`. Secrets NEVER live in this doc — only `secrets.ts`'s store.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { VmDirs } from "../session.ts";

const GUEST_CONFIG_FILE = "guest.json";

/**
 * Omarchy's first-class agents (manual 17-ai.md; design doc §5.5) — the 13 the TUI's
 * agent select offers and `omarchy default agent <agent>` accepts. Single source: the
 * union type, the normalize-time validation set, and spec 28's select all derive from
 * this array, so adding an agent is one edit and everything agrees.
 */
export const GUEST_AGENTS = [
	"claude",
	"codex",
	"opencode",
	"agy",
	"copilot",
	"crush",
	"grok",
	"pi",
	"omp",
	"ori",
	"hermes",
	"muse",
	"cursor-agent",
] as const;
export type GuestAgent = (typeof GUEST_AGENTS)[number];

const GUEST_AGENT_SET = new Set<string>(GUEST_AGENTS);

/**
 * The whole guest-config doc. Every field is required — whole-doc granularity (the
 * `normalizeSettings` idiom): the wizard always writes canonical docs, and a doc with a
 * hole in it is corrupt, not a partial config to be quietly default-filled.
 */
export interface GuestConfig {
	/** A single safe segment (see {@link SEGMENT_PATTERN}) — the installer's hostname. */
	readonly hostname: string;
	/** An IANA-ish zone token (`UTC`, `America/New_York`) — shape-guarded only. */
	readonly timezone: string;
	/** A console/xkb layout token (`us`, `de-latin1`) — shape-guarded only. */
	readonly keyboard: string;
	/** A single safe segment — the Linux user the installer creates. */
	readonly username: string;
	/** Loose git identity string (no content validation — it is operator text, quoted downstream). */
	readonly gitName: string;
	/** Loose git identity string (no content validation — it is operator text, quoted downstream). */
	readonly gitEmail: string;
	/** LUKS-disk-encryption toggle — `false` = the unattended unencrypted default. */
	readonly encrypt: boolean;
	/** The agent flavor baked into the golden via `omarchy default agent`. */
	readonly agent: GuestAgent;
	/** pacman tokens, each a `PACKAGE_TOKEN_PATTERN` match. */
	readonly extraPackages: readonly string[];
	/**
	 * Operator-authored commands (free-form bash lines, each NON-EMPTY; no content
	 * validation by design — the operator authors them, the provisioner writes them
	 * into Omarchy's post-boot hook verbatim).
	 */
	readonly bootCommands: readonly string[];
}

/**
 * Fresh defaults — returned by {@link loadGuestConfig} when the doc is absent or
 * corrupt, and the pre-filled values spec 28's wizard starts from. hostname/username/
 * timezone/keyboard/encrypt/agent are the spec-26 defaults; gitName/gitEmail are the
 * spike's (cidata.ts `GUEST_FULL_NAME`/`GUEST_EMAIL`) sandbox placeholders — they make
 * in-guest git commits attributable to the sandbox without naming anyone real.
 */
export function defaultGuestConfig(): GuestConfig {
	return {
		hostname: "omarchy-sandbox",
		timezone: "UTC",
		keyboard: "us",
		username: "sandbox",
		gitName: "OpenHammer Sandbox",
		gitEmail: "sandbox@openhammer.local",
		encrypt: false,
		agent: "claude",
		extraPackages: [],
		bootCommands: [],
	};
}

/** Resolve `<dirs.root>/guest.json` — the one path this store owns. */
export function guestConfigPath(dirs: VmDirs): string {
	return join(dirs.root, GUEST_CONFIG_FILE);
}

// ---- validation guards (narrow parsed JSON by hand — no `as`, no zod) ----

/**
 * A single safe segment, shared by hostname and username (both land in the installer's
 * JSON and in shell contexts): 1-63 chars of letters/digits/hyphen, alnum at both ends
 * (RFC 1123 label shape — also inside useradd's charset). No dots, no underscores, no
 * leading/trailing hyphen, no whitespace — a segment that can't become a path trick or
 * a split token.
 */
const SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;

// Shape guards, NOT existence checks — the installer is the authority on which
// timezones/layouts actually exist. These keep the tokens single-line, whitespace-free,
// and metachar-free so they can never break out of the JSON or the shell contexts
// spec 26 writes them into.
const TIMEZONE_PATTERN = /^[A-Za-z0-9_+/.-]+$/; // UTC, America/New_York, Etc/GMT+5
const KEYBOARD_PATTERN = /^[A-Za-z0-9-]+$/; // us, de-latin1, dvorak

/**
 * A pacman-ish token: strict charset (letters/digits/`@._+-` — repo and package name
 * shapes) rather than a "no bad chars" list, so an exotic-but-valid future separator
 * still fails closed instead of sneaking whitespace or shell metachars through.
 */
const PACKAGE_TOKEN_PATTERN = /^[A-Za-z0-9@._+-]+$/;

function isGuestAgent(v: unknown): v is GuestAgent {
	return typeof v === "string" && GUEST_AGENT_SET.has(v);
}

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

/**
 * Validate a parsed value as a full {@link GuestConfig} and return it canonically;
 * `null` when it is structurally off (wrong shape, bad segment, unknown agent, …).
 * Whole-doc granularity, the settings.ts idiom — one malformed field means the doc is
 * corrupt, not a config to be partially trusted; `loadGuestConfig` then yields defaults
 * and the next wizard save rewrites the doc canonically. Unknown EXTRA keys are ignored
 * (also the settings.ts posture — forward compatibility is not corruption).
 */
export function normalizeGuestConfig(v: unknown): GuestConfig | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v;
	if (!("hostname" in o) || typeof o.hostname !== "string" || !SEGMENT_PATTERN.test(o.hostname)) return null;
	if (!("timezone" in o) || typeof o.timezone !== "string" || !TIMEZONE_PATTERN.test(o.timezone)) return null;
	if (!("keyboard" in o) || typeof o.keyboard !== "string" || !KEYBOARD_PATTERN.test(o.keyboard)) return null;
	if (!("username" in o) || typeof o.username !== "string" || !SEGMENT_PATTERN.test(o.username)) return null;
	if (!("gitName" in o) || typeof o.gitName !== "string") return null;
	if (!("gitEmail" in o) || typeof o.gitEmail !== "string") return null;
	if (!("encrypt" in o) || typeof o.encrypt !== "boolean") return null;
	if (!("agent" in o) || !isGuestAgent(o.agent)) return null;
	if (!("extraPackages" in o) || !Array.isArray(o.extraPackages)) return null;
	if (!o.extraPackages.every((p) => typeof p === "string" && PACKAGE_TOKEN_PATTERN.test(p))) return null;
	if (!("bootCommands" in o) || !Array.isArray(o.bootCommands)) return null;
	if (!o.bootCommands.every((c) => isNonEmptyString(c))) return null;
	return {
		hostname: o.hostname,
		timezone: o.timezone,
		keyboard: o.keyboard,
		username: o.username,
		gitName: o.gitName,
		gitEmail: o.gitEmail,
		encrypt: o.encrypt,
		agent: o.agent,
		extraPackages: o.extraPackages,
		bootCommands: o.bootCommands,
	};
}

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Read & validate the guest-config doc. Absent, unreadable, or structurally corrupt →
 * {@link defaultGuestConfig} (the `loadSettings` posture quoted in the module header —
 * never throws; a corrupt doc is a soft failure the doctor/wizard resolves).
 */
export function loadGuestConfig(dirs: VmDirs): GuestConfig {
	const path = guestConfigPath(dirs);
	if (!existsSync(path)) return defaultGuestConfig();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		// Corrupt/unreadable JSON → fall back to safe defaults.
		return defaultGuestConfig();
	}
	return normalizeGuestConfig(parsed) ?? defaultGuestConfig();
}

/**
 * Atomically persist the guest-config doc: `mkdir -p` the vm root (`0700`), write a temp
 * file (`0600`) in the same directory, then `rename` it over the target — the target is
 * either the previous doc or the new one, never a partial write (the `saveSettings`
 * hygiene, made crash-safe). Throws with a clear, dir/file-scoped message when the dir
 * cannot be created, the temp cannot be written, or the rename fails; the temp is
 * cleaned up on a rename failure so no `.tmp` files linger.
 */
export function saveGuestConfig(dirs: VmDirs, config: GuestConfig): void {
	const path = guestConfigPath(dirs);
	const dir = dirname(path);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		throw new Error(`Cannot create vm directory ${dir}: ${messageOf(e)}`);
	}
	const tmp = join(dir, `${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	} catch (e) {
		throw new Error(`Cannot write guest config file ${tmp}: ${messageOf(e)}`);
	}
	try {
		renameSync(tmp, path);
	} catch (e) {
		// Best-effort cleanup of the orphaned temp — the rename error is reported below.
		try {
			rmSync(tmp, { force: true });
		} catch {
			// rmSync failure is harmless here; report the rename failure.
		}
		throw new Error(`Cannot persist guest config file ${path}: ${messageOf(e)}`);
	}
}
