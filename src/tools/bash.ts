/**
 * The `bash` tool (spec 04; execution via the backend seam, spec 23).
 *
 * Ports pi's `bash` execute logic, stripped of all pi-package/TUI/operations
 * coupling. The spawn itself is the backend's business — `ctx.backend.runShell`
 * spawns `[shell, "-c", command]` at `ctx.rootDir` (LocalBackend is the verbatim
 * lift of this module's old private spawn: own process group, merged
 * stdout+stderr in arrival order, group SIGKILL on timeout). This module only
 * shapes the resolved `ShellResult` (pi threw on non-zero exit / timeout; here
 * those become `err(...)` — the MCP `CallTool` handler (spec 12) is the single
 * narrowing point):
 *
 * - `{ exitCode: 0, timedOut: false }` → ok text (`"(no output)"` when empty).
 * - `{ exitCode: N > 0, timedOut: false }` → err `Command exited with code N`
 *   appended to the captured output.
 * - `{ exitCode: -1, timedOut: true }` → err `Command timed out after N
 *   seconds` (N = the requested `timeout`), with the empty-output placeholder
 *   `""` rather than `"(no output)"` — pi parity.
 * - `{ exitCode: -1, timedOut: false }` (signal death, no timeout) → **ok**.
 *   The old local code saw a `null` exit code here and its
 *   `exitCode !== 0 && exitCode !== null` guard skipped the err, so `-1` (the
 *   backend's "no exit code" sentinel) maps onto that branch to stay
 *   byte-identical. Unreachable through OpenHammer's own paths — the only
 *   killer bash starts is the timeout, which reports `timedOut` — so an
 *   external kill is the sole producer, and it already produced ok.
 * - Rejection (spawn `error`, e.g. the shell binary is missing — the only
 *   remaining throw path) → the same final `err(e)` narrowing the old catch
 *   produced.
 *
 * Output streams into one `OutputAccumulator` whose overflow temp file is
 * minted by `ctx.backend.overflowPath("openhammer")` — identical shape to the
 * accumulator's internal default on the host (prefix + 8 hex + `.log` under
 * the tmpdir); a guest path in VM mode (spec 25). (Abort is unreachable in
 * v1: the `ToolModule.execute` signature carries no `AbortSignal`, so only the
 * timeout path can kill.) The `try/catch` here stays ONLY for the spawn-error
 * rejection — the at-the-end `Result` narrowing.
 */
import type { ToolModule } from "../mcp/types.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { err, ok } from "./result.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";

/** Flush the accumulator, persist the full output to a temp file if truncated, close it. */
async function finishOutput(output: OutputAccumulator): Promise<OutputSnapshot> {
	output.finish();
	const snapshot = output.snapshot({ persistIfTruncated: true });
	await output.closeTempFile();
	return snapshot;
}

/** Build the result text from a snapshot, appending the tail-truncation footer pi emits. */
function formatOutput(snapshot: OutputSnapshot, output: OutputAccumulator, emptyText = "(no output)"): string {
	const truncation = snapshot.truncation;
	let text = snapshot.content || emptyText;
	if (truncation.truncated) {
		const startLine = truncation.totalLines - truncation.outputLines + 1;
		const endLine = truncation.totalLines;
		if (truncation.lastLinePartial) {
			const lastLineSize = formatSize(output.getLastLineBytes());
			text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
		} else if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
		} else {
			text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
		}
	}
	return text;
}

/** Prepend captured output to a status line (blank-line separated), or just the status. */
function appendStatus(text: string, status: string): string {
	return `${text ? `${text}\n\n` : ""}${status}`;
}

export const bashTool: ToolModule = {
	name: "bash",
	description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
	inputSchema: {
		type: "object",
		properties: {
			command: { type: "string", description: "Bash command to execute" },
			timeout: { type: "number", description: "Timeout in seconds (optional, no default timeout)" },
		},
		required: ["command"],
	},
	async execute(args, ctx) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const command = args.command;
		if (typeof command !== "string") {
			return err(new Error("bash requires a string 'command' argument"));
		}
		const timeout = typeof args.timeout === "number" ? args.timeout : undefined;

		// `exists` errs only on invalid argument types (unreachable for a resolved
		// rootDir string) — folding that into not-exists keeps the message set unchanged.
		const dirExists = await ctx.backend.fs.exists(ctx.rootDir);
		if (!dirExists.ok || !dirExists.value) {
			return err(new Error(`Working directory does not exist: ${ctx.rootDir}\nCannot execute bash commands.`));
		}

		const output = new OutputAccumulator({ tempFilePath: ctx.backend.overflowPath("openhammer") });

		try {
			const result = await ctx.backend.runShell(command, {
				cwd: ctx.rootDir,
				timeoutSec: timeout,
				onChunk: (b) => output.append(b),
			});
			const snapshot = await finishOutput(output);
			if (result.timedOut) {
				const text = formatOutput(snapshot, output, "");
				// `timedOut` implies a requested timeout (LocalBackend only arms a
				// timer when `timeoutSec` is set); `?? 0` keeps the message
				// well-formed if a future backend times out by default.
				return err(new Error(appendStatus(text, `Command timed out after ${timeout ?? 0} seconds`)));
			}
			const text = formatOutput(snapshot, output);
			// `-1` without a timeout is signal death — the old local code saw
			// `null` there and skipped the err (see the header's mapping table).
			if (result.exitCode !== 0 && result.exitCode !== -1) {
				return err(new Error(appendStatus(text, `Command exited with code ${result.exitCode}`)));
			}
			return ok({ content: [{ type: "text", text }] });
		} catch (e) {
			// Spawn error (the only rejection — e.g. the shell binary is missing):
			// finish capturing (closes any open temp-file stream), then narrow to a Result err.
			await finishOutput(output);
			return err(e instanceof Error ? e : new Error(String(e)));
		}
	},
};
