/**
 * The tool backend seam (spec 23) — the narrow execution contract every tool will
 * run against: `fs` (Result-wrapped, delegating to `io.ts`), `runShell` (the spawn
 * logic `bash.ts` owns today), `probe`/`probeFlag` (the `rg`/`fd` presence checks
 * `bin.ts`'s `isToolAvailable` and `find.ts`'s `supportsNoRequireGit` own today),
 * `overflowPath` (where tee'd overflow lives), `homedir`, `close`.
 *
 * `LocalBackend` — the default and only implementation until the VM backend
 * (specs 24/25) — delegates to today's code paths so `off`-mode behavior is
 * unchanged; the seam exists so a VM backend can swap the target to a QEMU guest
 * without touching tool bodies. One backend per server process (boot-scoped and
 * threaded, spec 23). This box ships the seam only — no tool consumes it yet.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { homedir as osHomedir, tmpdir } from "node:os";
import { join } from "node:path";
import * as io from "./io.ts";
import { map, type Result } from "./result.ts";

/** The stat surface tools need, decoupled from `node:fs`'s class-shaped `Stats`. */
export interface StatShape {
	isFile: boolean;
	isDir: boolean;
	size: number;
	mtimeMs: number;
}

/** Result-returning filesystem surface (async-only; `io.ts`'s sync variants stay backend-internal). */
export interface FsBackend {
	readFile(path: string): Promise<Result<Buffer>>;
	access(path: string): Promise<Result<void>>; // R_OK
	stat(path: string): Promise<Result<StatShape>>; // { isFile, isDir, size, mtimeMs }
	readdir(path: string): Promise<Result<string[]>>;
	writeFile(path: string, data: Buffer): Promise<Result<void>>;
	mkdir(path: string): Promise<Result<void>>; // -p semantics
	exists(path: string): Promise<Result<boolean>>;
}

/** Outcome of a spawned command. `exitCode: -1` = no exit code (killed by signal / timeout). */
export interface ShellResult {
	exitCode: number;
	timedOut: boolean;
}

export interface ToolBackend {
	kind: "local" | "vm";
	homedir(): string;
	fs: FsBackend;
	runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult>;
	probe(bin: string): boolean;
	probeFlag(bin: string, flag: string): boolean;
	overflowPath(prefix: string): string; // where tee'd overflow lives (host tmpdir | guest path)
	close(): Promise<void>;
}

/** Send SIGKILL to the child's whole process group (best-effort; ignores ESRCH/EPERM). */
function killProcessGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		// `-pid` targets the group; the child is its leader because `detached: true`.
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already reaped (ESRCH) or permission denied — best-effort kill, nothing to do.
	}
}

/** Narrow `node:fs`'s `Stats` to the cross-backend `StatShape`. */
function toStatShape(stats: Stats): StatShape {
	return {
		isFile: stats.isFile(),
		isDir: stats.isDirectory(),
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	};
}

/** The host-local backend: today's `io.ts`/`bash.ts`/`bin.ts` behavior behind the seam. */
export class LocalBackend implements ToolBackend {
	readonly kind: "local" = "local";

	readonly fs: FsBackend = {
		readFile: (path) => io.readFile(path),
		access: (path) => io.access(path, constants.R_OK),
		stat: async (path) => map(await io.stat(path), toStatShape),
		readdir: (path) => io.readdir(path),
		writeFile: (path, data) => io.writeFile(path, data),
		mkdir: (path) => io.mkdir(path, { recursive: true }),
		exists: async (path) => io.exists(path),
	};

	homedir(): string {
		return osHomedir();
	}

	/**
	 * Spawn `$SHELL || "bash"` as `[shell, "-c", cmd]` at `opts.cwd` in its own
	 * process group, streaming merged stdout+stderr (arrival order) through
	 * `opts.onChunk`. The `exit` event (not `close`) resolves — inherited pipe FDs
	 * held by detached grandchildren must not hang us (bash.ts:42). Resolution
	 * contract:
	 *
	 * - Normal exit → `{ exitCode, timedOut: false }`.
	 * - Signal death without a timeout (external kill) → resolves
	 *   `{ exitCode: -1, timedOut: false }`: `exit`'s `code` is `null` and the
	 *   interface promises a `number`, so `-1` is the "no exit code" sentinel.
	 * - Timeout → the whole process group gets SIGKILLed, then this **resolves**
	 *   `{ exitCode: -1, timedOut: true }`. A timeout is an expected operational
	 *   outcome the caller shapes into its own error text (bash.ts: "Command
	 *   timed out after N seconds"), so it resolves rather than rejects.
	 * - Spawn `error` (e.g. the shell binary is missing) → **rejects** with that
	 *   error. Nothing ran — there is no exit code to report and `ShellResult`
	 *   cannot express it — so it stays a genuine-throw path per the Result
	 *   spine, mirroring bash.ts, whose `runShell` likewise rejects spawn errors.
	 */
	runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult> {
		const shell = process.env.SHELL || "bash";
		return new Promise<ShellResult>((resolve, reject) => {
			const child = spawn(shell, ["-c", cmd], {
				cwd: opts.cwd,
				detached: process.platform !== "win32",
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onChunk = opts.onChunk;

			child.stdout?.on("data", (data: Buffer) => {
				if (onChunk) onChunk(data);
			});
			child.stderr?.on("data", (data: Buffer) => {
				if (onChunk) onChunk(data);
			});

			if (opts.timeoutSec !== undefined && opts.timeoutSec > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killProcessGroup(child.pid);
				}, opts.timeoutSec * 1000);
			}

			child.on("error", (error) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				reject(error);
			});

			child.on("exit", (code) => {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (timedOut) {
					resolve({ exitCode: -1, timedOut: true });
					return;
				}
				resolve({ exitCode: code ?? -1, timedOut: false });
			});
		});
	}

	/**
	 * Whether `bin` resolves in `PATH` and runs (`<bin> --version` exits 0) —
	 * verbatim `bin.ts`'s `isToolAvailable` (bin.ts:25-28), which `grep`/`find`
	 * call for `rg`/`fd`. Any spawn error or non-zero status collapses to `false`.
	 * Synchronous on purpose: callers gate the real spawn on it (bin.ts:11-13).
	 */
	probe(bin: string): boolean {
		const result = spawnSync(bin, ["--version"], { stdio: "ignore" });
		return result.status === 0;
	}

	/**
	 * Whether this `bin` build accepts `flag` (`<bin> <flag> --help` exits 0) —
	 * `find.ts`'s `supportsNoRequireGit` (find.ts:44-50), generalized from fd's
	 * `--no-require-git` to any (bin, flag) pair. Deliberately **not cached
	 * here**: find.ts caches at module level today; spec 23 moves that cache into
	 * the backend instance (box 23f), so LocalBackend probes fresh per call and
	 * 23f adds the per-instance cache without changing observable semantics.
	 */
	probeFlag(bin: string, flag: string): boolean {
		const result = spawnSync(bin, [flag, "--help"], { stdio: "ignore" });
		return result.status === 0;
	}

	/**
	 * A fresh unique temp path for tee'd overflow, under the host tmpdir — the
	 * same shape `output-accumulator.ts`'s `defaultTempFilePath` mints (prefix +
	 * 8 random hex bytes + `.log`), so spec 23e can wire the accumulator's temp
	 * file to this without changing the paths it produces today. Creates nothing:
	 * the caller owns creating and cleaning up the file.
	 */
	overflowPath(prefix: string): string {
		const id = randomBytes(8).toString("hex");
		return join(tmpdir(), `${prefix}-${id}.log`);
	}

	async close(): Promise<void> {
		// Local fs/spawns hold no session state — nothing to tear down. (A VM
		// backend shuts its guest down here; spec 25.)
	}
}

/** Construct the host-local backend (factory style, matching `createAllTools`). */
export function createLocalBackend(): LocalBackend {
	return new LocalBackend();
}
