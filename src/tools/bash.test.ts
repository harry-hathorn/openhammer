import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { bashTool } from "./bash.ts";
import type { Result } from "./result.ts";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Assert a successful result and return its first text block's text. */
function expectText(res: Result<ToolOk, Error>): string {
	expect(res.ok).toBe(true);
	if (!res.ok) throw new Error("expected ok result");
	const block = res.value.content[0];
	expect(block?.type).toBe("text");
	return block && block.type === "text" ? block.text : "";
}

/**
 * Linux /proc state for a pid: `null` if gone, else the state char (e.g. "R", "S",
 * "Z"). Used to tell a *live* orphan (R/S) from a reaped/zombie process (Z/gone) —
 * `process.kill(pid, 0)` reports zombies as alive, so it can't make that distinction.
 */
function processState(pid: number): string | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
		// `comm` may contain spaces/parens; the state char follows the last ")".
		const closeParen = stat.lastIndexOf(")");
		return stat.slice(closeParen + 2, closeParen + 3);
	} catch {
		return null;
	}
}

describe("bashTool", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-bash-"));
	});

	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	test("runs a command and returns stdout (echo hello && pwd)", async () => {
		const res = await bashTool.execute({ command: "echo hello && pwd" }, rootDir);
		const text = expectText(res);
		expect(text).toContain("hello");
		expect(text).toContain(rootDir);
	}, 15000);

	test("non-zero exit -> err carrying the exit code", async () => {
		const res = await bashTool.execute({ command: "exit 3" }, rootDir);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toContain("Command exited with code 3");
		}
	}, 15000);

	test("large output is tail-truncated with a Full output footer", async () => {
		const res = await bashTool.execute({ command: "yes | head -c 2000000" }, rootDir);
		const text = expectText(res);
		expect(text).toContain("Full output:");
		// The spilled full output should exist on disk (proves temp-file spill).
		const match = /Full output: ([^\]]+)/.exec(text);
		const fullPath = match?.[1];
		expect(fullPath).toBeTruthy();
		if (fullPath) {
			expect(existsSync(fullPath)).toBe(true);
		}
	}, 30000);

	test("merges stdout and stderr into one stream", async () => {
		const res = await bashTool.execute({ command: "echo OUT_TO_STDOUT; echo ERR_TO_STDERR >&2" }, rootDir);
		const text = expectText(res);
		expect(text).toContain("OUT_TO_STDOUT");
		expect(text).toContain("ERR_TO_STDERR");
	}, 15000);

	test("timeout kills the process tree (no orphan)", async () => {
		// Background a long sleep in bash's process group, print its PID, then block
		// on a foreground sleep so the timeout fires and the group is SIGKILLed.
		const res = await bashTool.execute({ command: "sleep 60 & echo BG_PID=$!; sleep 30", timeout: 1 }, rootDir);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toContain("Command timed out after 1 seconds");
			// The captured output (prepended by appendStatus) carries the backgrounded PID.
			const match = /BG_PID=(\d+)/.exec(res.error.message);
			const pidText = match?.[1];
			expect(pidText).toBeTruthy();
			if (pidText) {
				const bgPid = Number(pidText);
				// Poll until the backgrounded sleep is no longer live (gone or zombie,
				// not R/S). A live orphan here would mean the group kill failed.
				let live = true;
				for (let i = 0; i < 80 && live; i++) {
					const state = processState(bgPid);
					if (state === null || state === "Z") {
						live = false;
					} else {
						await sleep(25);
					}
				}
				expect(live).toBe(false);
			}
		}
	}, 15000);
});
