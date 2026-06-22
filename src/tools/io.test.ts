import { constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { access, exists, mkdir, readdir, readdirSync, readFile, stat, statSync, writeFile } from "./io.ts";
import type { Result } from "./result.ts";

// Tests use a real throwaway directory under the OS tmpdir. The whole point of
// io.ts is that throwing `node:fs` becomes `err` — so we exercise both the happy
// path (real files/dirs) and the errno-failure path (missing path, ENOTDIR,
// EEXIST) against the real filesystem.

let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "openhammer-io-"));
});

afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

// Each test gets an isolated subdir so they can't trample one another's fixtures.
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(workdir, "t-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

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

describe("readFile", () => {
	it("returns ok(Buffer) for an existing file (spec acceptance)", async () => {
		const p = join(dir, "hello.txt");
		writeFileSync(p, "hello world");
		const r = await readFile(p);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(Buffer.isBuffer(r.value)).toBe(true);
		expect(r.value.toString("utf-8")).toBe("hello world");
	});

	it("returns err(Error) with errno for a missing path (spec acceptance)", async () => {
		const r = await readFile(join(dir, "nope.txt"));
		expectErr(r, "ENOENT");
	});
});

describe("access", () => {
	it("returns ok for an existing file with no mode (F_OK)", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, "x");
		const r = await access(p);
		expect(r).toEqual({ ok: true, value: undefined });
	});

	it("returns ok for a readable file with R_OK", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, "x");
		const r = await access(p, constants.R_OK);
		expect(r.ok).toBe(true);
	});

	it("returns err(Error) with ENOENT for a missing path", async () => {
		const r = await access(join(dir, "nope.txt"));
		expectErr(r, "ENOENT");
	});
});

describe("stat / statSync", () => {
	it("stat returns ok(Stats) describing a file", async () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, "x");
		const r = await stat(p);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.value.isFile()).toBe(true);
	});

	it("stat returns err(Error) with ENOENT for a missing path", async () => {
		const r = await stat(join(dir, "nope.txt"));
		expectErr(r, "ENOENT");
	});

	it("statSync returns ok(Stats) describing a directory", () => {
		const r = statSync(dir);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.value.isDirectory()).toBe(true);
	});

	it("statSync returns err(Error) with ENOENT for a missing path", () => {
		const r = statSync(join(dir, "nope.txt"));
		expectErr(r, "ENOENT");
	});
});

describe("readdir / readdirSync", () => {
	beforeEach(() => {
		writeFileSync(join(dir, "a.txt"), "a");
		writeFileSync(join(dir, "b.txt"), "b");
		mkdirSync(join(dir, "sub"));
	});

	it("readdir returns ok(string[]) with the entry names", async () => {
		const r = await readdir(dir);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.value.sort()).toEqual(["a.txt", "b.txt", "sub"]);
	});

	it("readdir returns err(Error) with ENOENT for a missing path", async () => {
		const r = await readdir(join(dir, "nope"));
		expectErr(r, "ENOENT");
	});

	it("readdirSync returns ok(string[]) with the entry names", () => {
		const r = readdirSync(dir);
		expect(r.ok).toBe(true);
		if (!r.ok) throw new Error("unreachable");
		expect(r.value.sort()).toEqual(["a.txt", "b.txt", "sub"]);
	});

	it("readdirSync returns err(Error) with ENOTDIR when the path is a file", () => {
		const r = readdirSync(join(dir, "a.txt"));
		expectErr(r, "ENOTDIR");
	});
});

describe("writeFile", () => {
	it("writes content and returns ok(undefined) (read-back round trip)", async () => {
		const p = join(dir, "out.txt");
		const r = await writeFile(p, "payload");
		expect(r).toEqual({ ok: true, value: undefined });
		expect(readFileSync(p, "utf-8")).toBe("payload");
	});

	it("returns err(Error) with ENOENT when the parent dir does not exist", async () => {
		const r = await writeFile(join(dir, "missing", "out.txt"), "x");
		expectErr(r, "ENOENT");
	});
});

describe("mkdir", () => {
	it("creates a directory and returns ok(undefined)", async () => {
		const p = join(dir, "newdir");
		const r = await mkdir(p);
		expect(r).toEqual({ ok: true, value: undefined });
		const existsR = exists(p);
		expect(existsR).toEqual({ ok: true, value: true });
	});

	it("creates parents with { recursive: true } and returns ok(undefined)", async () => {
		const p = join(dir, "a", "b", "c");
		const r = await mkdir(p, { recursive: true });
		expect(r.ok).toBe(true);
		expect(exists(p)).toEqual({ ok: true, value: true });
	});

	it("returns err(Error) with EEXIST when the dir already exists (non-recursive)", async () => {
		const r = await mkdir(dir);
		expectErr(r, "EEXIST");
	});
});

describe("exists", () => {
	it("returns ok(true) for an existing path", () => {
		const p = join(dir, "f.txt");
		writeFileSync(p, "x");
		expect(exists(p)).toEqual({ ok: true, value: true });
	});

	it("returns ok(false) for a missing path", () => {
		expect(exists(join(dir, "nope.txt"))).toEqual({ ok: true, value: false });
	});
});
