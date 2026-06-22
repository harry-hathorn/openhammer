import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { editTool } from "./edit.ts";

// The edit tool is a `ToolModule`; tests drive `execute` directly (Tier-0). Fixtures
// are real files under a throwaway tmpdir used as `rootDir` — `resolveToCwd` resolves
// relative paths under it. Each error case also asserts the file is left unchanged
// (spec 06: "file unchanged" on every validation failure).

const BOM = "﻿";

let workdir: string;

beforeAll(() => {
	workdir = mkdtempSync(join(tmpdir(), "openhammer-edit-"));
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

/** The single text block of an `edit` result. */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

describe("edit tool", () => {
	it("applies a single exact edit and reports the block count (spec acceptance)", async () => {
		const file = join(rootDir, "f.txt");
		writeFileSync(file, "foo bar baz");

		const r = await editTool.execute({ path: "f.txt", edits: [{ oldText: "bar", newText: "qux" }] }, rootDir);

		expect(textOf(r)).toBe("Successfully replaced 1 block(s) in f.txt.");
		expect(readFileSync(file, "utf-8")).toBe("foo qux baz");
	});

	it("applies multiple disjoint edits in one call, each matched against the original (spec acceptance)", async () => {
		const file = join(rootDir, "multi.txt");
		writeFileSync(file, "alpha\nbeta\ngamma\ndelta");

		const r = await editTool.execute(
			{
				path: "multi.txt",
				edits: [
					{ oldText: "alpha", newText: "ALPHA" },
					{ oldText: "gamma", newText: "GAMMA" },
				],
			},
			rootDir,
		);

		expect(textOf(r)).toBe("Successfully replaced 2 block(s) in multi.txt.");
		expect(readFileSync(file, "utf-8")).toBe("ALPHA\nbeta\nGAMMA\ndelta");
	});

	it("matches each edit against the original file, not incrementally", async () => {
		// edit[1].oldText ("new") only exists after edit[0] is applied. Because every
		// edit is matched against the original, edit[1] is not-found → err, file unchanged.
		const file = join(rootDir, "incr.txt");
		const original = "old";
		writeFileSync(file, original);

		const r = await editTool.execute(
			{
				path: "incr.txt",
				edits: [
					{ oldText: "old", newText: "old new" },
					{ oldText: "new", newText: "NEW" },
				],
			},
			rootDir,
		);

		expect(r.ok).toBe(false);
		expect(readFileSync(file, "utf-8")).toBe(original);
	});

	it("errors on a non-unique oldText and leaves the file unchanged (spec acceptance)", async () => {
		const file = join(rootDir, "dup.txt");
		const original = "foo foo foo";
		writeFileSync(file, original);

		const r = await editTool.execute({ path: "dup.txt", edits: [{ oldText: "foo", newText: "bar" }] }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe(
			"Found 3 occurrences of the text in dup.txt. The text must be unique. Please provide more context to make it unique.",
		);
		expect(readFileSync(file, "utf-8")).toBe(original);
	});

	it("errors on a not-found oldText and leaves the file unchanged (spec acceptance)", async () => {
		const file = join(rootDir, "nf.txt");
		const original = "foo bar baz";
		writeFileSync(file, original);

		const r = await editTool.execute({ path: "nf.txt", edits: [{ oldText: "nope", newText: "x" }] }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe(
			"Could not find the exact text in nf.txt. The old text must match exactly including all whitespace and newlines.",
		);
		expect(readFileSync(file, "utf-8")).toBe(original);
	});

	it("errors on overlapping edits and leaves the file unchanged (spec acceptance)", async () => {
		const file = join(rootDir, "ov.txt");
		const original = "abcdefgh";
		writeFileSync(file, original);

		const r = await editTool.execute(
			{
				path: "ov.txt",
				edits: [
					{ oldText: "abcde", newText: "X" },
					{ oldText: "defgh", newText: "Y" },
				],
			},
			rootDir,
		);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe(
			"edits[0] and edits[1] overlap in ov.txt. Merge them into one edit or target disjoint regions.",
		);
		expect(readFileSync(file, "utf-8")).toBe(original);
	});

	it("matches via fuzzy trailing-whitespace and writes normalized content (spec acceptance)", async () => {
		// The file has trailing spaces the model omitted from oldText; fuzzy match still hits.
		const file = join(rootDir, "fuzzy.txt");
		writeFileSync(file, "foo   \nbar");

		const r = await editTool.execute(
			{ path: "fuzzy.txt", edits: [{ oldText: "foo\nbar", newText: "qux\nbar" }] },
			rootDir,
		);

		expect(textOf(r)).toBe("Successfully replaced 1 block(s) in fuzzy.txt.");
		// Fuzzy space strips the trailing whitespace, so the result is normalized.
		expect(readFileSync(file, "utf-8")).toBe("qux\nbar");
	});

	it("preserves BOM and CRLF line endings across the edit (spec acceptance)", async () => {
		const file = join(rootDir, "crlf.txt");
		writeFileSync(file, `${BOM}line1\r\nline2\r\n`);

		const r = await editTool.execute(
			{ path: "crlf.txt", edits: [{ oldText: "line2", newText: "line two" }] },
			rootDir,
		);

		expect(textOf(r)).toBe("Successfully replaced 1 block(s) in crlf.txt.");
		expect(readFileSync(file, "utf-8")).toBe(`${BOM}line1\r\nline two\r\n`);
	});

	it("tolerates the legacy {oldText, newText} form (prepareEditArguments)", async () => {
		const file = join(rootDir, "legacy.txt");
		writeFileSync(file, "hello world");

		const r = await editTool.execute({ path: "legacy.txt", oldText: "world", newText: "earth" }, rootDir);

		expect(textOf(r)).toBe("Successfully replaced 1 block(s) in legacy.txt.");
		expect(readFileSync(file, "utf-8")).toBe("hello earth");
	});

	it("tolerates edits sent as a JSON string (prepareEditArguments)", async () => {
		const file = join(rootDir, "jsonstr.txt");
		writeFileSync(file, "foo bar");

		const r = await editTool.execute(
			{ path: "jsonstr.txt", edits: JSON.stringify([{ oldText: "bar", newText: "baz" }]) },
			rootDir,
		);

		expect(textOf(r)).toBe("Successfully replaced 1 block(s) in jsonstr.txt.");
		expect(readFileSync(file, "utf-8")).toBe("foo baz");
	});

	it("errors when the file is missing (access failure)", async () => {
		const r = await editTool.execute({ path: "missing.txt", edits: [{ oldText: "x", newText: "y" }] }, rootDir);

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		// pi-faithful access-failure message with the errno code.
		expect(r.error.message).toBe("Could not edit file: missing.txt. Error code: ENOENT.");
	});

	it("errors when edits is empty or not an array", async () => {
		writeFileSync(join(rootDir, "e.txt"), "x");

		const empty = await editTool.execute({ path: "e.txt", edits: [] }, rootDir);
		expect(empty.ok).toBe(false);
		if (empty.ok) throw new Error("unreachable");
		expect(empty.error.message).toBe("Edit tool input is invalid. edits must contain at least one replacement.");

		const notArray = await editTool.execute({ path: "e.txt", edits: "nope" }, rootDir);
		expect(notArray.ok).toBe(false);
	});

	it("errors when path is not a string", async () => {
		const r = await editTool.execute({ path: 42, edits: [{ oldText: "x", newText: "y" }] }, rootDir);
		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe("edit requires a string 'path' argument");
	});

	it("reports the original path, not the resolved absolute path", async () => {
		const file = join(rootDir, "msg.txt");
		writeFileSync(file, "aaa");

		const r = await editTool.execute({ path: "msg.txt", edits: [{ oldText: "aaa", newText: "bbb" }] }, rootDir);
		const text = textOf(r);

		expect(text).toBe("Successfully replaced 1 block(s) in msg.txt.");
		expect(text).not.toContain(rootDir);
		expect(readFileSync(file, "utf-8")).toBe("bbb");
	});
});
