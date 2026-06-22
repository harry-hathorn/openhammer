import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { findTool } from "./find.ts";
import type { Result } from "./result.ts";

/** Assert a successful result and return its first text block's text. */
function expectText(res: Result<ToolOk, Error>): string {
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("expected ok result");
	const block = res.value.content[0];
	expect(block?.type).toBe("text");
	return block && block.type === "text" ? block.text : "";
}

describe("findTool", () => {
	// Snapshot/restore PATH so the stripped-path case (fd-missing) can't poison the
	// sibling tests that need `fd` — vitest runs a file's tests in one process, and
	// `isToolAvailable`/`spawn` resolve via the inherited `process.env.PATH`.
	let rootDir: string;
	let savedPath: string | undefined;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-find-"));
		savedPath = process.env.PATH;
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
		if (savedPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = savedPath;
		}
	});

	test("'**/*.ts' returns relative POSIX paths and respects .gitignore", async () => {
		mkdirSync(join(rootDir, "deep"), { recursive: true });
		writeFileSync(join(rootDir, "keep.ts"), "");
		writeFileSync(join(rootDir, "deep", "nested.ts"), "");
		writeFileSync(join(rootDir, "ignored.ts"), "");
		// fd honors `.gitignore` universally thanks to `--no-require-git` (no `.git`
		// needed in the temp dir) — the same ignore-filtering path the tool delegates to.
		writeFileSync(join(rootDir, ".gitignore"), "ignored.ts\n");

		const res = await findTool.execute({ pattern: "**/*.ts" }, rootDir);
		const text = expectText(res);

		// Paths are relative to the search dir with POSIX separators.
		expect(text).toContain("keep.ts");
		expect(text).toContain("deep/nested.ts");
		// The gitignored file never surfaces.
		expect(text).not.toContain("ignored.ts");
	}, 15000);

	test("basename '*.json' matches files at any depth", async () => {
		mkdirSync(join(rootDir, "src"), { recursive: true });
		writeFileSync(join(rootDir, "root.json"), "");
		writeFileSync(join(rootDir, "src", "nested.json"), "");
		writeFileSync(join(rootDir, "readme.md"), "");

		const res = await findTool.execute({ pattern: "*.json" }, rootDir);
		const text = expectText(res);

		// `--glob` (no `--full-path`) matches the basename recursively.
		expect(text).toContain("root.json");
		expect(text).toContain("src/nested.json");
		expect(text).not.toContain("readme.md");
	}, 15000);

	test("no match -> 'No files found matching pattern' (fd exit 0 is not an error)", async () => {
		writeFileSync(join(rootDir, "a.ts"), "");
		const res = await findTool.execute({ pattern: "zzz-none" }, rootDir);
		expect(expectText(res)).toBe("No files found matching pattern");
	}, 15000);

	test("missing fd (PATH stripped) -> err with install hint", async () => {
		writeFileSync(join(rootDir, "a.ts"), "");
		process.env.PATH = "/nonexistent";

		const res = await findTool.execute({ pattern: "*.ts" }, rootDir);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe("fd is not installed. Install fd to use the find tool.");
		}
	}, 15000);

	test("limit caps results and appends the results-limit-reached notice", async () => {
		// 5 matching files; limit 2 -> exactly 2 paths + a notice.
		for (const name of ["f1.ts", "f2.ts", "f3.ts", "f4.ts", "f5.ts"]) {
			writeFileSync(join(rootDir, name), "");
		}

		const res = await findTool.execute({ pattern: "*.ts", limit: 2 }, rootDir);
		const text = expectText(res);

		const resultLines = text.split("\n").filter((line) => line.endsWith(".ts"));
		expect(resultLines.length).toBe(2);
		expect(text).toContain("2 results limit reached");
	}, 15000);

	test("searching a subdir relativizes paths against that subdir", async () => {
		mkdirSync(join(rootDir, "sub"), { recursive: true });
		writeFileSync(join(rootDir, "sub", "one.ts"), "");
		writeFileSync(join(rootDir, "top.ts"), "");

		const res = await findTool.execute({ pattern: "*.ts", path: "sub" }, rootDir);
		const text = expectText(res);
		// Searching `sub/` -> paths are relative to `sub`, not the original root.
		expect(text).toContain("one.ts");
		expect(text).not.toContain("top.ts");
		expect(text).not.toContain("sub/");
	}, 15000);
});
