/**
 * The `guide` tool (spec 18, Phase A) — a single orientation tool the client reads
 * once. It returns concise markdown built from the working root: what OpenHammer is
 * (a stateless, no-LLM tool executor), the **working-root contract** (paths resolve
 * under `MCP_ROOT_DIR`; `bash` cwd does not persist; use absolute paths), the 7
 * capability tools one line each, and the workflow notes (bounded output, no memory
 * between calls, jail `bash` in a container).
 *
 * Spec 27 adds one variant: a VM-mode boot (`MCP_VM_MODE=vm|agent`) threads a backend
 * whose `kind` is "vm" (the DelegatingBackend over the guest), and the guide keys off
 * that alone — the working root it names is then the GUEST root (27b: `MCP_ROOT_DIR`
 * is a guest absolute path in VM modes) and the container note becomes the VM
 * boundary note. `agent` mode shares this variant for now; its six doctrine blocks
 * are spec 29.
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
import type { ToolBackend } from "./backend.ts";
import { ok } from "./result.ts";

/**
 * Build the orientation markdown. Pure — the text is a function of two inputs.
 * `rootDir` is interpolated as the absolute working root (it arrives already
 * resolved via `config.rootDir`, which resolves `MCP_ROOT_DIR` absolute at
 * boot; in a VM mode it is already the guest path, so the working-root line
 * names the guest root verbatim). `kind` selects the isolation note: `"local"`
 * (the default — every pre-27 caller) keeps the container line, `"vm"` (a
 * VM-mode boot's backend) replaces it with the VM boundary line. Agent mode
 * reports kind "vm" too and shares the variant (its doctrine blocks are spec 29).
 */
export function buildGuide(rootDir: string, kind: ToolBackend["kind"] = "local"): string {
	// The variant's only word-level difference (spec 27: "the VM is the boundary —
	// bash reaches anything in the guest, nothing on the host; all paths are guest
	// paths" — three clauses, guide's own bullet voice).
	const isolationNote =
		kind === "vm"
			? "- The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths."
			: "- `bash` can reach anything the OS user can. Run OpenHammer in a container to jail it.";
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
		isolationNote,
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
	async execute(_args, ctx) {
		// The backend kind is the mode signal (spec 27): LocalBackend reports "local",
		// a VM-mode boot's DelegatingBackend reports "vm". The variant switch lives in
		// buildGuide; ToolContext stays {rootDir, backend}.
		const toolOk: ToolOk = { content: [{ type: "text", text: buildGuide(ctx.rootDir, ctx.backend.kind) }] };
		return ok(toolOk);
	},
};
