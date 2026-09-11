/**
 * FakeBackend — the scripted, spawn-free `ToolBackend` for Tier-0 tool tests
 * (spec 23): an in-memory filesystem plus a programmable shell, so tool shaping
 * (truncate caps, error text, command construction) is testable with zero host
 * access and zero process spawns.
 *
 * Placement note (a deliberate deviation from spec 23's "src/tools/backend.test.ts
 * fixtures" wording): vitest re-registers an imported test file's whole suite
 * inside the importer — a scratch file containing nothing but
 * `import "./backend.test.ts"` runs all 22 LocalBackend tests. Exporting the
 * fixture from there would re-run LocalBackend's real spawns inside every tool
 * test that imports it, defeating the fixture's purpose, so it lives in this
 * standalone module instead. Cost: `tsc` compiles it into `dist/` (only
 * `*.test.ts` is build-excluded), so it ships in the npm tarball as dead code —
 * nothing imports it in production. A build-tsconfig exclude for `*.fake.ts`
 * files would drop it if that ever matters.
 *
 * Fidelity rules (the fake errs where the real fs errs, with the real errno
 * codes and message shapes, so error-path tests stay honest):
 *
 * - `writeFile` is strict about parents: missing parent → `ENOENT … open`,
 *   parent exists as a file → `ENOTDIR … open`, target is a directory →
 *   `EISDIR … open` (verbatim `node:fs` messages). Runtime writes never create
 *   implicit directories.
 * - `failWritesFor` seeds simulate write-permission denial (the in-memory fs has
 *   no real permission bits): those paths' `writeFile` errs `EACCES … open`.
 * - Seeded files are trusted world-building sugar: they auto-`mkdir -p` their
 *   ancestor dirs, so `fakeBackend({ files: { "/work/a/b.txt": "…" } })` reads
 *   as "this tree exists".
 * - `mkdir` is always ok and registers the whole ancestor chain (`-p`
 *   semantics, spec 23). (Real `mkdir -p` over an existing *file* errs
 *   `EEXIST`; the fake stays permissive — no tool flow mkdirs over files.)
 * - `readdir` of a file → `ENOTDIR … scandir`; of a missing path →
 *   `ENOENT … scandir`; hits return the direct entry names, sorted.
 * - `readFile` of a directory → `EISDIR: illegal operation on a directory,
 *   read` (the real message carries no path). Reads return a copy and writes
 *   store a copy — mutating a Buffer on either side cannot rewrite history.
 * - `runShell` never spawns and runs no timer: responses come from the
 *   consumed script (timeouts included), `opts` are recorded for assertions,
 *   and an unscripted command resolves `127` plus a loud `unexpectedCalls`
 *   entry. `runArgv` shares that script and those rules, with streams split
 *   per its own contract (`argvCalls` records the exact bin/args pair).
 */

import { basename, dirname } from "node:path";
import type { FsBackend, ShellResult, StatShape, ToolBackend } from "./backend.ts";
import { err, ok } from "./result.ts";

/** Real `node:fs` errno message fragments, matched so error-path assertions see LocalBackend's shapes. */
const ERRNO_MESSAGES = {
	ENOENT: "no such file or directory",
	EACCES: "permission denied",
	ENOTDIR: "not a directory",
	EISDIR: "illegal operation on a directory",
} as const;

type ErrnoCode = keyof typeof ERRNO_MESSAGES;

/**
 * An errno-shaped plain `Error`: real message format plus a `.code` property, so
 * fake `err` results are indistinguishable from `io.ts`-wrapped real ones (the
 * repo throws no custom error classes — the code is assigned, not subclassed).
 */
function errnoError(code: ErrnoCode, detail: string): Error {
	const error: NodeJS.ErrnoException = new Error(`${code}: ${ERRNO_MESSAGES[code]}, ${detail}`);
	error.code = code;
	return error;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Deterministically split `text` into 1–3 contiguous chunks (empty → none):
 * short outputs stay whole; longer ones split so accumulator/tee paths see
 * multi-chunk arrival without any randomness.
 */
function splitChunks(text: string): string[] {
	if (text.length === 0) return [];
	const count = Math.min(3, Math.ceil(text.length / 4));
	const size = Math.ceil(text.length / count);
	const chunks: string[] = [];
	for (let start = 0; start < text.length; start += size) {
		chunks.push(text.slice(start, start + size));
	}
	return chunks;
}

/**
 * One scripted shell response. The first *unconsumed* entry whose `match` tests
 * against the command is consumed by that call. The matching key is a command
 * string: `runShell` tests against `cmd` verbatim; `runArgv` tests against the
 * joined form `` `${bin} ${args.join(" ")}` `` — a lossless rendering for the
 * flag-shaped argvs the tools build (no argument ever contains a space in a
 * scripted test; assert exact argvs via the recorded `argvCalls` instead).
 */
export interface ShellScriptEntry {
	/** String → substring test (`cmd.includes`); RegExp → `.test(cmd)`. */
	match: string | RegExp;
	result: { exitCode: number; timedOut?: boolean };
	stdout?: string;
	stderr?: string;
	/** When set, stdout then stderr are emitted as 1–3 chunks each, spaced by this delay (exercises chunk-accumulating callers); otherwise each non-empty stream is one immediate chunk. */
	chunkDelayMs?: number;
}

/** A recorded `runShell` call — assert exact command construction. */
export interface ShellCall {
	cmd: string;
	cwd: string;
	timeoutSec?: number;
}

/**
 * A recorded `runArgv` call — `ShellCall`'s shape (with `cwd` optional:
 * `runArgv`'s argv carries the absolute search path, so the argv tools pass no
 * cwd today) plus the exact `bin`/`args` pair; arg-array hygiene is the point
 * of `runArgv`, so the split form is recorded verbatim, and `cmd` carries the
 * joined form the script matched.
 */
export interface ArgvCall {
	bin: string;
	args: string[];
	cmd: string;
	cwd?: string;
	timeoutSec?: number;
}

/** Seed state for `fakeBackend(...)`. Seeded files auto-register their ancestor dirs; runtime writes stay strict. */
export interface FakeBackendSeed {
	files?: Record<string, string | Buffer>;
	dirs?: string[];
	script?: ShellScriptEntry[];
	probeResults?: Record<string, boolean>;
	/** Keyed `"<bin> <flag>"`. */
	probeFlagResults?: Record<string, boolean>;
	/** Paths whose `writeFile` errs `EACCES` — write-permission denial (no real permission bits to clear). */
	failWritesFor?: string[];
	homedir?: string;
	/**
	 * The reported `ToolBackend.kind` (spec 27's kind seam). Defaults to
	 * `"local"`; the fake always *behaves* locally — nothing here runs a guest —
	 * so this only relabels `backend.kind` for tools that legitimately branch on
	 * it (guide's vm variant), letting their tests express the mode without a
	 * real sandbox.
	 */
	kind?: ToolBackend["kind"];
}

/** The scripted, spawn-free backend (see the module comment for fidelity rules). */
export class FakeBackend implements ToolBackend {
	// `kind` defaults to "local" (the fake imitates the local backend's shape and
	// always behaves locally); the seed may relabel it "vm" (spec 27) for the one
	// tool that legitimately branches on kind — guide's vm variant. Spec 23's
	// "tools don't branch on kind" rule now has exactly one sanctioned exception.
	readonly kind: ToolBackend["kind"];

	private readonly files = new Map<string, Buffer>();
	private readonly fileMtimes = new Map<string, number>();
	private readonly dirs = new Set<string>();
	private readonly script: ShellScriptEntry[];
	private readonly probeTable: Record<string, boolean>;
	private readonly probeFlagTable: Record<string, boolean>;
	private readonly failWritesFor: Set<string>;
	private readonly fakeHome: string;
	private overflowCount = 0;
	private isClosed = false;

	/** Every `runShell` call, in order — assert exact command construction. */
	readonly calls: ShellCall[] = [];
	/** Every `runArgv` call, in order — assert exact bin/argv construction. */
	readonly argvCalls: ArgvCall[] = [];
	/** Commands (or joined argvs) that matched no script entry — a missing script must be loud in test failures. */
	readonly unexpectedCalls: string[] = [];
	/** Every `probe(bin)` call, in order. */
	readonly probeCalls: string[] = [];
	/** Every `probeFlag(bin, flag)` call, in order. */
	readonly probeFlagCalls: Array<{ bin: string; flag: string }> = [];

	constructor(seed: FakeBackendSeed = {}) {
		this.kind = seed.kind ?? "local";
		this.script = [...(seed.script ?? [])];
		this.probeTable = seed.probeResults ?? {};
		this.probeFlagTable = seed.probeFlagResults ?? {};
		this.failWritesFor = new Set(seed.failWritesFor ?? []);
		this.fakeHome = seed.homedir ?? "/home/fake";
		for (const [path, data] of Object.entries(seed.files ?? {})) {
			this.registerDirChain(dirname(path));
			this.files.set(path, Buffer.from(data));
			this.fileMtimes.set(path, Date.now());
		}
		for (const dir of seed.dirs ?? []) {
			this.registerDirChain(dir);
		}
	}

	/** Register `path` and every ancestor as a directory (`mkdir -p` semantics). */
	private registerDirChain(path: string): void {
		let current = path;
		while (!this.dirs.has(current)) {
			this.dirs.add(current);
			this.fileMtimes.set(current, Date.now());
			const parent = dirname(current);
			if (parent === current) break; // reached "/" or "."
			current = parent;
		}
	}

	readonly fs: FsBackend = {
		readFile: async (path) => {
			const file = this.files.get(path);
			if (file !== undefined) return ok(Buffer.from(file)); // copy out
			if (this.dirs.has(path)) return err(errnoError("EISDIR", "read"));
			return err(errnoError("ENOENT", `open '${path}'`));
		},
		access: async (path) => {
			if (this.files.has(path) || this.dirs.has(path)) return ok(undefined);
			return err(errnoError("ENOENT", `access '${path}'`));
		},
		stat: async (path) => {
			const file = this.files.get(path);
			if (file !== undefined) {
				return ok({
					isFile: true,
					isDir: false,
					size: file.length,
					mtimeMs: this.fileMtimes.get(path) ?? 0,
				} satisfies StatShape);
			}
			if (this.dirs.has(path)) {
				return ok({
					isFile: false,
					isDir: true,
					size: 0,
					mtimeMs: this.fileMtimes.get(path) ?? 0,
				} satisfies StatShape);
			}
			return err(errnoError("ENOENT", `stat '${path}'`));
		},
		readdir: async (path) => {
			if (this.files.has(path)) return err(errnoError("ENOTDIR", `scandir '${path}'`));
			if (!this.dirs.has(path)) return err(errnoError("ENOENT", `scandir '${path}'`));
			const entries = new Set<string>();
			for (const file of this.files.keys()) {
				if (dirname(file) === path) entries.add(basename(file));
			}
			for (const dir of this.dirs) {
				if (dirname(dir) === path && dir !== path) entries.add(basename(dir));
			}
			return ok([...entries].sort());
		},
		writeFile: async (path, data) => {
			if (this.failWritesFor.has(path)) return err(errnoError("EACCES", `open '${path}'`));
			if (this.dirs.has(path)) return err(errnoError("EISDIR", `open '${path}'`));
			const parent = dirname(path);
			if (this.files.has(parent)) return err(errnoError("ENOTDIR", `open '${path}'`));
			if (!this.dirs.has(parent)) return err(errnoError("ENOENT", `open '${path}'`));
			this.files.set(path, Buffer.from(data)); // copy in
			this.fileMtimes.set(path, Date.now());
			return ok(undefined);
		},
		mkdir: async (path) => {
			this.registerDirChain(path);
			return ok(undefined);
		},
		exists: async (path) => ok(this.files.has(path) || this.dirs.has(path)),
	};

	homedir(): string {
		return this.fakeHome;
	}

	/**
	 * Consult the script: the first unconsumed entry whose `match` tests against
	 * `cmd` is consumed (spent) and answers this call — stdout then stderr flow
	 * through `onChunk` (chunked + delayed only when `chunkDelayMs` is set), and
	 * the entry's `result` resolves verbatim (timeouts included — no real timer
	 * runs). An unscripted command resolves `{ exitCode: 127, timedOut: false }`
	 * with a `fake-backend: no script for: <cmd>` stderr chunk, and is recorded
	 * in `unexpectedCalls` so the omission fails loudly.
	 */
	async runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult> {
		this.calls.push({ cmd, cwd: opts.cwd, timeoutSec: opts.timeoutSec });
		const index = this.script.findIndex((entry) =>
			typeof entry.match === "string" ? cmd.includes(entry.match) : entry.match.test(cmd),
		);
		if (index === -1) {
			this.unexpectedCalls.push(cmd);
			opts.onChunk?.(Buffer.from(`fake-backend: no script for: ${cmd}`));
			return { exitCode: 127, timedOut: false };
		}
		const [entry] = this.script.splice(index, 1);
		const out = entry.stdout ?? "";
		const errorOut = entry.stderr ?? "";
		const onChunk = opts.onChunk;
		if (onChunk) {
			if (entry.chunkDelayMs === undefined) {
				if (out !== "") onChunk(Buffer.from(out));
				if (errorOut !== "") onChunk(Buffer.from(errorOut));
			} else {
				const pieces = [...splitChunks(out), ...splitChunks(errorOut)];
				for (const [i, piece] of pieces.entries()) {
					if (i > 0) await sleep(entry.chunkDelayMs);
					onChunk(Buffer.from(piece));
				}
			}
		}
		return { exitCode: entry.result.exitCode, timedOut: entry.result.timedOut ?? false };
	}

	/**
	 * The `runArgv` twin of `runShell`: same shared script, same consumption and
	 * emission rules (stdout then stderr, `chunkDelayMs` splits each stream into
	 * 1–3 delayed chunks), same 127 + `unexpectedCalls` for an unscripted call —
	 * but the streams stay **split** (`onStdout`/`onStderr`, never interleaved)
	 * and the call is recorded in `argvCalls` with the exact `bin`/`args` pair.
	 * `signal` is accepted and ignored: there is no child to kill, so an aborting
	 * caller (grep's match cap) simply gets the scripted result after emission —
	 * the abort side of the contract is LocalBackend's to prove.
	 */
	async runArgv(
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
		const cmd = `${bin} ${args.join(" ")}`;
		this.argvCalls.push({ cmd, bin, args: [...args], cwd: opts.cwd, timeoutSec: opts.timeoutSec });
		const index = this.script.findIndex((entry) =>
			typeof entry.match === "string" ? cmd.includes(entry.match) : entry.match.test(cmd),
		);
		if (index === -1) {
			this.unexpectedCalls.push(cmd);
			opts.onStderr?.(Buffer.from(`fake-backend: no script for: ${cmd}`));
			return { exitCode: 127, timedOut: false };
		}
		const [entry] = this.script.splice(index, 1);
		const out = entry.stdout ?? "";
		const errorOut = entry.stderr ?? "";
		if (entry.chunkDelayMs === undefined) {
			if (out !== "") opts.onStdout?.(Buffer.from(out));
			if (errorOut !== "") opts.onStderr?.(Buffer.from(errorOut));
		} else {
			// Split streams split separately: all stdout chunks, then all stderr
			// chunks (never interleaved — the defining difference from runShell).
			for (const [i, piece] of splitChunks(out).entries()) {
				if (i > 0) await sleep(entry.chunkDelayMs);
				opts.onStdout?.(Buffer.from(piece));
			}
			for (const [i, piece] of splitChunks(errorOut).entries()) {
				if (i > 0) await sleep(entry.chunkDelayMs);
				opts.onStderr?.(Buffer.from(piece));
			}
		}
		return { exitCode: entry.result.exitCode, timedOut: entry.result.timedOut ?? false };
	}

	/** Scripted: `probeResults[bin]`, defaulting false — the fake never spawns, so unscripted means "absent". */
	probe(bin: string): boolean {
		this.probeCalls.push(bin);
		return this.probeTable[bin] ?? false;
	}

	/** Scripted: `probeFlagResults["<bin> <flag>"]`, defaulting false. */
	probeFlag(bin: string, flag: string): boolean {
		this.probeFlagCalls.push({ bin, flag });
		return this.probeFlagTable[`${bin} ${flag}`] ?? false;
	}

	/**
	 * Deterministic counter-based path — no randomness, so tests assert exact
	 * paths. One counter per instance (shared across prefixes → unique).
	 */
	overflowPath(prefix: string): string {
		this.overflowCount += 1;
		return `/tmp/fake/${prefix}-${this.overflowCount}.log`;
	}

	async close(): Promise<void> {
		this.isClosed = true;
	}

	/** Whether `close()` has run — assert teardown. */
	get closed(): boolean {
		return this.isClosed;
	}
}

/** Construct the scripted fake (factory style, matching `createLocalBackend`). */
export function fakeBackend(seed?: FakeBackendSeed): FakeBackend {
	return new FakeBackend(seed);
}
