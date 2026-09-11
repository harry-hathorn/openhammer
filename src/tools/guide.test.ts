import { describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { buildGuide, guideTool } from "./guide.ts";

// The `guide` tool is a `ToolModule`; tests drive `execute` directly (Tier-0) and
// the pure `buildGuide` builder. It takes no params and returns a single text block
// of orientation markdown built from the working root (spec 18, Phase A).

const ROOT = "/srv/openhammer-root";
// A guest-flavored root for the vm-variant pins (27b: in a VM mode MCP_ROOT_DIR is a
// guest absolute path — `/home/<guestUser>` by default).
const GUEST_ROOT = "/home/guest";

// One local backend per file (spec 23) — LocalBackend is stateless, matching the
// boot-scoped seam without per-test machinery.
const backend = createLocalBackend();

/** Unwrap a successful Result; throw (failing the test) if it was an err. */
function unwrap<T extends ToolOk>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!r.ok) {
		throw new Error(`expected ok, got err: ${r.error.message}`);
	}
	return r.value;
}

/** The single text block of a `guide` result. */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

describe("buildGuide", () => {
	it("embeds the resolved working root (the working-root contract)", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain(ROOT);
		expect(md).toContain("Working root");
	});

	it("states the working-root contract: paths resolve under the root, bash cwd does not persist, use absolute paths", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("does not persist");
		expect(md).toContain("absolute paths");
	});

	it("describes OpenHammer as a stateless, no-LLM tool executor", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("no LLM");
		expect(md).toContain("stateless");
	});

	it("lists all 7 capability tools, one line each", () => {
		const md = buildGuide(ROOT);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(md).toContain(`\`${name}\``);
		}
	});

	it("carries the workflow notes: bounded output / response_too_large, no memory, container = jail", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("response_too_large");
		expect(md).toContain("no memory between calls");
		expect(md).toContain("container");
	});

	it("ends with the evolvability note", () => {
		expect(buildGuide(ROOT)).toContain("This guide evolves as OpenHammer grows.");
	});

	it("reflects a different root verbatim (rootDir is the only input)", () => {
		const other = "/a/different/abs/root";
		expect(buildGuide(other)).toContain(other);
		expect(buildGuide(other)).not.toContain(ROOT);
	});
});

// The spec-27 vm variant: a VM-mode boot's backend reports kind "vm" (the
// DelegatingBackend over the guest), and the guide responds to that alone — the
// working-root line names the GUEST root (27b reinterprets MCP_ROOT_DIR as a guest
// path) and the container note becomes the VM boundary note. Agent mode is spec
// 29's own variant (kind "agent" — the describe below). The off-mode text is
// byte-pinned below so the local path cannot drift.
describe("buildGuide vm variant (spec 27)", () => {
	it("names the passed rootDir as the guest root in the working-root line", () => {
		const md = buildGuide(GUEST_ROOT, "vm");
		expect(md).toContain(`All file paths resolve under **\`${GUEST_ROOT}\`**`);
		expect(md).not.toContain(ROOT);
	});

	it("replaces the container line with the VM boundary line (the three clauses)", () => {
		const md = buildGuide(GUEST_ROOT, "vm");
		expect(md).toContain(
			"The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths.",
		);
		expect(md).not.toContain("container");
	});

	it("differs from the off-mode guide in exactly one line — the boundary line", () => {
		const off = buildGuide(GUEST_ROOT).split("\n");
		const vm = buildGuide(GUEST_ROOT, "vm").split("\n");
		expect(vm).toHaveLength(off.length);
		const differing = off.flatMap((line, i) => (line === vm[i] ? [] : [{ index: i, off: line, vm: vm[i] }]));
		expect(differing).toEqual([
			{
				index: 22,
				off: "- `bash` can reach anything the OS user can. Run OpenHammer in a container to jail it.",
				vm: "- The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths.",
			},
		]);
	});

	it("off-mode text is byte-identical to the pre-27 pin", () => {
		expect(buildGuide(ROOT)).toBe(
			[
				"# OpenHammer",
				"",
				"OpenHammer is a stateless MCP server with **no LLM** — it only executes tools. It does not think, plan, or remember; the agent loop lives in the client you connected from.",
				"",
				"## Working root",
				"",
				`All file paths resolve under **\`${ROOT}\`**. \`bash\` runs here, but its working directory **does not persist** between calls — every call resets to the root. **Use absolute paths** to avoid landing in the wrong directory.`,
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
			].join("\n"),
		);
	});

	it("vm variant matches its byte pin (guest root named, boundary swapped, all else identical)", () => {
		expect(buildGuide(GUEST_ROOT, "vm")).toBe(
			[
				"# OpenHammer",
				"",
				"OpenHammer is a stateless MCP server with **no LLM** — it only executes tools. It does not think, plan, or remember; the agent loop lives in the client you connected from.",
				"",
				"## Working root",
				"",
				`All file paths resolve under **\`${GUEST_ROOT}\`**. \`bash\` runs here, but its working directory **does not persist** between calls — every call resets to the root. **Use absolute paths** to avoid landing in the wrong directory.`,
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
				"- The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths.",
				"",
				"_This guide evolves as OpenHammer grows._",
			].join("\n"),
		);
	});

	it("execute returns the vm variant when the backend kind is vm (fakeBackend kind seed)", async () => {
		const r = await guideTool.execute({}, { rootDir: GUEST_ROOT, backend: fakeBackend({ kind: "vm" }) });
		expect(r.ok).toBe(true);
		expect(textOf(r)).toBe(buildGuide(GUEST_ROOT, "vm"));
	});

	it("execute keeps the off-mode guide for the default fake (kind local)", async () => {
		const r = await guideTool.execute({}, { rootDir: ROOT, backend: fakeBackend() });
		expect(r.ok).toBe(true);
		expect(textOf(r)).toBe(buildGuide(ROOT));
		expect(textOf(r)).toContain("container");
	});
});

// The spec-29 agent variant: agent mode's DelegatingBackend reports kind "agent"
// (the mode is known at prepareVmBoot and relabeled there — the label is
// informational), and the guide appends the six doctrine blocks of the
// supervision contract under `## Supervising the agent` on top of the
// byte-identical vm-variant text. The block texts carry spec 22's measured
// amendments (the `--inline` headless verb, the pinned-env grim recipe, the
// honest ~1.1 MB size line against the 512 KB cap) and are byte-pinned below so
// the doctrine cannot drift silently.
describe("buildGuide agent variant (spec 29)", () => {
	it("keeps the vm variant's lines byte-for-byte and appends the supervision section at the junction", () => {
		const vm = buildGuide(GUEST_ROOT, "vm").split("\n");
		const agent = buildGuide(GUEST_ROOT, "agent").split("\n");
		// Everything of the vm variant except its trailing evolvability line is a
		// verbatim prefix of the agent variant; the supervision heading follows.
		expect(agent.slice(0, vm.length - 1)).toEqual(vm.slice(0, vm.length - 1));
		expect(agent[vm.length - 1]).toBe("## Supervising the agent");
	});

	it("carries the six blocks' key phrases, honest per spec 22's measured amendments", () => {
		const md = buildGuide(GUEST_ROOT, "agent");
		expect(md).toContain("omarchy agent prompt --inline '<task>'");
		expect(md).toContain("tmux capture-pane -p -S -500 -t agent");
		expect(md).toContain("tmux send-keys -t agent -l --");
		expect(md).toContain("XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/shot.png");
		expect(md).toContain("~1.1 MB at 1280x720");
		expect(md).toContain("response_too_large");
		expect(md).toContain("/dev/ttyS0");
		expect(md).toContain("MCP_VM_AGENT_CMD");
	});

	it("presents the six blocks in teaching order (one lead-in per block, ascending)", () => {
		const md = buildGuide(GUEST_ROOT, "agent");
		let at = -1;
		for (const leadIn of [
			"Default verb:",
			"TUI agents via tmux",
			"Visual proof:",
			"Evidence before verdict:",
			"Serial evidence",
			"Permission posture:",
		]) {
			const index = md.indexOf(leadIn);
			expect(index).toBeGreaterThan(at);
			at = index;
		}
	});

	it("agent variant matches its byte pin (vm text + the six supervision blocks)", () => {
		expect(buildGuide(GUEST_ROOT, "agent")).toBe(
			[
				"# OpenHammer",
				"",
				"OpenHammer is a stateless MCP server with **no LLM** — it only executes tools. It does not think, plan, or remember; the agent loop lives in the client you connected from.",
				"",
				"## Working root",
				"",
				`All file paths resolve under **\`${GUEST_ROOT}\`**. \`bash\` runs here, but its working directory **does not persist** between calls — every call resets to the root. **Use absolute paths** to avoid landing in the wrong directory.`,
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
				"- The VM is the boundary — `bash` reaches anything in the guest, nothing on the host; all paths are guest paths.",
				"",
				"## Supervising the agent",
				"",
				"- **Default verb:** `omarchy agent prompt --inline '<task>'` through plain `bash` — don't-stop-to-ask, structured stdout + exit code. The default (no `--inline`) form needs the compositor and fails fast headless (exit 230).",
				"- **TUI agents via tmux** — the session `agent` is already running (220x50). Read with `tmux capture-pane -p -S -500 -t agent`; prompt with `tmux send-keys -t agent -l -- '<text>'` then `tmux send-keys -t agent Enter`; interrupt with `tmux send-keys -t agent C-c`. Double-typed input is worse than late input — capture before re-sending.",
				"- **Visual proof:** `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/shot.png`, then `read` it. Shots run ~1.1 MB at 1280x720 — over the 512 KB response cap — so downscale/re-encode in the guest (ImageMagick `magick`) before reading, or the response is replaced by `response_too_large`.",
				"- **Evidence before verdict:** an agent's claim of done counts only when the exit code and the captured pane/screen agree.",
				"- **Serial evidence** for compositor-touching missions: `echo <password> | sudo -S sh -c 'journalctl -f -o short-precise > /dev/ttyS0 &'` — every Hyprland/logind line lands in the session's serial log (readable via the dashboard's Serial tail).",
				"- **Permission posture:** the inner agent runs WITHOUT `--dangerously-skip-permissions` by default — that flag is the operator's `MCP_VM_AGENT_CMD` opt-in.",
				"",
				"_This guide evolves as OpenHammer grows._",
			].join("\n"),
		);
	});

	it("execute returns the agent variant when the backend kind is agent (fakeBackend kind seed)", async () => {
		const r = await guideTool.execute({}, { rootDir: GUEST_ROOT, backend: fakeBackend({ kind: "agent" }) });
		expect(r.ok).toBe(true);
		expect(textOf(r)).toBe(buildGuide(GUEST_ROOT, "agent"));
	});
});

describe("guideTool", () => {
	it("has the guide shape: name, 'Read this first' description, empty object schema", () => {
		expect(guideTool.name).toBe("guide");
		expect(guideTool.description).toContain("Read this first");
		expect(guideTool.inputSchema.type).toBe("object");
		// `guide` takes no parameters — an empty properties object (no required).
		expect(guideTool.inputSchema.properties).toEqual({});
	});

	it("execute returns ok with a single text block equal to buildGuide(rootDir)", async () => {
		const r = await guideTool.execute({}, { rootDir: ROOT, backend });
		expect(r.ok).toBe(true);
		expect(textOf(r)).toBe(buildGuide(ROOT));
	});

	it("execute is rootDir-driven and ignores any args (no params)", async () => {
		// The handler forwards `args ?? {}`; guide must not choke on stray args.
		const r = await guideTool.execute({ unexpected: "ignored" }, { rootDir: ROOT, backend });
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(textOf(r)).toContain(ROOT);
		}
	});
});
