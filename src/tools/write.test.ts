import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { type FakeBackend, fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

// The write tool is a `ToolModule`; tests drive `execute` directly (Tier-0). Fixtures
// are real files under a throwaway tmpdir used as `rootDir` — `resolveToCwd` resolves
// relative paths under it, and absolute paths pass through (acceptance criteria).

// One local backend per file (spec 23) — LocalBackend is stateless, matching the
// boot-scoped seam without per-test machinery.
const backend = createLocalBackend();

/** Unwrap a successful Result; throw (failing the test) if it was an err. */
function unwrap<T extends ToolOk>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!r.ok) {
		throw new Error(`expected ok, got err: ${r.error.message}`);
	}
	return r.value;
}

/** The single text block of a `write` result. */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

describe("write tool", () => {
	// Real-fs hooks scoped to this describe (not module level) so the FakeBackend
	// suite below runs with zero real-fs access and zero process spawns.
	let workdir: string;
	let rootDir: string;

	beforeAll(() => {
		workdir = mkdtempSync(join(tmpdir(), "openhammer-write-"));
	});

	afterAll(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	beforeEach(() => {
		// Each test gets an isolated subdir as `rootDir`.
		rootDir = mkdtempSync(join(workdir, "t-"));
	});

	it("creates parent directories and writes the file (spec acceptance)", async () => {
		const r = await writeTool.execute({ path: "sub/dir/new.txt", content: "hi" }, { rootDir, backend });

		expect(textOf(r)).toBe("Successfully wrote 2 bytes to sub/dir/new.txt");
		expect(readFileSync(join(rootDir, "sub", "dir", "new.txt"), "utf-8")).toBe("hi");
	});

	it("overwrites an existing file (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "exists.txt"), "old content");
		const r = await writeTool.execute({ path: "exists.txt", content: "new content" }, { rootDir, backend });

		expect(textOf(r)).toBe("Successfully wrote 11 bytes to exists.txt");
		expect(readFileSync(join(rootDir, "exists.txt"), "utf-8")).toBe("new content");
	});

	it("round-trips: write then read returns the same content (spec acceptance)", async () => {
		const content = "first line\nsecond line\nthird";
		await writeTool.execute({ path: "rt.txt", content }, { rootDir, backend });

		const readRes = await readTool.execute({ path: "rt.txt" }, { rootDir, backend });
		expect(unwrap(readRes).content[0]).toMatchObject({ type: "text", text: content });
	});

	it("resolves relative paths under rootDir (spec acceptance)", async () => {
		await writeTool.execute({ path: "rel.txt", content: "relative" }, { rootDir, backend });

		expect(readFileSync(join(rootDir, "rel.txt"), "utf-8")).toBe("relative");
	});

	it("passes absolute paths through (spec acceptance)", async () => {
		const abs = join(rootDir, "abs.txt");
		// Pass a different rootDir to prove the absolute path is used as-is.
		await writeTool.execute({ path: abs, content: "absolute" }, { rootDir: "/somewhere/else", backend });

		expect(readFileSync(abs, "utf-8")).toBe("absolute");
	});

	it("writes empty content and reports zero bytes", async () => {
		const r = await writeTool.execute({ path: "empty.txt", content: "" }, { rootDir, backend });

		expect(textOf(r)).toBe("Successfully wrote 0 bytes to empty.txt");
		expect(readFileSync(join(rootDir, "empty.txt"), "utf-8")).toBe("");
	});

	it("preserves UTF-8 content and counts UTF-16 length in the message (pi fidelity)", async () => {
		const content = "héllo 🌍 wörld";
		const r = await writeTool.execute({ path: "utf8.txt", content }, { rootDir, backend });

		expect(readFileSync(join(rootDir, "utf8.txt"), "utf-8")).toBe(content);
		// The byte count is the string's UTF-16 length (content.length), not its
		// UTF-8 byte length — ported unchanged from pi.
		expect(textOf(r)).toBe(`Successfully wrote ${content.length} bytes to utf8.txt`);
	});

	it("reports the original path in the success message, not the resolved absolute path", async () => {
		const r = await writeTool.execute({ path: "msg.txt", content: "x" }, { rootDir, backend });
		const text = textOf(r);

		expect(text).toBe("Successfully wrote 1 bytes to msg.txt");
		expect(text).not.toContain(rootDir);
	});

	it("errors when path is absent or not a string", async () => {
		const noPath = await writeTool.execute({ content: "x" }, { rootDir, backend });
		expect(noPath.ok).toBe(false);

		const badPath = await writeTool.execute({ path: 42, content: "x" }, { rootDir, backend });
		expect(badPath.ok).toBe(false);
	});

	it("errors when content is absent or not a string", async () => {
		const noContent = await writeTool.execute({ path: "x.txt" }, { rootDir, backend });
		expect(noContent.ok).toBe(false);

		const badContent = await writeTool.execute({ path: "x.txt", content: 42 }, { rootDir, backend });
		expect(badContent.ok).toBe(false);
	});

	it("errors when the target path is an existing directory", async () => {
		mkdirSync(join(rootDir, "adir"));
		const r = await writeTool.execute({ path: "adir", content: "x" }, { rootDir, backend });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
	});
});

// Spec 23: the shaping suite — same tool, FakeBackend instead of LocalBackend, so
// the success message, strict-parent error, and dir-target error are pinned with
// zero real-fs access and zero process spawns. The fake's files map is private;
// read-back goes through the same backend instance's `readFile`.
describe("write via FakeBackend", () => {
	/** Read a file back through the same fake (assert what the tool wrote). */
	async function readBack(fake: FakeBackend, path: string): Promise<string> {
		const r = await fake.fs.readFile(path);
		if (!r.ok) throw new Error(`readBack(${path}) failed: ${r.error.message}`);
		return r.value.toString("utf-8");
	}

	it("happy path: creates parents, writes, reports UTF-16 length + the original path", async () => {
		const fake = fakeBackend({ dirs: ["/work"] });

		const r = await writeTool.execute(
			{ path: "sub/dir/new.txt", content: "hi" },
			{ rootDir: "/work", backend: fake },
		);

		expect(textOf(r)).toBe("Successfully wrote 2 bytes to sub/dir/new.txt");
		expect(await readBack(fake, "/work/sub/dir/new.txt")).toBe("hi");
	});

	it("overwrites a seeded file", async () => {
		const fake = fakeBackend({ files: { "/work/exists.txt": "old content" } });

		const r = await writeTool.execute(
			{ path: "exists.txt", content: "new content" },
			{ rootDir: "/work", backend: fake },
		);

		expect(textOf(r)).toBe("Successfully wrote 11 bytes to exists.txt");
		expect(await readBack(fake, "/work/exists.txt")).toBe("new content");
	});

	it("strict-parent error: a file on the parent path → err ENOTDIR, nothing written", async () => {
		// `write` mkdir -p's first, so a plain missing parent never surfaces as
		// writeFile's ENOENT (the fake exercises that errno at the backend level,
		// backend.test.ts). The reachable strict-parent failure through the tool is
		// a *file* sitting where a parent dir should be: the fake's mkdir stays
		// permissive, its writeFile does not.
		const fake = fakeBackend({ files: { "/work/afile": "not a dir" } });

		const r = await writeTool.execute({ path: "afile/child.txt", content: "x" }, { rootDir: "/work", backend: fake });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe("ENOTDIR: not a directory, open '/work/afile/child.txt'");
		expect((await fake.fs.readFile("/work/afile/child.txt")).ok).toBe(false); // nothing was created
	});

	it("target is an existing directory → err EISDIR", async () => {
		const fake = fakeBackend({ dirs: ["/work/adir"] });

		const r = await writeTool.execute({ path: "adir", content: "x" }, { rootDir: "/work", backend: fake });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe("EISDIR: illegal operation on a directory, open '/work/adir'");
	});
});
