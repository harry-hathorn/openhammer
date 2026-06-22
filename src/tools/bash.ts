/**
 * The `bash` tool (spec 04).
 *
 * Ports pi's `bash` execute logic + its local shell backend, stripped of all
 * pi-package/TUI/operations coupling: `getShellConfig` (→ `$SHELL || "bash"`),
 * `trackDetachedChildPid`/`waitForChildProcess` (→ a direct child-exit promise +
 * detached-group `process.kill(-pid, "SIGKILL")`), `commandPrefix`/`spawnHook`/
 * `BashOperations` (no execution seam — locked), and every render/TUI helper.
 *
 * Spawns `[shell, "-c", command]` at `rootDir` in its own process group, merges
 * stdout+stderr into one `OutputAccumulator({ tempFilePrefix: "openhammer" })`,
 * and on timeout kills the whole group so no child escapes. pi throws on non-zero
 * exit / timeout; here those become `err(...)` — the MCP `CallTool` handler
 * (spec 12) is the single narrowing point. (Abort is unreachable in v1: the
 * `ToolModule.execute` signature carries no `AbortSignal`, so only the timeout
 * path can kill.) Spawn-based tools manage their own streaming and do **not** use
 * `io.ts`; the `try/catch` here is the at-the-end `Result` narrowing.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { ToolModule } from "../mcp/types.ts";
import { OutputAccumulator, type OutputSnapshot } from "./output-accumulator.ts";
import { err, ok } from "./result.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "./truncate.ts";

/** Send SIGKILL to the child's whole process group (best-effort; ignores ESRCH/EPERM). */
function killProcessGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		// `-pid` targets the group; the child is its leader because `detached: true`.
		process.kill(-pid, "SIGKILL");
	} catch {
		// Already reaped (ESRCH) or permission denied — best-effort kill, nothing to do.
	}
}

/**
 * Spawn the shell, stream merged stdout+stderr into `output`, and resolve with the
 * exit code. Rejects with `timeout:<secs>` when the timeout fires (after killing the
 * group), or with the spawn `error` event (e.g. shell missing). Mirrors pi's local
 * backend; the `exit` event (not `close`) avoids hanging on pipe FDs inherited by
 * detached grandchildren.
 */
function runShell(
	shell: string,
	command: string,
	cwd: string,
	timeout: number | undefined,
	output: OutputAccumulator,
): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const child = spawn(shell, ["-c", command], {
			cwd,
			detached: process.platform !== "win32",
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let timedOut = false;
		let timeoutHandle: NodeJS.Timeout | undefined;

		child.stdout?.on("data", (data: Buffer) => {
			output.append(data);
		});
		child.stderr?.on("data", (data: Buffer) => {
			output.append(data);
		});

		if (timeout !== undefined && timeout > 0) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				killProcessGroup(child.pid);
			}, timeout * 1000);
		}

		child.on("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			reject(error);
		});

		child.on("exit", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			if (timedOut) {
				reject(new Error(`timeout:${timeout}`));
				return;
			}
			resolve(code);
		});
	});
}

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
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const command = args.command;
		if (typeof command !== "string") {
			return err(new Error("bash requires a string 'command' argument"));
		}
		const timeout = typeof args.timeout === "number" ? args.timeout : undefined;

		if (!existsSync(rootDir)) {
			return err(new Error(`Working directory does not exist: ${rootDir}\nCannot execute bash commands.`));
		}

		const shell = process.env.SHELL || "bash";
		const output = new OutputAccumulator({ tempFilePrefix: "openhammer" });

		try {
			const exitCode = await runShell(shell, command, rootDir, timeout, output);
			const snapshot = await finishOutput(output);
			const text = formatOutput(snapshot, output);
			if (exitCode !== 0 && exitCode !== null) {
				return err(new Error(appendStatus(text, `Command exited with code ${exitCode}`)));
			}
			return ok({ content: [{ type: "text", text }] });
		} catch (e) {
			// Timeout / spawn-error → finish capturing, then narrow to a Result err.
			const snapshot = await finishOutput(output);
			const text = formatOutput(snapshot, output, "");
			if (e instanceof Error && e.message.startsWith("timeout:")) {
				const secs = e.message.split(":")[1];
				return err(new Error(appendStatus(text, `Command timed out after ${secs} seconds`)));
			}
			return err(e instanceof Error ? e : new Error(String(e)));
		}
	},
};
