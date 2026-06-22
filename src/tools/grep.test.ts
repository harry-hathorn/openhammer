import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { grepTool } from "./grep.ts";
import type { Result } from "./result.ts";

/** Assert a successful result and return its first text block's text. */
function expectText(res: Result<ToolOk, Error>): string {
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("expected ok result");
	const block = res.value.content[0];
	expect(block?.type).toBe("text");
	return block && block.type === "text" ? block.text : "";
}

describe("grepTool", () => {
	// Snapshot/restore PATH so the stripped-path case (rg-missing) can't poison the
	// sibling tests that need `rg` — vitest runs a file's tests in one process, and
	// `isToolAvailable`/`spawn` resolve via the inherited `process.env.PATH`.
	let rootDir: string;
	let savedPath: string | undefined;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-grep-"));
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

	test("returns matches as path:line: text and respects rg ignore files", async () => {
		writeFileSync(join(rootDir, "keep.ts"), "TODO: fix this\n");
		writeFileSync(join(rootDir, "ignored.ts"), "TODO: hidden from results\n");
		// rg honors `.gitignore` only inside a git repo, but `.ignore` universally —
		// same ignore-filtering code path the tool delegates to (no `--no-ignore`), and
		// git-free so the temp dir needs no `.git` (which `--hidden` would otherwise drag in).
		writeFileSync(join(rootDir, ".ignore"), "ignored.ts\n");

		const res = await grepTool.execute({ pattern: "TODO" }, rootDir);
		const text = expectText(res);

		// Match row is `path:line: text` (relative path under the searched dir).
		expect(text).toContain("keep.ts:1: TODO: fix this");
		// The ignore file is honored — the ignored file never surfaces.
		expect(text).not.toContain("ignored.ts");
	}, 15000);

	test("ignoreCase matches case-insensitively", async () => {
		writeFileSync(join(rootDir, "a.txt"), "Hello World\n");

		const sensitive = await grepTool.execute({ pattern: "hello" }, rootDir);
		expect(expectText(sensitive)).toBe("No matches found");

		const insensitive = await grepTool.execute({ pattern: "hello", ignoreCase: true }, rootDir);
		expect(expectText(insensitive)).toContain("a.txt:1: Hello World");
	}, 15000);

	test("literal escapes regex metacharacters", async () => {
		writeFileSync(join(rootDir, "a.txt"), "axb\n");

		// As a regex, "x.y" matches "x<any>y" — here there is none, so no match.
		const regex = await grepTool.execute({ pattern: "x.y" }, rootDir);
		expect(expectText(regex)).toBe("No matches found");

		writeFileSync(join(rootDir, "a.txt"), "axb\nx.y\n");
		// Literal "x.y" matches only the literal dots, not "x<any>y".
		const literal = await grepTool.execute({ pattern: "x.y", literal: true }, rootDir);
		const text = expectText(literal);
		expect(text).toContain("x.y");
		expect(text).not.toContain("axb");
	}, 15000);

	test("no match -> 'No matches found' (rg exit 1 is not an error)", async () => {
		writeFileSync(join(rootDir, "a.txt"), "nothing here\n");
		const res = await grepTool.execute({ pattern: "zzz-nope" }, rootDir);
		expect(expectText(res)).toBe("No matches found");
	}, 15000);

	test("missing rg (PATH stripped) -> err with install hint", async () => {
		writeFileSync(join(rootDir, "a.txt"), "TODO\n");
		process.env.PATH = "/nonexistent";

		const res = await grepTool.execute({ pattern: "TODO" }, rootDir);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe("ripgrep (rg) is not installed. Install ripgrep to use the grep tool.");
		}
	}, 15000);

	test("missing search path -> err", async () => {
		const res = await grepTool.execute({ pattern: "TODO", path: "does-not-exist" }, rootDir);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toContain("Path not found:");
		}
	}, 15000);

	test("limit caps matches and appends the limit-reached notice", async () => {
		// 5 matching lines; limit 2 -> exactly 2 rows + a notice.
		writeFileSync(join(rootDir, "many.txt"), `${Array.from({ length: 5 }, () => "needle").join("\n")}\n`);

		const res = await grepTool.execute({ pattern: "needle", limit: 2 }, rootDir);
		const text = expectText(res);

		const matchRows = text.split("\n").filter((line) => line.startsWith("many.txt:"));
		expect(matchRows.length).toBe(2);
		expect(text).toContain("2 matches limit reached");
	}, 15000);

	test("context emits match line plus before/after context lines", async () => {
		writeFileSync(join(rootDir, "ctx.txt"), "alpha\nTODO beta\ngamma\n");

		const res = await grepTool.execute({ pattern: "TODO", context: 1 }, rootDir);
		const text = expectText(res);

		// Match line (line 2) uses `path:n:`; context lines use `path-n-`.
		expect(text).toContain("ctx.txt:2: TODO beta");
		expect(text).toContain("ctx.txt-1- alpha");
		expect(text).toContain("ctx.txt-3- gamma");
	}, 15000);

	test("searching a single file uses the basename as the path prefix", async () => {
		mkdirSync(join(rootDir, "sub"), { recursive: true });
		writeFileSync(join(rootDir, "sub", "one.ts"), "TODO in a subdir\n");

		const res = await grepTool.execute({ pattern: "TODO", path: "sub/one.ts" }, rootDir);
		const text = expectText(res);
		// Not a directory search -> basename only (no subdir prefix).
		expect(text).toContain("one.ts:1: TODO in a subdir");
	}, 15000);
});
