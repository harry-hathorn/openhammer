import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { grepTool } from "./grep.ts";
import type { Result } from "./result.ts";

// One local backend per file (spec 23) — LocalBackend is stateless, matching the
// boot-scoped seam without per-test machinery.
const backend = createLocalBackend();

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

		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend });
		const text = expectText(res);

		// Match row is `path:line: text` (relative path under the searched dir).
		expect(text).toContain("keep.ts:1: TODO: fix this");
		// The ignore file is honored — the ignored file never surfaces.
		expect(text).not.toContain("ignored.ts");
	}, 15000);

	test("ignoreCase matches case-insensitively", async () => {
		writeFileSync(join(rootDir, "a.txt"), "Hello World\n");

		const sensitive = await grepTool.execute({ pattern: "hello" }, { rootDir, backend });
		expect(expectText(sensitive)).toBe("No matches found");

		const insensitive = await grepTool.execute({ pattern: "hello", ignoreCase: true }, { rootDir, backend });
		expect(expectText(insensitive)).toContain("a.txt:1: Hello World");
	}, 15000);

	test("literal escapes regex metacharacters", async () => {
		writeFileSync(join(rootDir, "a.txt"), "axb\n");

		// As a regex, "x.y" matches "x<any>y" — here there is none, so no match.
		const regex = await grepTool.execute({ pattern: "x.y" }, { rootDir, backend });
		expect(expectText(regex)).toBe("No matches found");

		writeFileSync(join(rootDir, "a.txt"), "axb\nx.y\n");
		// Literal "x.y" matches only the literal dots, not "x<any>y".
		const literal = await grepTool.execute({ pattern: "x.y", literal: true }, { rootDir, backend });
		const text = expectText(literal);
		expect(text).toContain("x.y");
		expect(text).not.toContain("axb");
	}, 15000);

	test("no match -> 'No matches found' (rg exit 1 is not an error)", async () => {
		writeFileSync(join(rootDir, "a.txt"), "nothing here\n");
		const res = await grepTool.execute({ pattern: "zzz-nope" }, { rootDir, backend });
		expect(expectText(res)).toBe("No matches found");
	}, 15000);

	test("missing rg (PATH stripped) -> err with install hint", async () => {
		writeFileSync(join(rootDir, "a.txt"), "TODO\n");
		process.env.PATH = "/nonexistent";

		// Fresh backend on purpose: the shared instance above has `rg` cached as
		// present (spec 23's per-instance probe cache), and a warm cache keeps
		// answering true even with PATH stripped — the state the cache makes
		// unreachable for one process.
		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend: createLocalBackend() });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe("ripgrep (rg) is not installed. Install ripgrep to use the grep tool.");
		}
	}, 15000);

	test("missing search path -> err", async () => {
		const res = await grepTool.execute({ pattern: "TODO", path: "does-not-exist" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toContain("Path not found:");
		}
	}, 15000);

	test("limit caps matches and appends the limit-reached notice", async () => {
		// 5 matching lines; limit 2 -> exactly 2 rows + a notice.
		writeFileSync(join(rootDir, "many.txt"), `${Array.from({ length: 5 }, () => "needle").join("\n")}\n`);

		const res = await grepTool.execute({ pattern: "needle", limit: 2 }, { rootDir, backend });
		const text = expectText(res);

		const matchRows = text.split("\n").filter((line) => line.startsWith("many.txt:"));
		expect(matchRows.length).toBe(2);
		expect(text).toContain("2 matches limit reached");
	}, 15000);

	test("context emits match line plus before/after context lines", async () => {
		writeFileSync(join(rootDir, "ctx.txt"), "alpha\nTODO beta\ngamma\n");

		const res = await grepTool.execute({ pattern: "TODO", context: 1 }, { rootDir, backend });
		const text = expectText(res);

		// Match line (line 2) uses `path:n:`; context lines use `path-n-`.
		expect(text).toContain("ctx.txt:2: TODO beta");
		expect(text).toContain("ctx.txt-1- alpha");
		expect(text).toContain("ctx.txt-3- gamma");
	}, 15000);

	test("searching a single file uses the basename as the path prefix", async () => {
		mkdirSync(join(rootDir, "sub"), { recursive: true });
		writeFileSync(join(rootDir, "sub", "one.ts"), "TODO in a subdir\n");

		const res = await grepTool.execute({ pattern: "TODO", path: "sub/one.ts" }, { rootDir, backend });
		const text = expectText(res);
		// Not a directory search -> basename only (no subdir prefix).
		expect(text).toContain("one.ts:1: TODO in a subdir");
	}, 15000);
});

// Spec 23f: the runArgv + backend-fs shaping, driven by the scripted FakeBackend —
// zero process spawns, zero host fs (the NDJSON comes from the script; the
// context lines from the fake's in-memory files, which is exactly what the
// off-seam fs fix makes testable). The real-rg counterparts live above.
describe("grep via FakeBackend", () => {
	const rootDir = "/work";

	/** A realistic `rg --json` match event line (the shape rg emits per hit). */
	function rgMatch(path: string, lineNumber: number, text: string): string {
		return JSON.stringify({
			type: "match",
			data: {
				path: { text: path },
				lines: { text: `${text}\n` },
				line_number: lineNumber,
				absolute_offset: 0,
				submatches: [{ match: { text: "TODO" }, start: 0, end: 4 }],
			},
		});
	}

	test("scripted rg NDJSON stdout -> path:line: text rows; exact argv recorded", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [
				{
					match: /^rg --json/,
					result: { exitCode: 0 },
					stdout: `${rgMatch("/work/a.ts", 1, "TODO fix this")}\n${rgMatch("/work/b.ts", 7, "TODO elsewhere")}\n`,
				},
			],
		});
		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend });
		expect(expectText(res)).toBe("a.ts:1: TODO fix this\nb.ts:7: TODO elsewhere");
		// Arg-array hygiene is assertable now: the pattern rides an argument slot
		// after "--", never a shell string.
		expect(backend.argvCalls).toEqual([
			{
				cmd: "rg --json --line-number --color=never --hidden -- TODO /work",
				bin: "rg",
				args: ["--json", "--line-number", "--color=never", "--hidden", "--", "TODO", "/work"],
			},
		]);
		expect(backend.calls).toEqual([]); // grep never touches the shell-string seam
		expect(backend.unexpectedCalls).toEqual([]);
	});

	test("no match (rg exit 1, empty stdout) -> 'No matches found'", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [{ match: /^rg --json/, result: { exitCode: 1 } }],
		});
		const res = await grepTool.execute({ pattern: "zzz" }, { rootDir, backend });
		expect(expectText(res)).toBe("No matches found");
	});

	test("missing rg (probe table false) -> the RG_MISSING err before any argv call", async () => {
		const backend = fakeBackend({ dirs: [rootDir], probeResults: { rg: false }, script: [] });
		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("ripgrep (rg) is not installed. Install ripgrep to use the grep tool.");
		expect(backend.argvCalls).toEqual([]); // gated before the spawn
	});

	test("missing search path (no stat seed) -> 'Path not found: …'", async () => {
		const backend = fakeBackend({ probeResults: { rg: true }, script: [] });
		const res = await grepTool.execute({ pattern: "TODO", path: "nope" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("Path not found: /work/nope");
	});

	test("context blocks read through the backend fs (the off-seam fix): context=1 -> path-n- lines", async () => {
		const backend = fakeBackend({
			files: { "/work/ctx.txt": "alpha\nTODO beta\ngamma\n" },
			probeResults: { rg: true },
			script: [
				{ match: /^rg --json/, result: { exitCode: 0 }, stdout: `${rgMatch("/work/ctx.txt", 2, "TODO beta")}\n` },
			],
		});
		const res = await grepTool.execute({ pattern: "TODO", context: 1 }, { rootDir, backend });
		const text = expectText(res);
		// Match line (line 2) uses `path:n:`; context lines use `path-n-` — and the
		// context text came from backend.fs.readFile, not a host read.
		expect(text).toContain("ctx.txt:2: TODO beta");
		expect(text).toContain("ctx.txt-1- alpha");
		expect(text).toContain("ctx.txt-3- gamma");
	});

	test("context on an unreadable file -> '(unable to read file)' placeholder", async () => {
		// No file seeded: backend.fs.readFile errs (the fake errs where the real fs
		// errs), so the block degrades to the placeholder row.
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [
				{ match: /^rg --json/, result: { exitCode: 0 }, stdout: `${rgMatch("/work/gone.ts", 1, "TODO x")}\n` },
			],
		});
		const res = await grepTool.execute({ pattern: "TODO", context: 1 }, { rootDir, backend });
		expect(expectText(res)).toBe("gone.ts:1: (unable to read file)");
	});

	test("limit aborts at the cap: capped rows + the limit-reached notice (AbortController path, no spawn)", async () => {
		// Three matches stream in; the cap fires at 2 and aborts (the fake has no
		// child to kill, but the capping/framing must hold regardless).
		const ndjson = [1, 2, 3].map((n) => rgMatch("/work/many.ts", n, `match ${n}`)).join("\n");
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [
				{
					match: /^rg --json/,
					result: { exitCode: 0 },
					stdout: `${ndjson}\n`,
				},
			],
		});
		const res = await grepTool.execute({ pattern: "match", limit: 2 }, { rootDir, backend });
		const text = expectText(res);
		const rows = text.split("\n").filter((line) => line.startsWith("many.ts:"));
		expect(rows).toEqual(["many.ts:1: match 1", "many.ts:2: match 2"]);
		expect(text).toContain("2 matches limit reached. Use limit=4 for more, or refine pattern");
	});

	test("NDJSON split across stdout chunks parses correctly (partial-line carry between chunks)", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [
				{
					match: /^rg --json/,
					result: { exitCode: 0 },
					stdout: `${rgMatch("/work/a.ts", 1, "TODO x")}\n${rgMatch("/work/b.ts", 1, "TODO y")}\n`,
					chunkDelayMs: 1,
				},
			],
		});
		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend });
		// chunkDelayMs splits the output into 3 contiguous chunks — each JSON line
		// straddles chunk boundaries, so the caller's incremental framing reassembles.
		expect(expectText(res)).toBe("a.ts:1: TODO x\nb.ts:1: TODO y");
	});

	test("non-(0|1) rg exit with stderr -> err carrying rg's stderr", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { rg: true },
			script: [{ match: /^rg --json/, result: { exitCode: 2 }, stderr: "rg: bad pattern\n" }],
		});
		const res = await grepTool.execute({ pattern: "TODO" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("rg: bad pattern");
	});
});
