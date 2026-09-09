import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { findTool } from "./find.ts";
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

		const res = await findTool.execute({ pattern: "**/*.ts" }, { rootDir, backend });
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

		const res = await findTool.execute({ pattern: "*.json" }, { rootDir, backend });
		const text = expectText(res);

		// `--glob` (no `--full-path`) matches the basename recursively.
		expect(text).toContain("root.json");
		expect(text).toContain("src/nested.json");
		expect(text).not.toContain("readme.md");
	}, 15000);

	test("no match -> 'No files found matching pattern' (fd exit 0 is not an error)", async () => {
		writeFileSync(join(rootDir, "a.ts"), "");
		const res = await findTool.execute({ pattern: "zzz-none" }, { rootDir, backend });
		expect(expectText(res)).toBe("No files found matching pattern");
	}, 15000);

	test("missing fd (PATH stripped) -> err with install hint", async () => {
		writeFileSync(join(rootDir, "a.ts"), "");
		process.env.PATH = "/nonexistent";

		// Fresh backend on purpose: the shared instance above has `fd` cached as
		// present (spec 23's per-instance probe cache), and a warm cache keeps
		// answering true even with PATH stripped.
		const res = await findTool.execute({ pattern: "*.ts" }, { rootDir, backend: createLocalBackend() });
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

		const res = await findTool.execute({ pattern: "*.ts", limit: 2 }, { rootDir, backend });
		const text = expectText(res);

		const resultLines = text.split("\n").filter((line) => line.endsWith(".ts"));
		expect(resultLines.length).toBe(2);
		expect(text).toContain("2 results limit reached");
	}, 15000);

	test("searching a subdir relativizes paths against that subdir", async () => {
		mkdirSync(join(rootDir, "sub"), { recursive: true });
		writeFileSync(join(rootDir, "sub", "one.ts"), "");
		writeFileSync(join(rootDir, "top.ts"), "");

		const res = await findTool.execute({ pattern: "*.ts", path: "sub" }, { rootDir, backend });
		const text = expectText(res);
		// Searching `sub/` -> paths are relative to `sub`, not the original root.
		expect(text).toContain("one.ts");
		expect(text).not.toContain("top.ts");
		expect(text).not.toContain("sub/");
	}, 15000);
});

// Spec 23f: the runArgv shaping, driven by the scripted FakeBackend — zero
// process spawns, zero host fs (the fd path lines come from the script; the
// capability gate from the fake's probe tables). The real-fd counterparts live
// above.
describe("find via FakeBackend", () => {
	const rootDir = "/work";

	test("scripted fd stdout lines -> relativized POSIX paths; exact argv recorded", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { fd: true },
			script: [{ match: /^fd --glob/, result: { exitCode: 0 }, stdout: "/work/a.ts\n/work/src/nested.ts\n" }],
		});
		const res = await findTool.execute({ pattern: "*.ts" }, { rootDir, backend });
		expect(expectText(res)).toBe("a.ts\nsrc/nested.ts");
		// Arg-array hygiene is assertable now: the pattern rides an argument slot
		// after "--", never a shell string.
		expect(backend.argvCalls).toEqual([
			{
				cmd: "fd --glob --color=never --hidden --max-results 1000 -- *.ts /work",
				bin: "fd",
				args: ["--glob", "--color=never", "--hidden", "--max-results", "1000", "--", "*.ts", "/work"],
			},
		]);
		// Unscripted probeFlag defaults false, so --no-require-git is omitted —
		// the old module-level supportsNoRequireGit gate, now per-instance.
		expect(backend.probeFlagCalls).toEqual([{ bin: "fd", flag: "--no-require-git" }]);
		expect(backend.calls).toEqual([]); // find never touches the shell-string seam
		expect(backend.unexpectedCalls).toEqual([]);
	});

	test("a path-containing pattern gets --full-path and a '**/' prefix (argv construction)", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { fd: true },
			script: [{ match: /^fd --glob/, result: { exitCode: 0 } }],
		});
		const res = await findTool.execute({ pattern: "src/**/*.spec.ts" }, { rootDir, backend });
		expect(expectText(res)).toBe("No files found matching pattern");
		expect(backend.argvCalls).toEqual([
			{
				cmd: "fd --glob --color=never --hidden --max-results 1000 --full-path -- **/src/**/*.spec.ts /work",
				bin: "fd",
				args: [
					"--glob",
					"--color=never",
					"--hidden",
					"--max-results",
					"1000",
					"--full-path",
					"--",
					"**/src/**/*.spec.ts",
					"/work",
				],
			},
		]);
	});

	test("limit-reached notice when the results hit the limit", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { fd: true },
			script: [{ match: /^fd --glob/, result: { exitCode: 0 }, stdout: "/work/f1.ts\n/work/f2.ts\n" }],
		});
		const res = await findTool.execute({ pattern: "*.ts", limit: 2 }, { rootDir, backend });
		const text = expectText(res);
		expect(text.split("\n").filter((line) => line.endsWith(".ts"))).toEqual(["f1.ts", "f2.ts"]);
		expect(text).toContain("2 results limit reached. Use limit=4 for more, or refine pattern");
	});

	test("missing fd (probe table false) -> the FD_MISSING err before any argv call", async () => {
		const backend = fakeBackend({ dirs: [rootDir], probeResults: { fd: false }, script: [] });
		const res = await findTool.execute({ pattern: "*.ts" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("fd is not installed. Install fd to use the find tool.");
		expect(backend.argvCalls).toEqual([]); // gated before the spawn
	});

	test("empty result (fd exit 0, no output) -> 'No files found matching pattern'", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { fd: true },
			script: [{ match: /^fd --glob/, result: { exitCode: 0 } }],
		});
		const res = await findTool.execute({ pattern: "zzz-none" }, { rootDir, backend });
		expect(expectText(res)).toBe("No files found matching pattern");
	});

	test("non-zero exit with no output -> err carrying fd's stderr", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			probeResults: { fd: true },
			script: [{ match: /^fd --glob/, result: { exitCode: 2 }, stderr: "fd: unrecognized option\n" }],
		});
		const res = await findTool.execute({ pattern: "*.ts" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("fd: unrecognized option");
	});
});
