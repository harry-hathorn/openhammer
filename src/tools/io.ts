/**
 * Result-returning wrappers over `node:fs` / `node:fs/promises`.
 *
 * The fs surface throws (`ENOENT`, `EACCES`, `EISDIR`, …); the tool layer never
 * wants those thrown across its boundary. Each wrapper converts a throwing call
 * into a `Result` — `try { return ok(await fs.x(...)) } catch (e) { return err(asError(e)) }`
 * — so tool bodies compose fallible steps with `andThen`/`map` and contain
 * **zero try/catch**. The MCP `CallTool` handler is the single point that
 * narrows an `err` into an `isError` response (see `src/mcp/server.ts`).
 *
 * Scope is the **filesystem only**. Spawn-based tools (`bash`/`grep`/`find`/
 * tunnel) do not use this module — each owns its streaming spawn and returns a
 * `Result` at the end. `readFile` returns a raw `Buffer` (no encoding): callers
 * that want text call `.toString("utf-8")` themselves, mirroring pi's `read`/
 * `edit` tools.
 */

import {
	existsSync,
	readdirSync as fsReaddirSync,
	statSync as fsStatSync,
	type MakeDirectoryOptions,
	type Stats,
	type WriteFileOptions,
} from "node:fs";
import {
	access as fsAccess,
	mkdir as fsMkdir,
	readdir as fsReaddir,
	readFile as fsReadFile,
	stat as fsStat,
	writeFile as fsWriteFile,
} from "node:fs/promises";
import { err, ok, type Result } from "./result.ts";

/** Narrow an unknown `catch` value to a plain `Error` (fs throws `ErrnoException`, an `Error`). */
function asError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

/** Read a file as a raw `Buffer` (no encoding). */
export async function readFile(path: string): Promise<Result<Buffer>> {
	try {
		return ok(await fsReadFile(path));
	} catch (e) {
		return err(asError(e));
	}
}

/** Check a file's accessibility (`mode` defaults to `F_OK` = existence). */
export async function access(path: string, mode?: number): Promise<Result<void>> {
	try {
		await fsAccess(path, mode);
		return ok(undefined);
	} catch (e) {
		return err(asError(e));
	}
}

/** Async `stat`. */
export async function stat(path: string): Promise<Result<Stats>> {
	try {
		return ok(await fsStat(path));
	} catch (e) {
		return err(asError(e));
	}
}

/** Sync `stat`. */
export function statSync(path: string): Result<Stats> {
	try {
		return ok(fsStatSync(path));
	} catch (e) {
		return err(asError(e));
	}
}

/** Read a directory's entry names as `string[]` (UTF-8, `withFileTypes:false`). */
export async function readdir(path: string): Promise<Result<string[]>> {
	try {
		return ok(await fsReaddir(path));
	} catch (e) {
		return err(asError(e));
	}
}

/** Sync `readdir` → entry names as `string[]`. */
export function readdirSync(path: string): Result<string[]> {
	try {
		return ok(fsReaddirSync(path));
	} catch (e) {
		return err(asError(e));
	}
}

/** Write `data` (UTF-8 string or `Buffer`) to `path`. */
export async function writeFile(path: string, data: string | Buffer, opts?: WriteFileOptions): Promise<Result<void>> {
	try {
		await fsWriteFile(path, data, opts);
		return ok(undefined);
	} catch (e) {
		return err(asError(e));
	}
}

/** Create a directory (pass `{ recursive: true }` for parents). */
export async function mkdir(path: string, opts?: MakeDirectoryOptions): Promise<Result<void>> {
	try {
		await fsMkdir(path, opts);
		return ok(undefined);
	} catch (e) {
		return err(asError(e));
	}
}

/** `existsSync` as a `Result` (rarely throws for string paths, but uniform with the rest). */
export function exists(path: string): Result<boolean> {
	try {
		return ok(existsSync(path));
	} catch (e) {
		return err(asError(e));
	}
}
