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
 * boundary note. Spec 29 adds the third variant: agent mode's backend reports kind
 * "agent" (the same vm-shaped session, informational label — the mode is known at
 * `prepareVmBoot` and relabeled there), and the guide appends the six doctrine
 * blocks of the supervision contract under `## Supervising the agent` on top of the
 * byte-identical vm-variant text.
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
 * The six doctrine blocks of the supervision contract (spec 29), in teaching
 * order — agent mode's guide copy over the existing 8 tools (zero new tools).
 * Honest per spec 22's measured amendments: `--inline` is the headless verb
 * (the default terminal form needs the compositor — exit 230), grim needs the
 * session env pinned (bare ssh: "failed to create display"), and a raw shot is
 * ~1.1 MB at 1280x720 — 212% of MAX_RESPONSE_BYTES — so the downscale before
 * `read` is stated plainly (the transform decision itself is a separate
 * follow-up, spec 22 finding 4).
 */
const AGENT_SUPERVISION_BLOCKS: readonly string[] = [
	"- **Default verb:** `omarchy agent prompt --inline '<task>'` through plain `bash` — don't-stop-to-ask, structured stdout + exit code. The default (no `--inline`) form needs the compositor and fails fast headless (exit 230).",
	"- **TUI agents via tmux** — the session `agent` is already running (220x50). Read with `tmux capture-pane -p -S -500 -t agent`; prompt with `tmux send-keys -t agent -l -- '<text>'` then `tmux send-keys -t agent Enter`; interrupt with `tmux send-keys -t agent C-c`. Double-typed input is worse than late input — capture before re-sending.",
	"- **Visual proof:** `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/shot.png`, then `read` it. Shots run ~1.1 MB at 1280x720 — over the 512 KB response cap — so downscale/re-encode in the guest (ImageMagick `magick`) before reading, or the response is replaced by `response_too_large`.",
	"- **Evidence before verdict:** an agent's claim of done counts only when the exit code and the captured pane/screen agree.",
	"- **Serial evidence** for compositor-touching missions: `echo <password> | sudo -S sh -c 'journalctl -f -o short-precise > /dev/ttyS0 &'` — every Hyprland/logind line lands in the session's serial log (readable via the dashboard's Serial tail).",
	"- **Permission posture:** the inner agent runs WITHOUT `--dangerously-skip-permissions` by default — that flag is the operator's `MCP_VM_AGENT_CMD` opt-in.",
];

/**
 * Build the orientation markdown. Pure — the text is a function of two inputs.
 * `rootDir` is interpolated as the absolute working root (it arrives already
 * resolved via `config.rootDir`, which resolves `MCP_ROOT_DIR` absolute at
 * boot; in a VM mode it is already the guest path, so the working-root line
 * names the guest root verbatim). `kind` selects the variant: `"local"` (the
 * default — every pre-27 caller) keeps the container line, `"vm"` (a VM-mode
 * boot's backend) replaces it with the VM boundary line, and `"agent"`
 * (spec 29) is the vm variant byte-for-byte plus the six supervision doctrine
 * blocks under `## Supervising the agent`.
 */
export function buildGuide(rootDir: string, kind: ToolBackend["kind"] = "local"): string {
	// The variant's only word-level difference (spec 27: "the VM is the boundary —
	// bash reaches anything in the guest, nothing on the host; all paths are guest
	// paths" — three clauses, guide's own bullet voice).
	const isolationNote =
		kind === "local"
			? "- `bash` can reach anything the OS user can. Run OpenHammer in a container to jail it."
			: "- The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths.";
	// The agent variant appends the supervision section after the vm text's last
	// shared line; both other variants append nothing (byte-identical to 27g).
	const supervision = kind === "agent" ? ["", "## Supervising the agent", "", ...AGENT_SUPERVISION_BLOCKS] : [];
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
		...supervision,
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
		// The backend kind is the mode signal (specs 27/29): LocalBackend reports
		// "local", a VM-mode boot's DelegatingBackend reports "vm" or "agent" (the
		// mode is known at prepareVmBoot and relabeled there). The variant switch
		// lives in buildGuide; ToolContext stays {rootDir, backend}.
		const toolOk: ToolOk = { content: [{ type: "text", text: buildGuide(ctx.rootDir, ctx.backend.kind) }] };
		return ok(toolOk);
	},
};
