// Minimal spawn helper for the spike — arg arrays only, never a shell string.
import { spawn } from "node:child_process";

const STDERR_TAIL_BYTES = 4096;

export interface RunResult {
	readonly code: number | null;
	readonly stderrTail: string;
}

/**
 * Spawn `bin args`, keep the last 4 KB of stderr, await exit. A spawn failure (ENOENT)
 * resolves with `code: null` and the error in the tail — callers check the code.
 */
export function run(bin: string, args: readonly string[]): Promise<RunResult> {
	return new Promise<RunResult>((resolveRun) => {
		const child = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
		let tail = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			tail = `${tail}${chunk.toString("utf8")}`.slice(-STDERR_TAIL_BYTES);
		});
		child.on("error", (error: Error) => {
			resolveRun({ code: null, stderrTail: `${tail}\nspawn error: ${error.message}`.trim() });
		});
		child.on("close", (code) => {
			resolveRun({ code, stderrTail: tail });
		});
	});
}
