import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { expandPath, resolveToCwd } from "./path-utils.ts";

// Pin the home directory so ~ expansion is deterministic (spec acceptance:
// resolveToCwd("~/x","/root") must equal /root/x regardless of the host's real home).
vi.mock("node:os", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:os")>();
	return { ...actual, homedir: () => "/root" };
});

describe("expandPath", () => {
	it("expands ~ to the home directory", () => {
		expect(expandPath("~")).toBe("/root");
	});

	it("expands ~/path to a path under the home directory", () => {
		expect(expandPath("~/Documents/file.txt")).toBe("/root/Documents/file.txt");
	});

	it("returns a plain relative path unchanged", () => {
		expect(expandPath("relative/file.txt")).toBe("relative/file.txt");
	});

	it("normalizes unicode spaces to regular spaces", () => {
		const nbsp = String.fromCharCode(0x00a0);
		expect(expandPath(`file${nbsp}name.txt`)).toBe("file name.txt");
	});

	it("strips a leading @ prefix", () => {
		expect(expandPath("@~/x")).toBe("/root/x");
	});
});

describe("resolveToCwd", () => {
	it("expands ~ and returns the absolute home-relative path (~/x under /root -> /root/x)", () => {
		expect(resolveToCwd("~/x", "/root")).toBe("/root/x");
	});

	it("resolves a relative path under cwd", () => {
		expect(resolveToCwd("relative/file.txt", "/some/cwd")).toBe(resolve("/some/cwd", "relative/file.txt"));
	});

	it("passes an absolute path through unchanged", () => {
		expect(resolveToCwd("/absolute/path/file.txt", "/some/cwd")).toBe("/absolute/path/file.txt");
	});
});
