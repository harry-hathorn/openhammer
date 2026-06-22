import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

// The write tool is a `ToolModule`; tests drive `execute` directly (Tier-0). Fixtures
// are real files under a throwaway tmpdir used as `rootDir` — `resolveToCwd` resolves
// relative paths under it, and absolute paths pass through (acceptance criteria).

let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "openhammer-write-"));
});

afterAll(() => {
	rmSync(workdir, { recursive: true, force: true });
});

let rootDir: string;

beforeEach(() => {
	// Each test gets an isolated subdir as `rootDir`.
	rootDir = mkdtempSync(join(workdir, "t-"));
});

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
	it("creates parent directories and writes the file (spec acceptance)", async () => {
		const r = await writeTool.execute({ path: "sub/dir/new.txt", content: "hi" }, rootDir);

		expect(textOf(r)).toBe("Successfully wrote 2 bytes to sub/dir/new.txt");
		expect(readFileSync(join(rootDir, "sub", "dir", "new.txt"), "utf-8")).toBe("hi");
	});

	it("overwrites an existing file (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "exists.txt"), "old content");
		const r = await writeTool.execute({ path: "exists.txt", content: "new content" }, rootDir);

		expect(textOf(r)).toBe("Successfully wrote 11 bytes to exists.txt");
		expect(readFileSync(join(rootDir, "exists.txt"), "utf-8")).toBe("new content");
	});

	it("round-trips: write then read returns the same content (spec acceptance)", async () => {
		const content = "first line\nsecond line\nthird";
		await writeTool.execute({ path: "rt.txt", content }, rootDir);

		const readRes = await readTool.execute({ path: "rt.txt" }, rootDir);
		expect(unwrap(readRes).content[0]).toMatchObject({ type: "text", text: content });
	});

	it("resolves relative paths under rootDir (spec acceptance)", async () => {
		await writeTool.execute({ path: "rel.txt", content: "relative" }, rootDir);

		expect(readFileSync(join(rootDir, "rel.txt"), "utf-8")).toBe("relative");
	});

	it("passes absolute paths through (spec acceptance)", async () => {
		const abs = join(rootDir, "abs.txt");
		// Pass a different rootDir to prove the absolute path is used as-is.
		await writeTool.execute({ path: abs, content: "absolute" }, "/somewhere/else");

		expect(readFileSync(abs, "utf-8")).toBe("absolute");
	});

	it("writes empty content and reports zero bytes", async () => {
		const r = await writeTool.execute({ path: "empty.txt", content: "" }, rootDir);

		expect(textOf(r)).toBe("Successfully wrote 0 bytes to empty.txt");
		expect(readFileSync(join(rootDir, "empty.txt"), "utf-8")).toBe("");
	});

	it("preserves UTF-8 content and counts UTF-16 length in the message (pi fidelity)", async () => {
		const content = "héllo 🌍 wörld";
		const r = await writeTool.execute({ path: "utf8.txt", content }, rootDir);

		expect(readFileSync(join(rootDir, "utf8.txt"), "utf-8")).toBe(content);
		// The byte count is the string's UTF-16 length (content.length), not its
		// UTF-8 byte length — ported unchanged from pi.
		expect(textOf(r)).toBe(`Successfully wrote ${content.length} bytes to utf8.txt`);
	});

	it("reports the original path in the success message, not the resolved absolute path", async () => {
		const r = await writeTool.execute({ path: "msg.txt", content: "x" }, rootDir);
		const text = textOf(r);

		expect(text).toBe("Successfully wrote 1 bytes to msg.txt");
		expect(text).not.toContain(rootDir);
	});

	it("errors when path is absent or not a string", async () => {
		const noPath = await writeTool.execute({ content: "x" }, rootDir);
		expect(noPath.ok).toBe(false);

		const badPath = await writeTool.execute({ path: 42, content: "x" }, rootDir);
		expect(badPath.ok).toBe(false);
	});

	it("errors when content is absent or not a string", async () => {
		const noContent = await writeTool.execute({ path: "x.txt" }, rootDir);
		expect(noContent.ok).toBe(false);

		const badContent = await writeTool.execute({ path: "x.txt", content: 42 }, rootDir);
		expect(badContent.ok).toBe(false);
	});

	it("errors when the target path is an existing directory", async () => {
		mkdirSync(join(rootDir, "adir"));
		const r = await writeTool.execute({ path: "adir", content: "x" }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
	});
});
