// Minimal spawn helper for the spike — arg arrays only, never a shell string.
import { spawn } from "node:child_process";

const TAIL_BYTES = 4096;

export interface RunResult {
	readonly code: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
}

export interface RunOptions {
	/** Pipe this to stdin and close it (openssl passwd -6 -stdin keeps the secret off argv). */
	readonly stdin?: string;
}

/**
 * Spawn `bin args`, keep the last 4 KB of stdout+stderr, await exit. A spawn failure (ENOENT)
 * resolves with `code: null` and the error in the tail — callers check the code.
 */
export function run(bin: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
	return new Promise<RunResult>((resolveRun) => {
		const child = spawn(bin, args, {
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const keep = (prior: string, chunk: Buffer): string => `${prior}${chunk.toString("utf8")}`.slice(-TAIL_BYTES);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = keep(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = keep(stderr, chunk);
		});
		const stdin = child.stdin; // nullable in spawn's types regardless of stdio config
		if (options.stdin !== undefined && stdin !== null) {
			stdin.write(options.stdin);
			stdin.end();
		}
		child.on("error", (error: Error) => {
			resolveRun({
				code: null,
				stdoutTail: stdout,
				stderrTail: `${stderr}\nspawn error: ${error.message}`.trim(),
			});
		});
		child.on("close", (code) => {
			resolveRun({ code, stdoutTail: stdout, stderrTail: stderr });
		});
	});
}
