/**
 * The tool backend seam (spec 23) — the narrow execution contract every tool
 * runs against: `fs` (Result-wrapped, delegating to `io.ts`), `runShell` (the
 * shell-string spawn for `bash`), `runArgv` (the argument-array spawn for
 * `grep`/`find`, whose user-controlled patterns must never ride a shell
 * string), `probe`/`probeFlag` (the `rg`/`fd` presence checks `bin.ts`'s
 * `isToolAvailable` and `find.ts`'s old `supportsNoRequireGit` own), plus
 * `overflowPath`, `homedir`, `close`.
 *
 * `LocalBackend` — the default and only implementation until the VM backend
 * (specs 24/25) — delegates to today's code paths so `off`-mode behavior is
 * unchanged; the seam exists so a VM backend can swap the target to a QEMU
 * guest without touching tool bodies. One backend per server process
 * (boot-scoped and threaded, spec 23).
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
	/**
	 * Informational mode label: `"local"` (the host backend), `"vm"` (a VM-mode
	 * boot's guest session), `"agent"` (agent mode — spec 29: the same vm-shaped
	 * guest session with the inner agent running; behavior is identical). Tools
	 * must not branch on it — the one sanctioned exception is `guide`'s variant
	 * switch.
	 */
	kind: "local" | "vm" | "agent";
	homedir(): string;
	fs: FsBackend;
	runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult>;
	/**
	 * Spawn `bin` with an **argument array** — `runShell`'s argv twin, for tools
	 * whose user-controlled operands must never ride a shell string (`rg`/`fd`;
	 * spawn hygiene — `runShell` stays the `bash` tool's sanctioned exception).
	 * Streams stay split: `onStdout`/`onStderr` receive their own pipe's chunks
	 * (NDJSON parsing needs stdout alone; stderr is collected separately for
	 * error messages). Resolution contract mirrors `runShell` — resolves
	 * `{ exitCode, timedOut }`, rejects only on spawn `error` — with one
	 * addition: aborting `opts.signal` stops the child early (grep's match-cap
	 * kill) and resolves `{ exitCode: -1, timedOut: false }` — **aborted is not
	 * timed out**; callers map it per their own semantics (grep treats it as the
	 * limit-kill success). A future VM backend (spec 25) implements this with
	 * per-argument ssh quoting verified by hostile-input round-trips — which is
	 * exactly why `rg`/`fd` go through `runArgv`, never `runShell`.
	 */
	runArgv(
		bin: string,
		args: readonly string[],
		opts: {
			cwd?: string;
			timeoutSec?: number;
			signal?: AbortSignal; // abort = stop the child early (grep's match-cap kill)
			onStdout?: (b: Buffer) => void; // split streams (NDJSON parsing needs stdout alone)
			onStderr?: (b: Buffer) => void; // collected separately for error messages
		},
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

	/**
	 * Per-instance probe results (spec 23): `probe` keys are the bare bin,
	 * `probeFlag` keys are `"<bin> <flag>"` (a bin name can never contain a
	 * space+flag shape, so the keyspaces cannot collide). Absorbs both of the
	 * old module-level caches' jobs — `find.ts`'s `supportsNoRequireGit` memo and
	 * the repeat `isToolAvailable` spawns every grep/find execute paid — with
	 * observable semantics unchanged within a process (one backend per process,
	 * boot-scoped; a `PATH` that changes mid-process is not a supported state).
	 */
	private readonly probeCache = new Map<string, boolean>();

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
	 * Spawn `bin` with an argument array and split streams — the generalized
	 * lift of `grep.ts`/`find.ts`'s old private spawns (same `stdio` shape, same
	 * per-stream collection; `rg`/`fd` get their absolute search path in args, so
	 * `cwd` is optional and the argv tools pass none today). Resolution contract
	 * per the interface docs, with one deliberate divergence from `runShell`:
	 * the **`close`** event (not `exit`) settles the promise. `runShell` resolves
	 * on `exit` because a shell's detached grandchildren can hold the inherited
	 * pipe FDs open and hang `close` (bash.ts:42) — but `runArgv`'s callers spawn
	 * no children of their own (rg/fd) *and* parse the streams themselves, so
	 * resolving at `exit` would race the pipe drain: stdout bytes still buffered
	 * when the process died would be missed (dropped trailing NDJSON matches).
	 * `close` fires only after both pipes have flushed, guaranteeing every
	 * `onStdout`/`onStderr` callback has run before resolution — the same event
	 * today's grep/find spawns resolve on.
	 *
	 * - Normal exit → `{ exitCode, timedOut: false }` (`code ?? -1` for signal death).
	 * - `opts.signal` abort → the whole process group gets SIGKILLed, then this
	 *   **resolves** `{ exitCode: -1, timedOut: false }` — aborted is not timed
	 *   out; grep maps this onto its old killed-at-the-limit success.
	 * - Timeout → the same group SIGKILL, resolving `{ exitCode: -1, timedOut: true }`.
	 * - Spawn `error` (binary missing) → **rejects** with that error, the one
	 *   genuine-throw path (grep/find narrow it to their `Failed to run …` err).
	 */
	runArgv(
		bin: string,
		args: readonly string[],
		opts: {
			cwd?: string;
			timeoutSec?: number;
			signal?: AbortSignal;
			onStdout?: (b: Buffer) => void;
			onStderr?: (b: Buffer) => void;
		},
	): Promise<ShellResult> {
		return new Promise<ShellResult>((resolve, reject) => {
			const child = spawn(bin, args, {
				cwd: opts.cwd,
				detached: process.platform !== "win32",
				env: process.env,
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			let timedOut = false;
			let aborted = false;
			let settled = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onStdout = opts.onStdout;
			const onStderr = opts.onStderr;

			child.stdout?.on("data", (data: Buffer) => {
				if (onStdout) onStdout(data);
			});
			child.stderr?.on("data", (data: Buffer) => {
				if (onStderr) onStderr(data);
			});

			const signal = opts.signal;
			const onAbort = (): void => {
				aborted = true;
				killProcessGroup(child.pid);
			};
			if (signal) {
				if (signal.aborted) {
					aborted = true;
					killProcessGroup(child.pid);
				} else {
					signal.addEventListener("abort", onAbort, { once: true });
				}
			}

			if (opts.timeoutSec !== undefined && opts.timeoutSec > 0) {
				timeoutHandle = setTimeout(() => {
					timedOut = true;
					killProcessGroup(child.pid);
				}, opts.timeoutSec * 1000);
			}

			// `close` also fires after a spawn `error` (streams still open) — the
			// settled guard keeps the rejection authoritative, mirroring today's
			// grep/find spawn lifecycles.
			const settle = (finish: () => void): void => {
				if (settled) return;
				settled = true;
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
				finish();
			};

			child.on("error", (error) => {
				settle(() => reject(error));
			});

			child.on("close", (code) => {
				settle(() => {
					if (timedOut) {
						resolve({ exitCode: -1, timedOut: true });
						return;
					}
					if (aborted) {
						resolve({ exitCode: -1, timedOut: false });
						return;
					}
					resolve({ exitCode: code ?? -1, timedOut: false });
				});
			});
		});
	}

	/**
	 * Whether `bin` resolves in `PATH` and runs (`<bin> --version` exits 0) —
	 * verbatim `bin.ts`'s `isToolAvailable` (bin.ts:25-28), which `grep`/`find`
	 * call for `rg`/`fd`. Any spawn error or non-zero status collapses to `false`.
	 * Synchronous on purpose: callers gate the real spawn on it (bin.ts:11-13).
	 * Results are cached per instance (see `probeCache`).
	 */
	probe(bin: string): boolean {
		const cached = this.probeCache.get(bin);
		if (cached !== undefined) return cached;
		const result = spawnSync(bin, ["--version"], { stdio: "ignore" });
		const supported = result.status === 0;
		this.probeCache.set(bin, supported);
		return supported;
	}

	/**
	 * Whether this `bin` build accepts `flag` (`<bin> <flag> --help` exits 0) —
	 * `find.ts`'s old `supportsNoRequireGit` (a module-level cache + identical
	 * `spawnSync`), generalized from fd's `--no-require-git` to any (bin, flag)
	 * pair and moved into the instance (spec 23): observable semantics are
	 * unchanged within a process (one backend per process, one probe per
	 * (bin, flag) instead of one per module).
	 */
	probeFlag(bin: string, flag: string): boolean {
		const key = `${bin} ${flag}`;
		const cached = this.probeCache.get(key);
		if (cached !== undefined) return cached;
		const result = spawnSync(bin, [flag, "--help"], { stdio: "ignore" });
		const supported = result.status === 0;
		this.probeCache.set(key, supported);
		return supported;
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
