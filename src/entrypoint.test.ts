import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { isMainEntry } from "./entrypoint.ts";

/**
 * Regression: npm installs the bin as a symlink, so `process.argv[1]` is the
 * symlink path while `import.meta.url` is the real file. The entrypoint guard
 * must resolve the symlink (via `realpathSync`) or the installed binary never
 * dispatches — every command silently exits 0.
 */
describe("isMainEntry", () => {
	it("matches when argv[1] is a symlink to the running module (the npm-bin case)", () => {
		const dir = mkdtempSync(join(tmpdir(), "oh-entry-"));
		try {
			const real = join(dir, "cli.js");
			const link = join(dir, "openhammer");
			writeFileSync(real, "");
			symlinkSync(real, link);
			expect(isMainEntry(link, pathToFileURL(real).href)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("matches when argv[1] is the real path directly", () => {
		const dir = mkdtempSync(join(tmpdir(), "oh-entry-"));
		try {
			const real = join(dir, "main.js");
			writeFileSync(real, "");
			expect(isMainEntry(real, pathToFileURL(real).href)).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("returns false when argv[1] is undefined (imported by a test/runner)", () => {
		expect(isMainEntry(undefined, "file:///x/cli.js")).toBe(false);
	});

	it("returns false when argv[1] does not exist (no throw)", () => {
		expect(isMainEntry(join(tmpdir(), "oh-no-such-file"), "file:///x/cli.js")).toBe(false);
	});

	it("returns false when argv[1] resolves to a different file than the module", () => {
		const dir = mkdtempSync(join(tmpdir(), "oh-entry-"));
		try {
			const a = join(dir, "a.js");
			const b = join(dir, "b.js");
			writeFileSync(a, "");
			writeFileSync(b, "");
			expect(isMainEntry(a, pathToFileURL(b).href)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
