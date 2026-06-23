/**
 * Cross-cutting acceptance tests for the `guide` tool + the working-root
 * contract (spec 18, Phase A — checkbox 18b). These assert the spec's Phase A
 * acceptance criteria **across the registry**, complementing the per-module
 * unit tests: `guide.test.ts` (the guide module), `index.test.ts`/`server.test.ts`
 * (names/order). They are deliberately cross-cutting — each drives the real
 * tool modules through `createAllTools` (the rootDir-binding the `tools/list` +
 * `CallTool` handlers consume):
 *
 *   - `guide` returns the resolved working root + the "absolute paths / bash
 *     cwd does not persist" contract (spec 18 line 24).
 *   - `tools/list` (the registry) includes `guide` first, then the 7 capability
 *     tools — the "7 + guide" identity (spec 18 line 23).
 *   - the 7 capability tool descriptions are **unchanged** (pinned to the v1
 *     baseline so any edit — including a working-root-line bloat — fails loudly)
 *     and **lean** (none carries the working-root contract; that lives in
 *     `guide` alone — spec 18 line 16).
 *   - fs-tool results surface the **absolute resolved path**: a wrong relative
 *     path resolves under the root and the absolute path appears in the error
 *     (`Path not found: <abs>`), so a wrong-dir op is visible, not silent
 *     (spec 18 line 20 / 25).
 *
 * Tier-0: drives the real tool modules + `createAllTools` directly (no Fastify,
 * no network). Hermetic — no files are created, so a non-existent root string
 * suffices (the missing-path errors never touch the filesystem beyond `access`).
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { ToolOk } from "../mcp/types.ts";
import { createAllTools } from "./index.ts";

// The root is purely an interpolation target (guide) / a resolution base (the
// fs errors) — nothing is written or read, so a constant non-existent path is
// fine and keeps the suite hermetic without temp-dir machinery.
const ROOT = "/srv/openhammer-root";

/** Unwrap a successful Result; throw (failing the test) if it was an err. */
function unwrap<T extends ToolOk>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!r.ok) {
		throw new Error(`expected ok, got err: ${r.error.message}`);
	}
	return r.value;
}

/** The concatenated text of a `ToolOk`'s content blocks. */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	return ok.content.map((c) => (c.type === "text" ? c.text : "")).join("");
}

/** The 7 capability tools (everything in the registry except `guide`). */
const CAPABILITY_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * The v1 baseline of the 7 capability tool descriptions — pinned here so any
 * change (wording, a truncation constant, or — the spec's specific worry — a
 * working-root-line bloat) fails this test loudly. The interpolated constants
 * are resolved to their v1 values (DEFAULT_MAX_LINES 2000 / DEFAULT_MAX_BYTES
 * 50KB; per-tool limits: grep 100, find 1000, ls 500; GREP_MAX_LINE_LENGTH 500).
 * If a truncation constant legitimately changes, update the source description
 * and this baseline together (the "unchanged" guard then re-pins consciously).
 */
const EXPECTED_DESCRIPTIONS: Record<string, string> = {
	read: "Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.",
	bash: "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
	edit: "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
	write: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	grep: "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
	find: "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
	ls: "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
};

/**
 * Tokens that identify the working-root contract — the text `guide` carries so
 * the capability descriptions don't have to (spec 18 line 16: "lean — no
 * per-tool working-root line"). Checked case-insensitively; none should appear
 * in any capability description.
 */
const WORKING_ROOT_TOKENS = ["working root", "does not persist", "resets to the root", "mcp_root_dir"];

describe("spec 18 — guide + working-root contract (cross-cutting acceptance)", () => {
	describe("guide tool", () => {
		it("returns the resolved working root + the contract through the registry", async () => {
			const entries = createAllTools(ROOT);
			const guide = entries.find((e) => e.tool.name === "guide");
			if (!guide) throw new Error("guide entry missing");

			const md = textOf(await guide.handler({}));

			// The resolved working root is embedded verbatim.
			expect(md).toContain(ROOT);
			// The contract: bash cwd does not persist; use absolute paths.
			expect(md).toContain("does not persist");
			expect(md).toContain("absolute paths");
		});
	});

	describe("tools/list (registry) shape", () => {
		it("includes guide first, then the 7 capability tools", () => {
			const entries = createAllTools(ROOT);
			expect(entries).toHaveLength(8);
			// `guide` leads — "read this first" is the list order (spec 18 line 16).
			expect(entries[0]?.tool.name).toBe("guide");
			// The 7 capability tools follow, in stable registry order.
			expect(entries.slice(1).map((e) => e.tool.name)).toEqual([...CAPABILITY_NAMES]);
		});
	});

	describe("capability tool descriptions are unchanged + lean", () => {
		// `entry.tool.description` is the SDK `Tool.description` (optional), so
		// narrow it to `string` at the boundary — the modules always set one.
		const descriptionOf = (name: string): string => {
			const entry = createAllTools(ROOT).find((e) => e.tool.name === name);
			if (!entry) throw new Error(`missing ${name} entry`);
			const desc = entry.tool.description;
			if (typeof desc !== "string") throw new Error(`missing description for ${name}`);
			return desc;
		};

		it("the registry surfaces exactly the 7 capability tools, pinned to the v1 baseline", () => {
			const names = createAllTools(ROOT)
				.filter((e) => e.tool.name !== "guide")
				.map((e) => e.tool.name);
			expect(names).toEqual([...CAPABILITY_NAMES]);
			for (const name of CAPABILITY_NAMES) {
				expect(descriptionOf(name), `description for ${name}`).toBe(EXPECTED_DESCRIPTIONS[name]);
			}
		});

		it("none carries the working-root contract (lean — guide owns that)", () => {
			for (const name of CAPABILITY_NAMES) {
				const lower = descriptionOf(name).toLowerCase();
				for (const token of WORKING_ROOT_TOKENS) {
					expect(lower, `${name} description must not contain "${token}"`).not.toContain(token);
				}
			}
		});
	});

	describe("fs results surface the absolute resolved path", () => {
		it("ls: a missing relative path resolves under the root in the error", async () => {
			const ls = createAllTools(ROOT).find((e) => e.tool.name === "ls");
			if (!ls) throw new Error("ls entry missing");

			const r = await ls.handler({ path: "no-such-dir" });
			expect(r.ok).toBe(false);
			if (!r.ok) {
				// The relative arg resolved to the absolute path under ROOT — a
				// wrong-dir op is visible in the result, not silent (spec 18 line 20).
				expect(r.error.message).toContain("Path not found:");
				expect(r.error.message).toContain(join(ROOT, "no-such-dir"));
			}
		});

		it("grep: a missing relative path resolves under the root in the error", async () => {
			const grep = createAllTools(ROOT).find((e) => e.tool.name === "grep");
			if (!grep) throw new Error("grep entry missing");

			const r = await grep.handler({ pattern: "zzz", path: "no-such-dir" });
			expect(r.ok).toBe(false);
			if (!r.ok) {
				// grep's unit test only pins the "Path not found:" prefix; this
				// asserts the absolute resolved path is interpolated too.
				expect(r.error.message).toContain("Path not found:");
				expect(r.error.message).toContain(join(ROOT, "no-such-dir"));
			}
		});
	});
});
