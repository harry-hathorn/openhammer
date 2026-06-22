/**
 * Per-instance bearer token (spec 11).
 *
 * Minted once, persisted at `~/.openhammer/credential.json` (mode 0600), and reused
 * across boots. An `MCP_AUTH_TOKEN` override short-circuits the whole thing and never
 * touches the file.
 *
 * This is a **boot-boundary** function, not a tool: it THROWS on failure (an
 * unwritable credential directory) so `main.ts` can exit non-zero with an actionable
 * message. It therefore uses raw `node:fs` with a wrapping `try/catch` rather than
 * the `tools/io.ts` `Result`-wrappers — those exist to keep tool bodies try/catch-free,
 * and the throwing credential boundary is the single exception. (AGENTS.md: exceptions
 * stay at framework/boot boundaries; `ensureToken` is one.)
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";

/** A minted/loaded credential — the exact shape persisted to `credential.json`. */
export interface Credential {
	token: string;
	/** ISO timestamp of the mint; `""` when overridden via `MCP_AUTH_TOKEN`. */
	createdAt: string;
}

const CREDENTIAL_DIR = ".openhammer";
const CREDENTIAL_FILE = "credential.json";

/**
 * Resolve the credential file path under a home directory (defaults to `os.homedir()`).
 * Exposed so `printStartup` can surface the path + reuse note without re-deriving it.
 */
export function credentialPath(homeDir: string = homedir()): string {
	return join(homeDir, CREDENTIAL_DIR, CREDENTIAL_FILE);
}

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Type guard for a persisted {@link Credential} JSON object. */
function isCredential(v: unknown): v is Credential {
	if (typeof v !== "object" || v === null) return false;
	return "token" in v && typeof v.token === "string" && "createdAt" in v && typeof v.createdAt === "string";
}

/** Read & validate an existing credential file; `undefined` when absent/corrupt/empty-token. */
function readExisting(credPath: string): Credential | undefined {
	if (!existsSync(credPath)) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(credPath, "utf-8"));
	} catch {
		// Corrupt/unreadable credential → mint a fresh one below.
		return undefined;
	}
	if (isCredential(parsed) && parsed.token !== "") return parsed;
	return undefined;
}

/** Mint a fresh credential (43-char base64url token + ISO `createdAt`). */
function mint(): Credential {
	return { token: randomBytes(32).toString("base64url"), createdAt: new Date().toISOString() };
}

/**
 * Persist a credential: `mkdir -p` the parent dir (0700) and write the JSON file
 * (0600). Throws with a clear, dir/file-scoped message when either step fails — the
 * unwritable-dir boot failure surfaced to the operator.
 */
function writeCredential(credPath: string, cred: Credential): void {
	const dir = dirname(credPath);
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch (e) {
		throw new Error(`Cannot create credential directory ${dir}: ${messageOf(e)}`);
	}
	try {
		writeFileSync(credPath, JSON.stringify(cred), { mode: 0o600 });
	} catch (e) {
		throw new Error(`Cannot write credential file ${credPath}: ${messageOf(e)}`);
	}
}

/**
 * Resolve the bearer token for this instance. With `MCP_AUTH_TOKEN` set, return it
 * verbatim (no file I/O). Otherwise reuse a valid persisted credential, or mint +
 * persist a new one at mode 0600. Throws when the credential directory is unwritable.
 */
export async function ensureToken(config: Config, credPath: string = credentialPath()): Promise<Credential> {
	if (config.authToken) {
		return { token: config.authToken, createdAt: "" };
	}
	const existing = readExisting(credPath);
	if (existing) return existing;
	const cred = mint();
	writeCredential(credPath, cred);
	return cred;
}
