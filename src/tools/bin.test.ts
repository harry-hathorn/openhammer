import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isToolAvailable } from "./bin.ts";

describe("isToolAvailable", () => {
	// Snapshot/restore PATH so the stripped-path case can't poison sibling tests
	// (vitest runs a file's tests in one process; `isToolAvailable` resolves via
	// the inherited `process.env.PATH`).
	let savedPath: string | undefined;

	beforeEach(() => {
		savedPath = process.env.PATH;
	});

	afterEach(() => {
		if (savedPath === undefined) {
			delete process.env.PATH;
		} else {
			process.env.PATH = savedPath;
		}
	});

	it("returns true for a binary that resolves in PATH (node)", () => {
		// `node` is always present — vitest runs under it.
		expect(isToolAvailable("node")).toBe(true);
	});

	it("returns false for a binary name that does not exist", () => {
		expect(isToolAvailable("openhammer-definitely-not-a-real-binary-xyz")).toBe(false);
	});

	it("returns false when PATH is stripped (a present binary no longer resolves)", () => {
		// Point PATH at a nonexistent directory so `node` can't resolve, matching
		// the spec's "rg uninstalled (PATH stripped)" acceptance path.
		process.env.PATH = "/nonexistent";
		expect(isToolAvailable("node")).toBe(false);
	});
});
