/**
 * The `write` tool — create or overwrite a file (spec 05).
 *
 * Ports pi's `write` execute logic verbatim, stripping everything that is
 * UI/agent-coupled: `pi-tui`, `ToolDefinition`/render, `withFileMutationQueue`
 * (pi's per-file serialization), and the `WriteOperations` interface. The body
 * is two steps — `resolveToCwd` → `mkdir(dir, { recursive: true })` →
 * `writeFile(path, content, "utf-8")` — and reports `Successfully wrote
 * ${content.length} bytes to ${path}` on success, where `path` is the original
 * argument (relative or absolute), not the resolved absolute path (matches pi).
 *
 * Expected failures (uncreatable parent, permission, target is a directory)
 * return `err`, never throw — the MCP `CallTool` handler (spec 12) is the single
 * narrowing point. File I/O goes through `io.ts` Result-wrappers, so the body
 * has zero try/catch. `fs.writeFile` is already atomic for full overwrites, so
 * the dropped `withFileMutationQueue` is a low-risk edge case (spec 05 decisions).
 *
 * Note: the byte count is the string's UTF-16 length (`content.length`), not its
 * UTF-8 byte length — this is pi fidelity, ported unchanged.
 */
import { dirname } from "node:path";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { mkdir, writeFile } from "./io.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok } from "./result.ts";

export const writeTool: ToolModule = {
	name: "write",
	description:
		"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to write (relative or absolute)" },
			content: { type: "string", description: "Content to write to the file" },
		},
		required: ["path", "content"],
	},
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const path = args.path;
		const content = args.content;
		if (typeof path !== "string") {
			return err(new Error("write requires a string 'path' argument"));
		}
		if (typeof content !== "string") {
			return err(new Error("write requires a string 'content' argument"));
		}

		const absolutePath = resolveToCwd(path, rootDir);
		const dir = dirname(absolutePath);

		// Create parent directories if needed (no-op if they already exist).
		const mkdirRes = await mkdir(dir, { recursive: true });
		if (!mkdirRes.ok) {
			return err(mkdirRes.error);
		}

		// Write the file contents (overwrites if it exists).
		const writeRes = await writeFile(absolutePath, content, "utf-8");
		if (!writeRes.ok) {
			return err(writeRes.error);
		}

		const toolOk: ToolOk = {
			content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
		};
		return ok(toolOk);
	},
};
