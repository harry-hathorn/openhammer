import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createLocalBackend, type LocalBackend } from "./backend.ts";
import type { Result } from "./result.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Linux /proc state for a pid: `null` if gone, else the state char (e.g. "R", "S",
 * "Z"). Used to tell a *live* orphan (R/S) from a reaped/zombie process (Z/gone) —
 * `process.kill(pid, 0)` reports zombies as alive, so it can't make that distinction.
 */
function processState(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		// `comm` may contain spaces/parens; the state char follows the last ")".
		const closeParen = stat.lastIndexOf(")");
		return stat.slice(closeParen + 2, closeParen + 3);
	} catch {
		return null;
	}
}

/** Assert a `Result` is an `err` carrying an `Error`, optionally with a specific errno `code`. */
function expectErr<T>(r: Result<T>, code?: string): void {
	if (r.ok) {
		throw new Error(`expected err, got ok with value ${JSON.stringify(r.value)}`);
	}
	expect(r.error).toBeInstanceOf(Error);
	if (code !== undefined) {
		expect((r.error as NodeJS.ErrnoException).code).toBe(code);
	}
}

// LocalBackend is the host-real backend, so these tests hit the real filesystem
// (throwaway tmpdir) and spawn real processes — this is spec 23's acceptance test
// that runShell matches today's bash semantics. A FakeBackend (23f/later) makes
// the tool-layer shaping tests spawn-free.
describe("LocalBackend", () => {
	let backend: LocalBackend;
	let dir: string;

	beforeEach(() => {
		backend = createLocalBackend();
		dir = mkdtempSync(join(tmpdir(), "openhammer-backend-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("identity & lifecycle", () => {
		test("kind is 'local', homedir matches os.homedir, close resolves", async () => {
			expect(backend.kind).toBe("local");
			expect(backend.homedir()).toBe(homedir());
			await expect(backend.close()).resolves.toBeUndefined();
		}, 15000);

		test("overflowPath returns a fresh unique path under the host tmpdir, honoring the prefix", () => {
			const a = backend.overflowPath("openhammer");
			const b = backend.overflowPath("openhammer");
			expect(a).not.toBe(b);
			expect(a.startsWith(join(tmpdir(), "openhammer-"))).toBe(true);
			expect(a.endsWith(".log")).toBe(true); // same shape as output-accumulator's temp files
			// Side-effect-light: minting the path must create nothing.
			expect(existsSync(a)).toBe(false);
			expect(existsSync(b)).toBe(false);
		});
	});

	describe("fs", () => {
		test("writeFile → readFile round-trips the exact Buffer", async () => {
			const p = join(dir, "hello.bin");
			const w = await backend.fs.writeFile(p, Buffer.from("hello world"));
			expect(w).toEqual({ ok: true, value: undefined });
			const r = await backend.fs.readFile(p);
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(Buffer.isBuffer(r.value)).toBe(true);
			expect(r.value.toString("utf-8")).toBe("hello world");
		});

		test("readFile of a missing path returns err (ENOENT), never throws", async () => {
			const r = await backend.fs.readFile(join(dir, "nope.txt"));
			expectErr(r, "ENOENT");
		});

		test("stat maps a file's Stats to StatShape", async () => {
			const p = join(dir, "f.txt");
			await backend.fs.writeFile(p, Buffer.from("12345"));
			const r = await backend.fs.stat(p);
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.isFile).toBe(true);
			expect(r.value.isDir).toBe(false);
			expect(r.value.size).toBe(5);
			expect(r.value.mtimeMs).toBeGreaterThan(0);
		});

		test("stat maps a directory's Stats to StatShape", async () => {
			const r = await backend.fs.stat(dir);
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.isFile).toBe(false);
			expect(r.value.isDir).toBe(true);
		});

		test("stat of a missing path returns err (ENOENT)", async () => {
			const r = await backend.fs.stat(join(dir, "nope"));
			expectErr(r, "ENOENT");
		});

		test("mkdir creates nested parents (-p semantics)", async () => {
			const p = join(dir, "a", "b", "c");
			const r = await backend.fs.mkdir(p);
			expect(r).toEqual({ ok: true, value: undefined });
			expect(await backend.fs.exists(p)).toEqual({ ok: true, value: true });
		});

		test("mkdir over an existing directory stays ok (-p semantics)", async () => {
			const r = await backend.fs.mkdir(dir);
			expect(r).toEqual({ ok: true, value: undefined });
		});

		test("readdir lists entry names", async () => {
			await backend.fs.writeFile(join(dir, "a.txt"), Buffer.from("a"));
			await backend.fs.writeFile(join(dir, "b.txt"), Buffer.from("b"));
			await backend.fs.mkdir(join(dir, "sub"));
			const r = await backend.fs.readdir(dir);
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.sort()).toEqual(["a.txt", "b.txt", "sub"]);
		});

		test("exists returns ok(true) for an existing path and ok(false) for a missing one", async () => {
			const p = join(dir, "f.txt");
			await backend.fs.writeFile(p, Buffer.from("x"));
			expect(await backend.fs.exists(p)).toEqual({ ok: true, value: true });
			expect(await backend.fs.exists(join(dir, "nope.txt"))).toEqual({ ok: true, value: false });
		});

		test("access (R_OK) is ok on a written file and err (ENOENT) on a missing path", async () => {
			const p = join(dir, "f.txt");
			await backend.fs.writeFile(p, Buffer.from("x"));
			expect(await backend.fs.access(p)).toEqual({ ok: true, value: undefined });
			expectErr(await backend.fs.access(join(dir, "nope.txt")), "ENOENT");
		});
	});

	describe("runShell", () => {
		test("exit code propagates (exit 3)", async () => {
			const r = await backend.runShell("exit 3", { cwd: dir });
			expect(r).toEqual({ exitCode: 3, timedOut: false });
		}, 15000);

		test("merges stdout and stderr preserving write order", async () => {
			const chunks: Buffer[] = [];
			// Pace the writes so each lands in its own pipe read before the next:
			// cross-pipe arrival order is only deterministic when the reader has
			// consumed each write before the next one happens (burst-written lines
			// can otherwise drain pipe-by-pipe, out of write order).
			const r = await backend.runShell("echo one; sleep 0.1; echo two >&2; sleep 0.1; echo three", {
				cwd: dir,
				onChunk: (b) => chunks.push(b),
			});
			expect(r).toEqual({ exitCode: 0, timedOut: false });
			const merged = chunks.map((c) => c.toString("utf-8")).join("");
			const one = merged.indexOf("one");
			const two = merged.indexOf("two");
			const three = merged.indexOf("three");
			expect(one).toBeGreaterThanOrEqual(0);
			expect(two).toBeGreaterThan(one);
			expect(three).toBeGreaterThan(two);
		}, 15000);

		test("cwd is respected (pwd prints the temp dir)", async () => {
			const chunks: Buffer[] = [];
			const r = await backend.runShell("pwd", { cwd: dir, onChunk: (b) => chunks.push(b) });
			expect(r).toEqual({ exitCode: 0, timedOut: false });
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe(dir);
		}, 15000);

		test("timeout resolves { exitCode: -1, timedOut: true } quickly", async () => {
			const start = Date.now();
			const r = await backend.runShell("sleep 30", { cwd: dir, timeoutSec: 1 });
			const elapsedMs = Date.now() - start;
			expect(r).toEqual({ exitCode: -1, timedOut: true });
			// Killed at ~1s by the group SIGKILL, not after `sleep 30` ran out.
			expect(elapsedMs).toBeLessThan(10000);
		}, 15000);

		test("timeout kills the whole process group (no orphan)", async () => {
			// `$$` is the spawned shell itself — the detached process-group leader —
			// so the pidfile names exactly the process the group SIGKILL must reap.
			const pidfile = join(dir, "pid");
			const r = await backend.runShell(`echo $$ > ${pidfile}; sleep 30`, { cwd: dir, timeoutSec: 1 });
			expect(r).toEqual({ exitCode: -1, timedOut: true });
			const pid = Number(readFileSync(pidfile, "utf-8").trim());
			expect(Number.isInteger(pid)).toBe(true);
			// Poll until the group leader is no longer live (gone or zombie, not R/S).
			// A live orphan here would mean the group kill failed.
			let live = true;
			for (let i = 0; i < 80 && live; i++) {
				const state = processState(pid);
				if (state === null || state === "Z") {
					live = false;
				} else {
					await sleep(25);
				}
			}
			expect(live).toBe(false);
		}, 15000);

		test("a missing shell rejects (spawn error is the documented genuine-throw path)", async () => {
			const savedShell = process.env.SHELL;
			process.env.SHELL = "/nonexistent/openhammer-no-such-shell";
			try {
				await expect(backend.runShell("echo hi", { cwd: dir })).rejects.toBeInstanceOf(Error);
			} finally {
				if (savedShell === undefined) {
					delete process.env.SHELL;
				} else {
					process.env.SHELL = savedShell;
				}
			}
		}, 15000);
	});

	describe("probe / probeFlag", () => {
		// Snapshot/restore PATH so the stripped-path case can't poison sibling tests
		// (spawnSync resolves via the inherited `process.env.PATH`; mirrors bin.test.ts).
		let savedPath: string | undefined;

		beforeEach(() => {
			savedPath = process.env.PATH;
		});

		afterEach(() => {
			if (savedPath === undefined) {
				delete process.env.PATH;
			} else {
				process.env.PATH = savedPath;
			}
		});

		test("probe mirrors isToolAvailable: true for node, false for an unknown binary", () => {
			// `node` is always present — vitest runs under it.
			expect(backend.probe("node")).toBe(true);
			expect(backend.probe("openhammer-definitely-not-a-real-binary-xyz")).toBe(false);
		}, 15000);

		test("probe returns false when PATH is stripped (a present binary no longer resolves)", () => {
			process.env.PATH = "/nonexistent";
			expect(backend.probe("node")).toBe(false);
		}, 15000);

		test("probeFlag mirrors find.ts's flag probe: accepted flag → true, rejected flag → false", () => {
			// `--harmony` is a real node flag (probe passes); a bogus one makes
			// `node <flag> --help` exit non-zero (probe fails), matching how
			// supportsNoRequireGit detects old fd builds lacking --no-require-git.
			expect(backend.probeFlag("node", "--harmony")).toBe(true);
			expect(backend.probeFlag("node", "--definitely-not-a-node-flag")).toBe(false);
		}, 15000);

		test("probeFlag returns false for a missing binary", () => {
			expect(backend.probeFlag("openhammer-definitely-not-a-real-binary-xyz", "--harmony")).toBe(false);
		}, 15000);
	});
});
