/**
 * The `read` tool — text path only (spec 03, item 03a).
 *
 * Ports pi's `read` execute logic verbatim for text files, stripping everything
 * that is UI/agent-coupled: `resolveReadPath` (→ `resolveToCwd`), the compact-read
 * classification, `getReadmePath`, theme/syntax-highlight rendering, image resize,
 * and magic-byte MIME detection. The image-content-block path lands in 03b; this
 * module ships the text path: `resolveToCwd` → `access(R_OK)` → UTF-8 read →
 * `split("\n")` → offset/limit window → `truncateHead` with continuation/limit
 * notices. Output is raw content — **no line-number prefixes** (locked: match pi).
 *
 * Expected failures (missing/unreadable file, offset past EOF) return `err`, never
 * throw — the MCP `CallTool` handler (spec 12) is the single narrowing point. File
 * I/O goes through `io.ts` Result-wrappers, so the body has zero try/catch.
 */
import { constants } from "node:fs";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { access, readFile } from "./io.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok } from "./result.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "./truncate.ts";

export const readTool: ToolModule = {
	name: "read",
	description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to read (relative or absolute)" },
			offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
			limit: { type: "number", description: "Maximum number of lines to read" },
		},
		required: ["path"],
	},
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const path = args.path;
		if (typeof path !== "string") {
			return err(new Error("read requires a string 'path' argument"));
		}
		const offset = typeof args.offset === "number" ? args.offset : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;

		const absolutePath = resolveToCwd(path, rootDir);

		// Missing/unreadable → err (Result from io.ts; no throw in the body).
		const accessRes = await access(absolutePath, constants.R_OK);
		if (!accessRes.ok) {
			return err(accessRes.error);
		}
		const bufferRes = await readFile(absolutePath);
		if (!bufferRes.ok) {
			return err(bufferRes.error);
		}

		// --- Text path (verbatim from pi: read.ts, text branch) ---
		const allLines = bufferRes.value.toString("utf-8").split("\n");
		const totalFileLines = allLines.length;
		// offset is 1-indexed input → 0-indexed array access.
		const startLine = offset ? Math.max(0, offset - 1) : 0;
		const startLineDisplay = startLine + 1;
		if (startLine >= allLines.length) {
			return err(new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`));
		}
		let selectedContent: string;
		let userLimitedLines: number | undefined;
		// Honor a user limit first; otherwise `truncateHead` decides the cap.
		if (limit !== undefined) {
			const endLine = Math.min(startLine + limit, allLines.length);
			selectedContent = allLines.slice(startLine, endLine).join("\n");
			userLimitedLines = endLine - startLine;
		} else {
			selectedContent = allLines.slice(startLine).join("\n");
		}
		const truncation = truncateHead(selectedContent);
		let outputText: string;
		if (truncation.firstLineExceedsLimit) {
			// First line alone exceeds the byte limit. Point the caller at a bash fallback.
			const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
			outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
		} else if (truncation.truncated) {
			// Truncation occurred. Build an actionable continuation notice.
			const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
			const nextOffset = endLineDisplay + 1;
			outputText = truncation.content;
			if (truncation.truncatedBy === "lines") {
				outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
			} else {
				outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
			}
		} else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
			// User-specified limit stopped early, but the file still has more content.
			const remaining = allLines.length - (startLine + userLimitedLines);
			const nextOffset = startLine + userLimitedLines + 1;
			outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
		} else {
			// No truncation and no remaining user-limited content.
			outputText = truncation.content;
		}

		const toolOk: ToolOk = { content: [{ type: "text", text: outputText }] };
		return ok(toolOk);
	},
};
