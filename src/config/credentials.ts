/**
 * The secrets store (spec 17e).
 *
 * `~/.openhammer/credentials.json` (mode 0600) holds the secret half of a
 * channel's configuration, keyed by the same `credId` that the settings doc
 * (`config.json`) references. `config.json` stores only a `credId` + non-secret
 * `options`; the secret values themselves (an ngrok authtoken, …) live only here.
 * This mirrors pi's OAuth-credential split: secrets never live inline in the
 * settings doc, so the doc is safe to print/log/share while the secrets stay in
 * this one owner-only file.
 *
 * Shape: `Record<credId, Record<key, string>>` — one string→string bag per credId.
 * `getCredentials` / `setCredentials` / `deleteCredentials` operate per credId.
 *
 * **Boundary posture:** persistence, not a tool execution. `getCredentials` never
 * throws — an absent, unreadable, or structurally corrupt file yields `{}` for the
 * id (a `doctor`-flaggable soft failure, never a boot error); `setCredentials` /
 * `deleteCredentials` THROWS on a write failure with a clear, dir/file-scoped
 * message (the spec-11 `writeCredential` posture, surfaced as actionable stderr by
 * the CLI boundary). All three use raw `node:fs` rather than the `tools/io.ts`
 * `Result`-wrappers — those exist to keep *tool* bodies try/catch-free, and this is
 * the throwing persistence boundary, not a tool (parity with `settings.ts`).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const CREDENTIALS_DIR = ".openhammer";
const CREDENTIALS_FILE = "credentials.json";

/** One credId's secret bag — the value half of the on-disk `Record<credId, …>`. */
export type CredentialValues = Record<string, string>;

/** The on-disk shape: `credId → key → secret-string`. */
type CredentialsMap = Record<string, CredentialValues>;

/** Resolve `~/.openhammer/credentials.json` under a home directory (defaults to `os.homedir()`). */
export function credentialsPath(homeDir: string = homedir()): string {
	return join(homeDir, CREDENTIALS_DIR, CREDENTIALS_FILE);
}

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** A plain object whose own values are all strings (a secret bag). */
function isStringRecord(v: unknown): v is Record<string, string> {
	if (typeof v !== "object" || v === null) return false;
	for (const value of Object.values(v)) {
		if (typeof value !== "string") return false;
	}
	return true;
}

/**
 * Type guard for a full credentials map. A plain object (not an array) whose every
 * value is a string bag. Whole-file granularity — a single malformed entry means
 * the file is corrupt (a `doctor`-flagged soft failure), so the secrets are treated
 * as absent rather than partially trusted.
 */
function isCredentialsMap(v: unknown): v is CredentialsMap {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	for (const val of Object.values(v)) {
		if (!isStringRecord(val)) return false;
	}
	return true;
}

/**
 * Read & validate the secrets file. Absent, unreadable, or structurally corrupt
 * (won't parse, isn't a plain object, or any entry isn't a string bag) → `{}`.
 * Never throws — a corrupt file is a `doctor`-flagged soft failure, never a boot error.
 */
function readCredentialsMap(path: string): CredentialsMap {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		// Corrupt/unreadable JSON → treat as no credentials.
		return {};
	}
	return isCredentialsMap(parsed) ? parsed : {};
}

/**
 * Atomically persist the secrets map: `mkdir -p` the dir (`0700`), write a temp file
 * (`0600`) in the same directory, then `rename` it over the target. `rename` is
 * atomic on a single filesystem, so a crash mid-write can never leave a truncated
 * `credentials.json` — the target is either the previous map or the new one, never a
 * partial write (the spec-11 hygiene, made crash-safe — parity with `saveSettings`).
 * Throws with a clear, dir/file-scoped message when the dir cannot be created, the
 * temp cannot be written, or the rename fails; the temp is cleaned up on a rename
 * failure so no `.tmp` files linger.
 */
function writeCredentialsFile(path: string, map: CredentialsMap): void {
	const dir = dirname(path);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		throw new Error(`Cannot create credentials directory ${dir}: ${messageOf(e)}`);
	}
	const tmp = join(dir, `${basename(path)}.${process.pid}.tmp`);
	try {
		writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`, { mode: 0o600 });
	} catch (e) {
		throw new Error(`Cannot write credentials file ${tmp}: ${messageOf(e)}`);
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
		throw new Error(`Cannot persist credentials file ${path}: ${messageOf(e)}`);
	}
}

/**
 * Read one credId's secret bag. Returns `{}` when the id is absent or the file is
 * missing/corrupt — never throws. A provider reading its secrets (e.g. the ngrok
 * authtoken) therefore gets a clean `Record<string,string>` and checks the key it
 * cares about: `getCredentials(id).authtoken` is `undefined` until set.
 */
export function getCredentials(id: string, path: string = credentialsPath()): CredentialValues {
	const map = readCredentialsMap(path);
	return Object.hasOwn(map, id) ? map[id] : {};
}

/**
 * Persist (merge) a credId's secret values. Existing keys for the id are preserved
 * and the given values overwrite matching keys (merge, not wholesale replace) — so
 * rotating one secret never drops the others. The whole map is written atomically.
 * Throws on a write failure (the throwing persistence boundary).
 */
export function setCredentials(id: string, values: CredentialValues, path: string = credentialsPath()): void {
	const map = readCredentialsMap(path);
	const prev = Object.hasOwn(map, id) ? map[id] : {};
	map[id] = { ...prev, ...values };
	writeCredentialsFile(path, map);
}

/**
 * Remove a credId's secret bag. Idempotent — a no-op (no file touch) when the id is
 * absent, so cascading a channel removal that never had secrets is safe. When the id
 * is present the whole map is rewritten atomically; deleting the last entry leaves an
 * empty `{}` file. Throws on a write failure (the throwing persistence boundary).
 */
export function deleteCredentials(id: string, path: string = credentialsPath()): void {
	const map = readCredentialsMap(path);
	if (!Object.hasOwn(map, id)) return;
	delete map[id];
	writeCredentialsFile(path, map);
}
