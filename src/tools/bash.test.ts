import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { bashTool } from "./bash.ts";
import type { Result } from "./result.ts";

// One local backend per file (spec 23) — LocalBackend is stateless, matching the
// boot-scoped seam without per-test machinery.
const backend = createLocalBackend();

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
		const res = await bashTool.execute({ command: "echo hello && pwd" }, { rootDir, backend });
		const text = expectText(res);
		expect(text).toContain("hello");
		expect(text).toContain(rootDir);
	}, 15000);

	test("non-zero exit -> err carrying the exit code", async () => {
		const res = await bashTool.execute({ command: "exit 3" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error.message).toContain("Command exited with code 3");
		}
	}, 15000);

	test("large output is tail-truncated with a Full output footer", async () => {
		const res = await bashTool.execute({ command: "yes | head -c 2000000" }, { rootDir, backend });
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

	test("local over-cap: host spill unchanged — the lines footer form is byte-pinned", async () => {
		const res = await bashTool.execute({ command: "seq 1 3000" }, { rootDir, backend });
		const text = expectText(res);
		// The exact footer form (the lines branch): last 2000 of 3000 lines + path.
		expect(text).toMatch(/\n\n\[Showing lines 1001-3000 of 3000\. Full output: [^\]]+\]$/);
		const fullPath = /\[Showing lines 1001-3000 of 3000\. Full output: ([^\]]+)\]$/.exec(text)?.[1];
		expect(fullPath).toBeTruthy();
		if (fullPath) {
			// The spill exists host-side and holds the full 3000-line stream.
			expect(existsSync(fullPath)).toBe(true);
			const full = readFileSync(fullPath, "utf-8");
			expect(full.startsWith("1\n")).toBe(true);
			expect(full.endsWith("\n3000\n")).toBe(true);
			expect(full.split("\n")).toHaveLength(3001);
		}
	}, 15000);

	test("merges stdout and stderr into one stream", async () => {
		const res = await bashTool.execute(
			{ command: "echo OUT_TO_STDOUT; echo ERR_TO_STDERR >&2" },
			{ rootDir, backend },
		);
		const text = expectText(res);
		expect(text).toContain("OUT_TO_STDOUT");
		expect(text).toContain("ERR_TO_STDERR");
	}, 15000);

	test("timeout kills the process tree (no orphan)", async () => {
		// Background a long sleep in bash's process group, print its PID, then block
		// on a foreground sleep so the timeout fires and the group is SIGKILLed.
		const res = await bashTool.execute(
			{ command: "sleep 60 & echo BG_PID=$!; sleep 30", timeout: 1 },
			{ rootDir, backend },
		);
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

	test("spawn error (missing shell) -> err carrying the spawn error, not an exit-code message", async () => {
		// The rejection path bash's try/catch narrows. Covered here with the real
		// LocalBackend because FakeBackend.runShell never rejects by design.
		// Snapshot/restore SHELL (LocalBackend reads it per call) so sibling tests
		// can't be poisoned — mirrors backend.test.ts's missing-shell test.
		const savedShell = process.env.SHELL;
		process.env.SHELL = "/nonexistent/openhammer-no-such-shell";
		try {
			const res = await bashTool.execute({ command: "echo hi" }, { rootDir, backend });
			expect(res.ok).toBe(false);
			if (res.ok) throw new Error("unreachable");
			expect(res.error.message).toContain("spawn /nonexistent/openhammer-no-such-shell");
			expect(res.error.message).toContain("ENOENT");
			expect(res.error.message).not.toContain("Command exited with code");
		} finally {
			if (savedShell === undefined) {
				delete process.env.SHELL;
			} else {
				process.env.SHELL = savedShell;
			}
		}
	}, 15000);
});

// Spec 23e: the ShellResult -> result shaping, driven by the scripted
// FakeBackend — zero process spawns, zero host fs (outputs stay under the
// truncation limits, so the accumulator never spills; the fake's overflowPath
// mint is a pure string). The real-spawn counterparts live in the suite above.
// The last test is the spec 25 exception: a vm-kind fake with OVER-cap output,
// proving the accumulator's spill is "external" there (no host file).
describe("bash via FakeBackend", () => {
	const rootDir = "/work";

	test("exit 0 with stdout -> ok text; cmd and cwd recorded", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "echo hello", result: { exitCode: 0 }, stdout: "hello\n" }],
		});
		const res = await bashTool.execute({ command: "echo hello" }, { rootDir, backend });
		expect(expectText(res)).toBe("hello\n");
		expect(backend.calls).toEqual([{ cmd: "echo hello", cwd: rootDir }]);
		expect(backend.unexpectedCalls).toEqual([]);
	});

	test("exit 0 with no output -> ok '(no output)' placeholder", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "true", result: { exitCode: 0 } }],
		});
		const res = await bashTool.execute({ command: "true" }, { rootDir, backend });
		expect(expectText(res)).toBe("(no output)");
	});

	test("non-zero exit -> err 'Command exited with code 3' over the captured output", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "make", result: { exitCode: 3 }, stdout: "building...\n", stderr: "make: error\n" }],
		});
		const res = await bashTool.execute({ command: "make all" }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toContain("building...");
		expect(res.error.message).toContain("make: error");
		// appendStatus shape: captured output, blank line, then the status as the last line.
		expect(res.error.message.endsWith("Command exited with code 3")).toBe(true);
	});

	test("timedOut -> err 'Command timed out after N seconds'; timeout threads through as timeoutSec", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "sleep", result: { exitCode: -1, timedOut: true }, stdout: "started\n" }],
		});
		const res = await bashTool.execute({ command: "sleep 30", timeout: 2 }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toContain("started");
		expect(res.error.message.endsWith("Command timed out after 2 seconds")).toBe(true);
		expect(backend.calls).toEqual([{ cmd: "sleep 30", cwd: rootDir, timeoutSec: 2 }]);
	});

	test("timedOut with no captured output -> the bare status line (no '(no output)' placeholder)", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "hang", result: { exitCode: -1, timedOut: true } }],
		});
		const res = await bashTool.execute({ command: "hang", timeout: 1 }, { rootDir, backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("Command timed out after 1 seconds");
	});

	test("chunked multi-chunk emission (chunkDelayMs) -> merged output in arrival order", async () => {
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [
				{ match: "build", result: { exitCode: 0 }, stdout: "step-one-", stderr: "step-two-", chunkDelayMs: 1 },
			],
		});
		const res = await bashTool.execute({ command: "build --all" }, { rootDir, backend });
		// Each stream deterministically splits into 3 chunks; the accumulator
		// must reassemble them in arrival order (stdout chunks, then stderr).
		expect(expectText(res)).toBe("step-one-step-two-");
	});

	test("working directory does not exist -> err before any shell call", async () => {
		const backend = fakeBackend({ script: [] });
		const res = await bashTool.execute({ command: "echo hi" }, { rootDir: "/no/such/dir", backend });
		expect(res.ok).toBe(false);
		if (res.ok) throw new Error("unreachable");
		expect(res.error.message).toBe("Working directory does not exist: /no/such/dir\nCannot execute bash commands.");
		expect(backend.calls).toEqual([]); // the precheck fires before runShell
	});

	test("exitCode -1 without timedOut (signal death) -> ok, mapping the old null-exit branch", async () => {
		// Documented spec 23e choice: the old local code saw `null` here and its
		// `exitCode !== 0 && exitCode !== null` guard skipped the err, so the
		// backend's -1 sentinel lands on the ok branch (see bash.ts's header).
		const backend = fakeBackend({
			dirs: [rootDir],
			script: [{ match: "kill", result: { exitCode: -1 }, stdout: "partial\n" }],
		});
		const res = await bashTool.execute({ command: "kill -9 $$" }, { rootDir, backend });
		expect(expectText(res)).toBe("partial\n");
	});

	test("vm-kind backend, over-cap output: no host spill — the footer names the GUEST path (spec 25)", async () => {
		// The parity hazard this box closes: with kind "vm" the overflowPath is a
		// GUEST path string; before the spill split, a truncated output made the
		// accumulator host-write to it — a stray host file (or, with the fake's
		// /tmp/fake parent absent, an ENOENT stream error that narrowed the whole
		// result to err). Now: ok, footer naming the guest path, host fs untouched.
		const flood = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join("\n");
		const backend = fakeBackend({
			dirs: [rootDir],
			kind: "vm",
			script: [{ match: "flood", result: { exitCode: 0 }, stdout: flood }],
		});
		const res = await bashTool.execute({ command: "flood" }, { rootDir, backend });
		const text = expectText(res); // ok — the pre-fix code errored here
		// The footer names the fake's guest-shaped overflow path, byte-exact —
		// which also proves no host mint happened (a minted path would differ).
		expect(text.endsWith("\n\n[Showing lines 1001-3000 of 3000. Full output: /tmp/fake/openhammer-1.log]")).toBe(
			true,
		);
		// No host file exists at the guest path — the guest tee owns the copy.
		expect(existsSync("/tmp/fake/openhammer-1.log")).toBe(false);
	});
});
