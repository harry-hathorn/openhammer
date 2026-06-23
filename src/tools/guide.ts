/**
 * The `guide` tool (spec 18, Phase A) — a single orientation tool the client reads
 * once. It returns concise markdown built from the working root: what OpenHammer is
 * (a stateless, no-LLM tool executor), the **working-root contract** (paths resolve
 * under `MCP_ROOT_DIR`; `bash` cwd does not persist; use absolute paths), the 7
 * capability tools one line each, and the workflow notes (bounded output, no memory
 * between calls, jail `bash` in a container).
 *
 * This is spec 18's chosen alternative to bloating every capability tool's
 * description with a working-root line — definitions stay lean and precise, and the
 * guide evolves as the MCP grows. The 7 capability tools are unchanged; `guide` is
 * an 8th orientation entry (registered first so "read this first" is the list order).
 *
 * {@link buildGuide} is the pure markdown builder (exported so the contract is
 * unit-tested without driving the tool); `execute` wraps it in a single text `ToolOk`.
 */
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { ok } from "./result.ts";

/**
 * Build the orientation markdown. Pure — `rootDir` is the only input and is
 * interpolated as the absolute working root (it arrives already resolved via
 * `config.rootDir`, which resolves `MCP_ROOT_DIR` absolute at boot).
 */
export function buildGuide(rootDir: string): string {
	return [
		"# OpenHammer",
		"",
		"OpenHammer is a stateless MCP server with **no LLM** — it only executes tools. It does not think, plan, or remember; the agent loop lives in the client you connected from.",
		"",
		"## Working root",
		"",
		`All file paths resolve under **\`${rootDir}\`**. \`bash\` runs here, but its working directory **does not persist** between calls — every call resets to the root. **Use absolute paths** to avoid landing in the wrong directory.`,
		"",
		"## Tools",
		"",
		"- `read` — read a text or image file (use offset/limit for large files).",
		"- `bash` — run a shell command in the working root (cwd resets each call).",
		"- `edit` — replace exact text blocks in a file.",
		"- `write` — create or overwrite a file (creates parent directories).",
		"- `grep` — search file contents for a pattern (ripgrep).",
		"- `find` — find files by glob pattern (fd).",
		"- `ls` — list directory entries.",
		"",
		"## Notes",
		"",
		"- Output is bounded: each tool truncates large results, and an oversized whole response is replaced with a single `response_too_large` notice.",
		"- There is no memory between calls — state lives in files under the working root, not in the server.",
		"- `bash` can reach anything the OS user can. Run OpenHammer in a container to jail it.",
		"",
		"_This guide evolves as OpenHammer grows._",
	].join("\n");
}

export const guideTool: ToolModule = {
	name: "guide",
	description: "Read this first — how OpenHammer's tools work + your working root.",
	inputSchema: {
		type: "object",
		properties: {},
	},
	async execute(_args, rootDir) {
		const toolOk: ToolOk = { content: [{ type: "text", text: buildGuide(rootDir) }] };
		return ok(toolOk);
	},
};
