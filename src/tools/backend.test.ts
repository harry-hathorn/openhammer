import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { fakeBackend } from "./backend.fake.ts";
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
// that runShell matches today's bash semantics. The FakeBackend below (spec 23)
// is what makes the tool-layer shaping tests spawn-free.
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

// FakeBackend (backend.fake.ts) is the scripted, spawn-free ToolBackend that
// later boxes point every tool's shaping tests at — these tests pin its fs errno
// shapes, script consumption, spying, and determinism so those tool tests can
// trust it blindly.
describe("FakeBackend", () => {
	describe("identity & lifecycle", () => {
		test("kind is 'local' (it fakes the local shape; tools must not branch on kind)", () => {
			expect(fakeBackend().kind).toBe("local");
		});

		test("homedir defaults to /home/fake and honors the seed override", () => {
			expect(fakeBackend().homedir()).toBe("/home/fake");
			expect(fakeBackend({ homedir: "/home/vm" }).homedir()).toBe("/home/vm");
		});

		test("close resolves and sets the closed flag", async () => {
			const backend = fakeBackend();
			expect(backend.closed).toBe(false);
			await expect(backend.close()).resolves.toBeUndefined();
			expect(backend.closed).toBe(true);
		});

		test("overflowPath is deterministic and unique: /tmp/fake/<prefix>-<n>.log", () => {
			const backend = fakeBackend();
			expect(backend.overflowPath("openhammer")).toBe("/tmp/fake/openhammer-1.log");
			expect(backend.overflowPath("openhammer")).toBe("/tmp/fake/openhammer-2.log");
			// One counter per instance (shared across prefixes → unique)…
			expect(backend.overflowPath("other")).toBe("/tmp/fake/other-3.log");
			// …and a fresh instance restarts at 1, so tests stay order-independent.
			expect(fakeBackend().overflowPath("openhammer")).toBe("/tmp/fake/openhammer-1.log");
		});
	});

	describe("fs", () => {
		test("writeFile → readFile round-trips; the stored and returned Buffers are copies", async () => {
			const backend = fakeBackend({ dirs: ["/work"] });
			const input = Buffer.from("abc");
			const w = await backend.fs.writeFile("/work/f", input);
			expect(w).toEqual({ ok: true, value: undefined });
			input[0] = 88; // mutate the caller's buffer after the write — must not rewrite history
			const first = await backend.fs.readFile("/work/f");
			expect(first.ok).toBe(true);
			if (!first.ok) throw new Error("unreachable");
			expect(first.value.toString("utf-8")).toBe("abc");
			first.value[0] = 88; // mutate the returned copy — the store must stay intact
			const second = await backend.fs.readFile("/work/f");
			expect(second.ok).toBe(true);
			if (!second.ok) throw new Error("unreachable");
			expect(second.value.toString("utf-8")).toBe("abc");
		});

		test("readFile of a missing path returns err ENOENT with the real message shape", async () => {
			const backend = fakeBackend({ dirs: ["/work"] });
			const r = await backend.fs.readFile("/work/nope.txt");
			expectErr(r, "ENOENT");
			if (r.ok) throw new Error("unreachable");
			expect(r.error.message).toBe("ENOENT: no such file or directory, open '/work/nope.txt'");
		});

		test("readFile of a directory returns err EISDIR (real message carries no path)", async () => {
			const backend = fakeBackend({ dirs: ["/work"] });
			const r = await backend.fs.readFile("/work");
			expectErr(r, "EISDIR");
			if (r.ok) throw new Error("unreachable");
			expect(r.error.message).toBe("EISDIR: illegal operation on a directory, read");
		});

		test("writeFile with a missing parent errs ENOENT (strict: runtime writes create no implicit dirs)", async () => {
			const backend = fakeBackend();
			const r = await backend.fs.writeFile("/work/f.txt", Buffer.from("x"));
			expectErr(r, "ENOENT");
			if (r.ok) throw new Error("unreachable");
			expect(r.error.message).toBe("ENOENT: no such file or directory, open '/work/f.txt'");
			// The tree becomes writable once the parent is properly made.
			expect((await backend.fs.mkdir("/work")).ok).toBe(true);
			expect((await backend.fs.writeFile("/work/f.txt", Buffer.from("x"))).ok).toBe(true);
		});

		test("writeFile under a file-as-parent errs ENOTDIR; onto a directory errs EISDIR", async () => {
			const backend = fakeBackend({ files: { "/work/f": "not a dir" } });
			expectErr(await backend.fs.writeFile("/work/f/x.txt", Buffer.from("x")), "ENOTDIR");
			expectErr(await backend.fs.writeFile("/work", Buffer.from("x")), "EISDIR");
		});

		test("stat maps a file: isFile, size from contents, mtimeMs > 0", async () => {
			const backend = fakeBackend({ files: { "/work/f.txt": "12345" } });
			const r = await backend.fs.stat("/work/f.txt");
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.isFile).toBe(true);
			expect(r.value.isDir).toBe(false);
			expect(r.value.size).toBe(5);
			expect(r.value.mtimeMs).toBeGreaterThan(0);
		});

		test("stat maps a directory: isDir, size 0", async () => {
			const backend = fakeBackend({ dirs: ["/work"] });
			const r = await backend.fs.stat("/work");
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.isFile).toBe(false);
			expect(r.value.isDir).toBe(true);
			expect(r.value.size).toBe(0);
			expect(r.value.mtimeMs).toBeGreaterThan(0);
		});

		test("stat of a missing path returns err ENOENT", async () => {
			expectErr(await fakeBackend().fs.stat("/work/nope"), "ENOENT");
		});

		test("mkdir registers the whole ancestor chain (-p) and is idempotent", async () => {
			const backend = fakeBackend();
			expect(await backend.fs.mkdir("/work/a/b")).toEqual({ ok: true, value: undefined });
			expect(await backend.fs.exists("/work")).toEqual({ ok: true, value: true });
			expect(await backend.fs.exists("/work/a")).toEqual({ ok: true, value: true });
			expect(await backend.fs.exists("/work/a/b")).toEqual({ ok: true, value: true });
			expect(await backend.fs.mkdir("/work/a/b")).toEqual({ ok: true, value: undefined });
		});

		test("readdir lists direct entry names sorted (files and dirs alike)", async () => {
			const backend = fakeBackend({
				files: { "/work/c.txt": "c", "/work/a.txt": "a" },
				dirs: ["/work/sub", "/work/empty"],
			});
			const r = await backend.fs.readdir("/work");
			expect(r).toEqual({ ok: true, value: ["a.txt", "c.txt", "empty", "sub"] });
			expect(await backend.fs.readdir("/work/empty")).toEqual({ ok: true, value: [] });
			expect(await backend.fs.readdir("/work/sub")).toEqual({ ok: true, value: [] });
		});

		test("readdir of a file errs ENOTDIR; of a missing path errs ENOENT", async () => {
			const backend = fakeBackend({ files: { "/work/f.txt": "x" } });
			const notDir = await backend.fs.readdir("/work/f.txt");
			expectErr(notDir, "ENOTDIR");
			if (notDir.ok) throw new Error("unreachable");
			expect(notDir.error.message).toBe("ENOTDIR: not a directory, scandir '/work/f.txt'");
			const missing = await backend.fs.readdir("/work/nope");
			expectErr(missing, "ENOENT");
			if (missing.ok) throw new Error("unreachable");
			expect(missing.error.message).toBe("ENOENT: no such file or directory, scandir '/work/nope'");
		});

		test("exists ok(true)/ok(false); access ok on file and dir, ENOENT on missing", async () => {
			const backend = fakeBackend({ files: { "/work/f.txt": "x" }, dirs: ["/work/empty"] });
			expect(await backend.fs.exists("/work/f.txt")).toEqual({ ok: true, value: true });
			expect(await backend.fs.exists("/work/empty")).toEqual({ ok: true, value: true });
			expect(await backend.fs.exists("/work/nope.txt")).toEqual({ ok: true, value: false });
			expect(await backend.fs.access("/work/f.txt")).toEqual({ ok: true, value: undefined });
			expect(await backend.fs.access("/work/empty")).toEqual({ ok: true, value: undefined });
			expectErr(await backend.fs.access("/work/nope.txt"), "ENOENT");
		});

		test("seeded files auto-register their ancestor dirs (world-building sugar)", async () => {
			const backend = fakeBackend({ files: { "/work/deep/nest/f.txt": "hi" } });
			expect(await backend.fs.exists("/work/deep/nest")).toEqual({ ok: true, value: true });
			expect(await backend.fs.readdir("/work/deep")).toEqual({ ok: true, value: ["nest"] });
			const r = await backend.fs.readFile("/work/deep/nest/f.txt");
			expect(r.ok).toBe(true);
			if (!r.ok) throw new Error("unreachable");
			expect(r.value.toString("utf-8")).toBe("hi");
		});
	});

	describe("runShell scripting", () => {
		test("the first matching unconsumed entry wins and is consumed, in script order", async () => {
			const backend = fakeBackend({
				script: [
					{ match: "git", result: { exitCode: 0 }, stdout: "first" },
					{ match: "git", result: { exitCode: 1 }, stderr: "second" },
				],
			});
			expect(await backend.runShell("git status", { cwd: "/work" })).toEqual({ exitCode: 0, timedOut: false });
			expect(await backend.runShell("git status", { cwd: "/work" })).toEqual({ exitCode: 1, timedOut: false });
			// Both entries spent → the command is now unscripted (loud 127 below).
			expect(await backend.runShell("git status", { cwd: "/work" })).toEqual({ exitCode: 127, timedOut: false });
		});

		test("a string match is a substring test; a RegExp uses .test", async () => {
			const backend = fakeBackend({
				script: [{ match: /^rg --json /, result: { exitCode: 0 }, stdout: "rg-out" }],
			});
			expect((await backend.runShell("rg --json -- pat /work", { cwd: "/work" })).exitCode).toBe(0);
			// The regex anchors on the command start, so this one misses.
			expect((await backend.runShell("echo rg --json", { cwd: "/work" })).exitCode).toBe(127);
			const substring = fakeBackend({
				script: [{ match: "definitely-substring", result: { exitCode: 0 } }],
			});
			expect((await substring.runShell("echo definitely-substring-today", { cwd: "/work" })).exitCode).toBe(0);
		});

		test("stdout then stderr each arrive as one immediate chunk, in order", async () => {
			const backend = fakeBackend({
				script: [{ match: "probe", result: { exitCode: 0 }, stdout: "out-lump\n", stderr: "err-lump\n" }],
			});
			const chunks: Buffer[] = [];
			const r = await backend.runShell("probe --version", { cwd: "/work", onChunk: (b) => chunks.push(b) });
			expect(r).toEqual({ exitCode: 0, timedOut: false });
			expect(chunks.map((c) => c.toString("utf-8"))).toEqual(["out-lump\n", "err-lump\n"]);
		});

		test("chunkDelayMs splits the output into multiple delayed chunks, order preserved", async () => {
			const backend = fakeBackend({
				script: [
					{ match: "tee", result: { exitCode: 0 }, stdout: "0123456789", stderr: "abcdefghij", chunkDelayMs: 5 },
				],
			});
			const chunks: Buffer[] = [];
			const start = Date.now();
			const r = await backend.runShell("tee /tmp/x", { cwd: "/work", onChunk: (b) => chunks.push(b) });
			expect(r).toEqual({ exitCode: 0, timedOut: false });
			// Each 10-char stream deterministically splits into 3 contiguous chunks.
			expect(chunks.map((c) => c.toString("utf-8"))).toEqual(["0123", "4567", "89", "abcd", "efgh", "ij"]);
			// 5 gaps of >=5ms between the 6 chunks (loose lower bound — timers never fire early).
			expect(Date.now() - start).toBeGreaterThanOrEqual(20);
		});

		test("a scripted timeout result passes through verbatim (no real timer runs)", async () => {
			const backend = fakeBackend({ script: [{ match: "sleep", result: { exitCode: -1, timedOut: true } }] });
			expect(await backend.runShell("sleep 30", { cwd: "/work", timeoutSec: 1 })).toEqual({
				exitCode: -1,
				timedOut: true,
			});
		});

		test("no matching script → 127, stderr chunk, and an unexpectedCalls record", async () => {
			const backend = fakeBackend();
			const chunks: Buffer[] = [];
			const r = await backend.runShell("fd --json .", { cwd: "/work", onChunk: (b) => chunks.push(b) });
			expect(r).toEqual({ exitCode: 127, timedOut: false });
			expect(backend.unexpectedCalls).toEqual(["fd --json ."]);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe("fake-backend: no script for: fd --json .");
		});

		test("calls record cmd, cwd and timeoutSec for command-construction assertions", async () => {
			const backend = fakeBackend({
				script: [
					{ match: "echo", result: { exitCode: 0 } },
					{ match: "echo", result: { exitCode: 0 } },
				],
			});
			await backend.runShell("echo one", { cwd: "/w1" });
			await backend.runShell("echo two", { cwd: "/w2", timeoutSec: 30, onChunk: () => {} });
			expect(backend.calls).toEqual([
				{ cmd: "echo one", cwd: "/w1" },
				{ cmd: "echo two", cwd: "/w2", timeoutSec: 30 },
			]);
			expect(backend.unexpectedCalls).toEqual([]);
		});

		test("an omitted onChunk is fine (nothing to emit to)", async () => {
			const backend = fakeBackend({
				script: [{ match: "echo", result: { exitCode: 0 }, stdout: "hi", chunkDelayMs: 1 }],
			});
			expect(await backend.runShell("echo hi", { cwd: "/work" })).toEqual({ exitCode: 0, timedOut: false });
		});
	});

	describe("probe scripting", () => {
		test("probe returns the scripted table, defaulting false; calls are recorded", () => {
			const backend = fakeBackend({ probeResults: { rg: true } });
			expect(backend.probe("rg")).toBe(true);
			expect(backend.probe("fd")).toBe(false); // unscripted → absent
			expect(backend.probeCalls).toEqual(["rg", "fd"]);
		});

		test("probeFlag keys '<bin> <flag>', defaults false; calls are recorded", () => {
			const backend = fakeBackend({ probeFlagResults: { "fd --no-require-git": true } });
			expect(backend.probeFlag("fd", "--no-require-git")).toBe(true);
			expect(backend.probeFlag("fd", "--definitely-not")).toBe(false);
			expect(backend.probeFlag("rg", "--no-require-git")).toBe(false);
			expect(backend.probeFlagCalls).toEqual([
				{ bin: "fd", flag: "--no-require-git" },
				{ bin: "fd", flag: "--definitely-not" },
				{ bin: "rg", flag: "--no-require-git" },
			]);
		});
	});
});
