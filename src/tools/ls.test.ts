import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { lsTool } from "./ls.ts";
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

describe("lsTool", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-ls-"));
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("lists entries alphabetically (case-insensitive) with '/' on directories and dotfiles", async () => {
		mkdirSync(join(rootDir, "Bravo")); // dir, uppercase-first — must sort by lowercase
		mkdirSync(join(rootDir, "alpha")); // dir, lowercase — sorts before 'Bravo'
		writeFileSync(join(rootDir, "charlie.txt"), ""); // file, no suffix
		writeFileSync(join(rootDir, ".dotfile"), ""); // dotfile — must appear
		mkdirSync(join(rootDir, ".hiddendir")); // hidden dir — must appear with '/'

		const res = await lsTool.execute({ path: "." }, { rootDir, backend });
		const text = expectText(res);
		const lines = text.split("\n");

		// Dotfiles are included (never filtered), directories get a trailing '/'.
		expect(lines).toContain(".dotfile");
		expect(lines).toContain(".hiddendir/");
		expect(lines).toContain("alpha/");
		expect(lines).toContain("Bravo/");
		expect(lines).toContain("charlie.txt");
		// Case-insensitive alphabetical: 'alpha' (a) < 'Bravo' (b) < 'charlie' (c).
		expect(lines.indexOf("alpha/")).toBeLessThan(lines.indexOf("Bravo/"));
		expect(lines.indexOf("Bravo/")).toBeLessThan(lines.indexOf("charlie.txt"));
	});

	test("empty directory -> '(empty directory)'", async () => {
		const res = await lsTool.execute({ path: "." }, { rootDir, backend });
		expect(expectText(res)).toBe("(empty directory)");
	});

	test("listing a file -> err 'Not a directory'", async () => {
		writeFileSync(join(rootDir, "afile"), "");
		const res = await lsTool.execute({ path: "afile" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe(`Not a directory: ${join(rootDir, "afile")}`);
		}
	});

	test("missing path -> err 'Path not found'", async () => {
		const res = await lsTool.execute({ path: "nope" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe(`Path not found: ${join(rootDir, "nope")}`);
		}
	});

	test("hitting the entry limit appends the entries-limit-reached notice", async () => {
		// 5 entries; default limit 500. Use an explicit small limit to exercise the
		// exact same `entryLimitReached` branch deterministically (find.test.ts uses
		// the same small-limit approach rather than minting 1000 files).
		for (const name of ["d", "b", "e", "a", "c"]) {
			writeFileSync(join(rootDir, name), "");
		}

		const res = await lsTool.execute({ path: ".", limit: 3 }, { rootDir, backend });
		const text = expectText(res);

		// Only the first 3 (sorted: a, b, c) are listed, then the notice.
		const listed = text.split("\n").filter((line) => line && !line.startsWith("["));
		expect(listed).toEqual(["a", "b", "c"]);
		expect(text).toContain("3 entries limit reached");
		expect(text).toContain("Use limit=6 for more");
	});

	test("byte cap (>50KB) appends the byte-limit notice without the entry notice", async () => {
		// Fewer than the 500 entry limit, but enough long-named entries that the
		// joined output exceeds DEFAULT_MAX_BYTES (50KB) — isolates the byte-cap
		// branch from the entry-cap branch.
		for (let i = 0; i < 300; i++) {
			writeFileSync(join(rootDir, `${"x".repeat(200)}-${i}`), "");
		}

		const res = await lsTool.execute({ path: "." }, { rootDir, backend });
		const text = expectText(res);

		expect(text).toContain("50.0KB limit reached");
		// 300 entries < default 500 limit, so the entry notice must NOT fire.
		expect(text).not.toContain("entries limit reached");
	});
});

// Spec 23: the shaping suite — same tool, FakeBackend instead of LocalBackend, so
// the file/dir shapes, empty dir, error messages, and the limit notice are pinned
// with zero real-fs access and zero process spawns. Seeded files auto-register
// their ancestor dirs, so `sub/inner.txt` implies `/work/sub` exists.
describe("lsTool via FakeBackend", () => {
	test("happy path: files and dirs, dotfiles included, '/' on dirs, case-insensitive sort", async () => {
		const fake = fakeBackend({
			files: { "/work/b.txt": "x", "/work/.dot": "", "/work/sub/inner.txt": "y" },
			dirs: ["/work/Alpha"],
		});

		const res = await lsTool.execute({ path: "." }, { rootDir: "/work", backend: fake });

		const lines = expectText(res).split("\n");
		expect(lines).toEqual([".dot", "Alpha/", "b.txt", "sub/"]);
	});

	test("empty dir → '(empty directory)'", async () => {
		const fake = fakeBackend({ dirs: ["/work/empty"] });

		const res = await lsTool.execute({ path: "empty" }, { rootDir: "/work", backend: fake });

		expect(expectText(res)).toBe("(empty directory)");
	});

	test("listing a file → err 'Not a directory' with the resolved path", async () => {
		const fake = fakeBackend({ files: { "/work/afile": "" } });

		const res = await lsTool.execute({ path: "afile" }, { rootDir: "/work", backend: fake });

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe("Not a directory: /work/afile");
		}
	});

	test("missing path → err 'Path not found' with the resolved path", async () => {
		const fake = fakeBackend({ dirs: ["/work"] });

		const res = await lsTool.execute({ path: "nope" }, { rootDir: "/work", backend: fake });

		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toBe("Path not found: /work/nope");
		}
	});

	test("small limit → first N sorted entries + the entries-limit notice", async () => {
		const fake = fakeBackend({
			files: Object.fromEntries(["d", "b", "e", "a", "c"].map((name) => [`/work/${name}`, ""])),
		});

		const res = await lsTool.execute({ path: ".", limit: 3 }, { rootDir: "/work", backend: fake });
		const text = expectText(res);

		// Only the first 3 (sorted: a, b, c) are listed, then the notice.
		const listed = text.split("\n").filter((line) => line && !line.startsWith("["));
		expect(listed).toEqual(["a", "b", "c"]);
		expect(text).toContain("3 entries limit reached");
		expect(text).toContain("Use limit=6 for more");
	});
});
