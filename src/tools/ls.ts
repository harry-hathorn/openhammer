/**
 * The `ls` tool (spec 09).
 *
 * Ports pi's `ls` execute logic, stripped of every pi-package/TUI/operations
 * seam: `pi-tui`, the render helpers (`formatLsCall`/`formatLsResult`),
 * `typebox` (→ a plain JSON-Schema literal), the `LsOperations` interface
 * (→ direct `node:fs`), the `AbortSignal` plumbing (unreachable in v1 —
 * `ToolModule.execute` carries no signal, mirroring `bash`/`grep`/`find`), and
 * the UI-only `LsToolDetails` side channel (truncation is surfaced as a notice
 * in the content text, not a separate field).
 *
 * Lists a directory's entries under `MCP_ROOT_DIR`: case-insensitive
 * alphabetical sort, `/` suffix on subdirectories, dotfiles included, entries
 * that fail to `stat` skipped. Output is capped at `limit` entries (default
 * 500) and `DEFAULT_MAX_BYTES` (50KB) — whichever hits first — each producing
 * an actionable notice in one bracketed block. No external binary; pure
 * `node:fs` (the only tool besides `read`/`write`/`edit` that touches the fs
 * directly rather than spawning).
 *
 * Expected failures (path missing, not a directory, unreadable dir) return
 * `err`, never throw — the MCP `CallTool` handler (spec 12) is the single
 * narrowing point. The fs calls go through `io.ts` Result-wrappers, so the body
 * has zero try/catch.
 */
import { join } from "node:path";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { exists, readdirSync, statSync } from "./io.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok } from "./result.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 500;

export const lsTool: ToolModule = {
	name: "ls",
	description: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to ${DEFAULT_LIMIT} entries or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Directory to list (default: current directory)" },
			limit: {
				type: "number",
				description: `Maximum number of entries to return (default: ${DEFAULT_LIMIT})`,
			},
		},
	},
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed). Both
		// `path` and `limit` are optional — non-strings fall back to the defaults,
		// matching pi's `Type.Optional`.
		const pathArg = typeof args.path === "string" ? args.path : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;

		const dirPath = resolveToCwd(pathArg || ".", rootDir);
		const effectiveLimit = limit ?? DEFAULT_LIMIT;

		// Missing path → err (pi: `Path not found`). `exists` is checked before
		// `stat` so a missing path yields the clean message rather than ENOENT.
		const existsRes = exists(dirPath);
		if (!existsRes.ok) {
			return err(existsRes.error);
		}
		if (!existsRes.value) {
			return err(new Error(`Path not found: ${dirPath}`));
		}

		// Not a directory → err (pi: `Not a directory`).
		const statRes = statSync(dirPath);
		if (!statRes.ok) {
			return err(statRes.error);
		}
		if (!statRes.value.isDirectory()) {
			return err(new Error(`Not a directory: ${dirPath}`));
		}

		// Read entries (pi: `Cannot read directory` on failure).
		const readRes = readdirSync(dirPath);
		if (!readRes.ok) {
			return err(new Error(`Cannot read directory: ${readRes.error.message}`));
		}

		// Case-insensitive alphabetical sort (verbatim from pi).
		const entries = readRes.value;
		entries.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		// Format entries with a `/` suffix on subdirectories; cap at effectiveLimit.
		// Entries that fail to stat are skipped (pi fidelity: dangling symlinks etc).
		const results: string[] = [];
		let entryLimitReached = false;
		for (const entry of entries) {
			if (results.length >= effectiveLimit) {
				entryLimitReached = true;
				break;
			}
			const entryStat = statSync(join(dirPath, entry));
			if (!entryStat.ok) {
				continue;
			}
			results.push(entry + (entryStat.value.isDirectory() ? "/" : ""));
		}

		if (results.length === 0) {
			return ok({ content: [{ type: "text", text: "(empty directory)" }] });
		}

		// Byte cap only — entry count is already bounded by effectiveLimit
		// (verbatim from pi: maxLines = MAX_SAFE_INTEGER). Build one actionable
		// notice per cap that fired, joined in a single bracketed block.
		const truncation = truncateHead(results.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;
		const notices: string[] = [];
		if (entryLimitReached) {
			notices.push(`${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more`);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (notices.length > 0) {
			output += `\n\n[${notices.join(". ")}]`;
		}

		const toolOk: ToolOk = { content: [{ type: "text", text: output }] };
		return ok(toolOk);
	},
};
