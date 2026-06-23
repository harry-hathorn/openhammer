/**
 * The persisted settings document (spec 17d).
 *
 * `~/.openhammer/config.json` holds the two wizard-editable config families:
 * **channels** (how OpenHammer is reached — live tunnels plus static/deployed
 * URLs) and the **mcp** settings section (an allowed-client list). Both families
 * share the `ConfigField` wizard engine (`src/tui/`); this doc is simply where
 * their answers live. The doc, the schema, and the wizard are domain-agnostic —
 * this is the "configure other things later" seam.
 *
 * **Secrets never live here** — only non-secret `options` (a channel's declared
 * URL, labels, …). A channel's `id` doubles as the credentials-store key; the
 * secret values themselves are persisted separately in `credentials.json` (17e),
 * mirroring pi's OAuth-credential split. Atomic writes + `0700`/`0600` perms
 * match the spec-11 `~/.openhammer` precedent (see `src/auth/token.ts`).
 *
 * **Boundary posture:** persistence, not a tool execution. `loadSettings` never
 * throws — an absent or structurally corrupt doc yields safe `defaultSettings()`
 * (which `doctor` flags); `saveSettings` THROWS on a failure to create/write/
 * rename, the spec-11 `writeCredential` posture (a clear, dir/file-scoped message
 * the CLI boundary surfaces as actionable stderr). Both use raw `node:fs` rather
 * than the `tools/io.ts` `Result`-wrappers — those exist to keep *tool* bodies
 * try/catch-free, and this is the throwing persistence boundary, not a tool.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const SETTINGS_DIR = ".openhammer";
const SETTINGS_FILE = "config.json";

/** The on-disk schema version this loader reads and writes. */
const CURRENT_VERSION = 1;

/**
 * The two channel modes, as a const object + derived union (no `enum` —
 * `erasableSyntaxOnly`). `live` spawns a process (ngrok/cloudflared) and
 * discovers its URL; `static` declares a public URL the operator stands up.
 */
export const CHANNEL_MODES = {
	live: "live",
	static: "static",
} as const;
export type ChannelMode = (typeof CHANNEL_MODES)[keyof typeof CHANNEL_MODES];

/**
 * The known channel kinds, as a const object + derived union. A single source:
 * the union type, the loader's validation set, and (later) the registry all
 * derive from this object, so adding a kind is one edit and everything agrees.
 */
export const CHANNEL_KINDS = {
	ngrok: "ngrok",
	cloudflare: "cloudflare",
	nginx: "nginx",
	"static-url": "static-url",
} as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[keyof typeof CHANNEL_KINDS];

/**
 * One persisted channel. `id` is the wizard-minted `crypto.randomUUID()` and is
 * also the credentials-store key; `kind` picks the provider; `mode` is its
 * live/static nature; `label` is the human name shown in `channel list`;
 * `options` holds only non-secret values (e.g. a static channel's `publicUrl`).
 */
export interface ChannelEntry {
	id: string;
	kind: ChannelKind;
	mode: ChannelMode;
	label?: string;
	options: Record<string, string>;
}

/** The `mcp` settings section — `allowedClients` is `[]`/`["*"]` (any) or a User-Agent allowlist. */
export interface McpSettings {
	allowedClients: string[];
}

/** The whole settings document. `version` is the on-disk schema version. */
export interface Settings {
	version: number;
	channels: ChannelEntry[];
	defaultChannel: string | null;
	mcp: McpSettings;
}

/** Fresh defaults — returned by {@link loadSettings} when the doc is absent or corrupt. */
export function defaultSettings(): Settings {
	return { version: CURRENT_VERSION, channels: [], defaultChannel: null, mcp: { allowedClients: [] } };
}

/** Resolve `~/.openhammer/config.json` under a home directory (defaults to `os.homedir()`). */
export function settingsPath(homeDir: string = homedir()): string {
	return join(homeDir, SETTINGS_DIR, SETTINGS_FILE);
}

// ---- validation guards (narrow parsed JSON by hand — no `as`) ----

const CHANNEL_MODE_VALUES = new Set<string>(Object.values(CHANNEL_MODES));
const CHANNEL_KIND_VALUES = new Set<string>(Object.values(CHANNEL_KINDS));

function isChannelMode(v: unknown): v is ChannelMode {
	return typeof v === "string" && CHANNEL_MODE_VALUES.has(v);
}

function isChannelKind(v: unknown): v is ChannelKind {
	return typeof v === "string" && CHANNEL_KIND_VALUES.has(v);
}

/** A plain object whose own values are all strings (the `options` bag). */
function isStringRecord(v: unknown): v is Record<string, string> {
	if (typeof v !== "object" || v === null) return false;
	for (const value of Object.values(v)) {
		if (typeof value !== "string") return false;
	}
	return true;
}

function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isChannelEntry(v: unknown): v is ChannelEntry {
	if (typeof v !== "object" || v === null) return false;
	const o = v;
	return (
		"id" in o &&
		typeof o.id === "string" &&
		"kind" in o &&
		isChannelKind(o.kind) &&
		"mode" in o &&
		isChannelMode(o.mode) &&
		(!("label" in o) || typeof o.label === "string") &&
		(!("options" in o) || isStringRecord(o.options))
	);
}

/**
 * Validate a parsed value as a full {@link Settings} doc and return it in a
 * canonical form; `null` when it is structurally off (wrong shape, unknown kind,
 * …). Whole-doc granularity — a single malformed entry means the doc is corrupt,
 * which `doctor` (17p) surfaces; the wizard always writes canonical docs. The
 * single-source validator `doctor`'s config check reuses (rather than re-deriving
 * the shape contract): a non-`null` result is a valid doc, `null` is corrupt.
 */
export function normalizeSettings(v: unknown): Settings | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v;
	if (!("version" in o) || typeof o.version !== "number") return null;
	if (!("channels" in o) || !Array.isArray(o.channels) || !o.channels.every(isChannelEntry)) return null;
	if (!("defaultChannel" in o) || !(o.defaultChannel === null || typeof o.defaultChannel === "string")) return null;
	if (!("mcp" in o) || typeof o.mcp !== "object" || o.mcp === null) return null;
	const mcp = o.mcp;
	if (!("allowedClients" in mcp) || !isStringArray(mcp.allowedClients)) return null;
	return {
		version: o.version,
		channels: o.channels,
		defaultChannel: o.defaultChannel,
		mcp: { allowedClients: mcp.allowedClients },
	};
}

/**
 * Read & validate the settings doc. Absent, unreadable, or structurally corrupt
 * (the JSON won't parse, or the shape isn't a {@link Settings}) →
 * {@link defaultSettings}. Never throws — a corrupt doc is a `doctor`-flagged
 * soft failure, not a boot error.
 */
export function loadSettings(path: string = settingsPath()): Settings {
	if (!existsSync(path)) return defaultSettings();
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Corrupt/unreadable JSON → fall back to safe defaults.
		return defaultSettings();
	}
	return normalizeSettings(parsed) ?? defaultSettings();
}

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Atomically persist the settings doc: `mkdir -p` the dir (`0700`), write a temp
 * file (`0600`) in the same directory, then `rename` it over the target. `rename`
 * is atomic on a single filesystem, so a crash mid-write can never leave a
 * truncated `config.json` — the target is either the previous doc or the new one,
 * never a partial write (the spec-11 `writeCredential` hygiene, made crash-safe).
 * Throws with a clear, dir/file-scoped message when the dir cannot be created,
 * the temp cannot be written, or the rename fails; the temp is cleaned up on a
 * rename failure so no `.tmp` files linger.
 */
export function saveSettings(path: string, s: Settings): void {
	const dir = dirname(path);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		throw new Error(`Cannot create settings directory ${dir}: ${messageOf(e)}`);
	}
	const tmp = join(dir, `${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
	} catch (e) {
		throw new Error(`Cannot write settings file ${tmp}: ${messageOf(e)}`);
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
		throw new Error(`Cannot persist settings file ${path}: ${messageOf(e)}`);
	}
}
