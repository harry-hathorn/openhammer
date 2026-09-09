/**
 * The VM secrets store (spec 26): `~/.openhammer/vm/secrets/` (0700) — the per-session
 * credential material spec 29 pushes into the guest at session start.
 *
 * **The iron rule:** secrets NEVER live in the settings doc (`config.json` holds only
 * credId + non-secret options — the 17d/17e split), NEVER in logs, NEVER baked into the
 * golden image. This store is the only home; the golden build never reads it.
 *
 * Layout inside the 0700 dir:
 * - `env` (0600) — plain `KEY=value` lines, deliberately NOT JSON: the guest-side
 *   consumers (spec 29's `~/.openhammer/env` + `environment.d` conf) are line-based
 *   parsers, and a stray `cat` shows plain pairs. Keys use environment-variable grammar;
 *   multi-line values are rejected outright (the format is line-based — there is no
 *   honest way to store a newline in a line).
 * - `files.json` (0600) — the host-credential → guest-target map.
 *
 * **Boundary posture** — mirrors `src/config/credentials.ts` verbatim (the existing
 * secrets-store precedent): persistence, not a tool execution. `loadSecrets` NEVER
 * throws — an absent, unreadable, or structurally corrupt half yields that half empty
 * (a doctor-flaggable soft failure, never a boot error; the two files are judged
 * independently, so a hand-mangled `env` doesn't hide the file map); `saveSecrets`
 * THROWS on a write/perm failure with a clear, dir/file-scoped message. Raw `node:fs`,
 * not the `tools/io.ts` Result-wrappers (parity with settings.ts/credentials.ts).
 *
 * **Perms are hard-required.** `mkdir` + `chmod` on every save: mkdir's mode only
 * applies at creation, and this dir's 0700 is the whole posture (file NAMES leak which
 * services are credentialed even though the contents are 0600). The spike found 0700 is
 * a no-op on fuseblk mounts (NTFS) — noted and deliberately not accommodated: the
 * product path is ext4 (`~/.openhammer`), and a filesystem that can't hold the perms is
 * not one we silently downgrade security on. A chmod failure throws.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { VmDirs } from "../session.ts";

const ENV_FILE_NAME = "env";
const FILES_FILE_NAME = "files.json";

/** Environment-variable grammar (POSIX-ish upper-snake) — the `env` file is line-based. */
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

// Newlines would corrupt the line-based env format; NUL would truncate C-string
// consumers (ssh exec env forwarding, systemd EnvironmentFile). Both are rejected in
// values and in file paths alike.
const FORBIDDEN_VALUE_CHARS = /[\r\n\0]/;

/** One host credential file and its absolute in-guest destination. */
export interface SecretFileMapping {
	/** Absolute HOST path of the credential blob. Existence is NOT checked here — spec 29 checks at consumption (a credential may be mapped before it exists). */
	readonly hostPath: string;
	/** Absolute GUEST path (leading `/`) — resolved, never `~`-relative: spec 26's prose example writes `~/.claude/…`, and the TUI writer (spec 28) resolves it against the guest username so the consumption side never guesses. */
	readonly guestPath: string;
}

/**
 * The whole store. `env` is the KEY=value pairs pushed to both guest env files (spec
 * 29's dual injection); `files` is the credential file map, order-preserving.
 */
export interface SecretsStore {
	readonly env: Record<string, string>;
	readonly files: SecretFileMapping[];
}

/** Fresh empty store — what {@link loadSecrets} yields when nothing is configured yet. */
export function emptySecrets(): SecretsStore {
	return { env: {}, files: [] };
}

/** The three paths this store owns (the dir comes from `VmDirs.secrets` — session.ts's seam). */
function secretsPaths(dirs: VmDirs): { dir: string; envPath: string; filesPath: string } {
	return {
		dir: dirs.secrets,
		envPath: join(dirs.secrets, ENV_FILE_NAME),
		filesPath: join(dirs.secrets, FILES_FILE_NAME),
	};
}

// ---- validation guards (narrow parsed JSON by hand — no `as`, no zod) ----

/**
 * Readable-shaped path: absolute (leading `/`) with no newline/NUL — enough that the
 * host side can stat() it and no consumer can be confused by a control character. NOT
 * an existence check (see {@link SecretFileMapping.hostPath}).
 */
function isAbsolutePath(v: unknown): v is string {
	return typeof v === "string" && v.startsWith("/") && !FORBIDDEN_VALUE_CHARS.test(v);
}

/** An env bag: every key env-grammar, every value a non-newline string. */
function isEnvRecord(v: unknown): v is Record<string, string> {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	for (const [key, value] of Object.entries(v)) {
		if (!ENV_KEY_PATTERN.test(key)) return false;
		if (typeof value !== "string" || FORBIDDEN_VALUE_CHARS.test(value)) return false;
	}
	return true;
}

/**
 * Validate a parsed value as a full {@link SecretsStore}; `null` when it is structurally
 * off. Whole-doc granularity (the credentials.ts idiom): one malformed key/entry means
 * the store is corrupt and is treated as empty, never partially trusted. Duplicate
 * guestPaths are rejected — two mappings to one guest path would silently clobber at
 * consumption (spec 29) with the last writer winning and no error anywhere.
 */
export function normalizeSecrets(v: unknown): SecretsStore | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v;
	if (!("env" in o) || !isEnvRecord(o.env)) return null;
	if (!("files" in o) || !Array.isArray(o.files)) return null;
	const guestPaths = new Set<string>();
	for (const entry of o.files) {
		if (typeof entry !== "object" || entry === null) return null;
		if (!("hostPath" in entry) || !isAbsolutePath(entry.hostPath)) return null;
		if (!("guestPath" in entry) || !isAbsolutePath(entry.guestPath)) return null;
		if (guestPaths.has(entry.guestPath)) return null;
		guestPaths.add(entry.guestPath);
	}
	return { env: o.env, files: o.files };
}

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Serialize env as plain `KEY=value` lines, keys SORTED — deterministic file bytes, so re-saves and diffs are stable. */
function serializeEnv(env: Record<string, string>): string {
	return [...Object.keys(env)]
		.sort()
		.map((key) => `${key}=${env[key]}\n`)
		.join("");
}

/**
 * Parse the `env` file: split on the FIRST `=` (values may contain `=`), skip blank
 * lines (trailing-newline padding). A non-blank line that isn't `KEY=value` under the
 * env grammar — or a hand-edited CR — makes the whole file corrupt → `{}`: the
 * whole-file granularity credentials.ts applies, per half (a mangled `env` never hides
 * `files.json`, which is judged on its own).
 */
function parseEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {};
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		// Unreadable → treat as no env.
		return {};
	}
	const env: Record<string, string> = {};
	for (const line of text.split("\n")) {
		if (line === "") continue;
		if (FORBIDDEN_VALUE_CHARS.test(line)) return {};
		const eq = line.indexOf("=");
		if (eq <= 0) return {}; // no "=" at all, or an empty key
		const key = line.slice(0, eq);
		if (!ENV_KEY_PATTERN.test(key)) return {};
		env[key] = line.slice(eq + 1);
	}
	return env;
}

/**
 * Read both halves of the store. Absent or corrupt (per half) → that half empty; never
 * throws. `files.json` is JSON.parse'd then narrowed through {@link normalizeSecrets}
 * (the single validator — the same rules that gate a save gate a load), with `env: {}`
 * as the fixed-valid half so the file map is judged alone.
 */
export function loadSecrets(dirs: VmDirs): SecretsStore {
	const paths = secretsPaths(dirs);
	let files: SecretFileMapping[] = [];
	if (existsSync(paths.filesPath)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(paths.filesPath, "utf8"));
		} catch {
			parsed = null; // corrupt/unreadable JSON → treat as no file map
		}
		files = normalizeSecrets({ env: {}, files: parsed })?.files ?? [];
	}
	return { env: parseEnvFile(paths.envPath), files };
}

/**
 * The `saveSettings` atomic shape, parameterized: temp file (`mode`) in the same
 * directory, `rename` over the target, then `chmod` the FINAL path so the mode is
 * enforced on every save even if something else left it loose (mkdir/write modes only
 * apply at creation). Throws with a dir/file-scoped message on any failure; the temp is
 * cleaned up on a rename failure so no `.tmp` files linger.
 */
function writeAtomic(path: string, contents: string, mode: 0o600, what: string): void {
	const dir = dirname(path);
	const tmp = join(dir, `${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, contents, { mode });
	} catch (e) {
		throw new Error(`Cannot write ${what} file ${tmp}: ${messageOf(e)}`);
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
		throw new Error(`Cannot persist ${what} file ${path}: ${messageOf(e)}`);
	}
	try {
		chmodSync(path, mode);
	} catch (e) {
		throw new Error(`Cannot secure ${what} file ${path} (mode 0${mode.toString(8)}): ${messageOf(e)}`);
	}
}

/**
 * Persist both halves: ensure the 0700 secrets dir (mkdir + chmod, every save — see the
 * module header for why chmod is repeated and hard-required), then write `env` (plain
 * sorted KEY=value lines) and `files.json`, both 0600 via atomic rename. Throws on any
 * create/write/rename/chmod failure (the throwing persistence boundary).
 */
export function saveSecrets(dirs: VmDirs, store: SecretsStore): void {
	const paths = secretsPaths(dirs);
	try {
		mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
		chmodSync(paths.dir, 0o700);
	} catch (e) {
		throw new Error(`Cannot create/secure secrets directory ${paths.dir}: ${messageOf(e)}`);
	}
	writeAtomic(paths.envPath, serializeEnv(store.env), 0o600, "secrets env");
	writeAtomic(paths.filesPath, `${JSON.stringify(store.files, null, 2)}\n`, 0o600, "secrets file map");
}
