import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { readTool } from "./read.ts";
import { DEFAULT_MAX_BYTES } from "./truncate.ts";

// The read tool is a `ToolModule`; tests drive `execute` directly (Tier-0). Fixtures
// are real files under a throwaway tmpdir used as `rootDir` — `resolveToCwd` resolves
// relative paths under it, and absolute paths pass through (acceptance criteria).

let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "openhammer-read-"));
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

/** The single text block of a `read` result (there is exactly one for text files). */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

describe("read tool — text path", () => {
	it("returns the full file with no line-number prefixes (spec acceptance)", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		writeFileSync(join(rootDir, "a.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "a.txt" }, rootDir);

		// Raw content, exactly the 10 lines joined by \n — no `1\t`/`cat -n` prefixes.
		expect(textOf(r)).toBe(lines.join("\n"));
	});

	it("truncates a 3000-line file to the first 2000 and emits a continue notice (spec acceptance)", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
		writeFileSync(join(rootDir, "big.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "big.txt" }, rootDir);
		const text = textOf(r);

		// First 2000 lines present, line 2001 absent from the body.
		expect(text.startsWith(lines[0])).toBe(true);
		expect(text).toContain(lines[1999]!);
		expect(text).not.toContain(`\n${lines[2000]}`); // line 2001 not in the shown window
		// Actionable continuation notice pointing at the next window.
		expect(text).toContain("Showing lines 1-2000 of 3000.");
		expect(text).toContain("Use offset=2001 to continue.");
	});

	it("honors offset/limit and notes remaining lines (spec acceptance)", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
		writeFileSync(join(rootDir, "x.txt"), lines.join("\n"));

		// offset 5 (1-indexed) → array index 4; limit 3 → lines L5,L6,L7.
		const r = await readTool.execute({ path: "x.txt", offset: 5, limit: 3 }, rootDir);
		const text = textOf(r);

		expect(text.startsWith("L5\nL6\nL7")).toBe(true);
		// Limit stopped early with more remaining → continuation notice.
		expect(text).toContain("3 more lines in file. Use offset=8 to continue.");
	});

	it("emits no continue notice when offset/limit reaches EOF", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
		writeFileSync(join(rootDir, "x.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "x.txt", offset: 8, limit: 3 }, rootDir);
		const text = textOf(r);

		expect(text).toBe("L8\nL9\nL10");
		expect(text).not.toContain("more lines in file");
	});

	it("errors when offset is past EOF (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "x.txt"), "only one line");

		const r = await readTool.execute({ path: "x.txt", offset: 99999 }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
		expect(r.error.message).toContain("beyond end of file");
	});

	it("errors on a missing file (spec acceptance)", async () => {
		const r = await readTool.execute({ path: "nope.txt" }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
	});

	it("errors when path is absent or not a string", async () => {
		const noPath = await readTool.execute({}, rootDir);
		expect(noPath.ok).toBe(false);

		const badPath = await readTool.execute({ path: 42 }, rootDir);
		expect(badPath.ok).toBe(false);
	});

	it("resolves relative paths under rootDir (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "rel.txt"), "relative");
		const r = await readTool.execute({ path: "rel.txt" }, rootDir);
		expect(textOf(r)).toBe("relative");
	});

	it("passes absolute paths through (spec acceptance)", async () => {
		const abs = join(rootDir, "abs.txt");
		writeFileSync(abs, "absolute");
		// Pass a different rootDir to prove the absolute path is used as-is.
		const r = await readTool.execute({ path: abs }, "/somewhere/else");
		expect(textOf(r)).toBe("absolute");
	});

	it("points at a bash fallback when the first line alone exceeds the byte limit", async () => {
		// A single line larger than DEFAULT_MAX_BYTES (50KB) triggers firstLineExceedsLimit.
		const huge = "x".repeat(DEFAULT_MAX_BYTES + 1000);
		writeFileSync(join(rootDir, "huge.txt"), huge);

		const r = await readTool.execute({ path: "huge.txt" }, rootDir);
		const text = textOf(r);

		expect(text).toContain("exceeds");
		expect(text).toContain("Use bash: sed -n '1p'");
	});

	it("reads a file under a subdirectory of rootDir", async () => {
		mkdirSync(join(rootDir, "sub"));
		writeFileSync(join(rootDir, "sub", "nested.txt"), "nested");
		const r = await readTool.execute({ path: "sub/nested.txt" }, rootDir);
		expect(textOf(r)).toBe("nested");
	});
});
