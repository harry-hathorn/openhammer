import { spawn as realSpawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend, type ShellScriptEntry } from "../tools/backend.fake.ts";
import { bashTool } from "../tools/bash.ts";
import type { Result } from "../tools/result.ts";
import {
	createVmBackend,
	DEFAULT_GUEST_OVERFLOW_DIR,
	GUEST_TIMEOUT_CEILING_SEC,
	type VmBackendSpec,
	type VmExecSync,
} from "./backend.ts";
import type { SshExecOptions, SshExecResult, SshTarget, sshCloseMux, sshExec } from "./ssh.ts";

// The sample session target (ssh.test.ts's): paths are opaque strings to the builders.
const TARGET: SshTarget = {
	user: "sandbox",
	host: "127.0.0.1",
	port: 41733,
	keyPath: "/vm/secrets/id_ed25519",
	knownHostsPath: "/vm/sessions/s1/known_hosts",
	controlPath: "/vm/sessions/s1/cm.sock",
};

const SPEC: VmBackendSpec = {
	target: TARGET,
	guestUser: "sandbox",
	serialLogPath: "/vm/sessions/s1/serial.log",
};

// The wrapper scripts, hardcoded here as GOLDENS (not imported): if backend.ts's constants
// drift, these literals fail, so the slot discipline is pinned by the test, not by tautology.
const RUN_SHELL_SCRIPT = [
	'cd -- "$1" || exit 125',
	"set -a; [ ! -f ~/.openhammer/env ] || . ~/.openhammer/env; set +a",
	"set -o pipefail",
	'mkdir -p -- "$(dirname -- "$4")"',
	'exec timeout -k 5 "$2"s bash -c "$3" 2>&1 | tee -- "$4"',
].join("\n");

const RUN_ARGV_SCRIPT = ['cd -- "$1" || exit 125', 't="$2"s', "shift 2", 'exec timeout -k 5 "$t" "$0" "$@"'].join("\n");

// --------------------------------------------------------------------- unit fakes ----

/** One scripted ssh-exec outcome: the ssh-level result plus chunks emitted through the callbacks. */
interface ScriptedVmExec {
	/** String → substring test against the joined remote argv; RegExp → .test. */
	match: string | RegExp;
	/** The ssh-level exit code (124 = guest timeout wrapper, 255 = transport death, -1 = signal). */
	exitCode: number;
	/** Emitted through opts.onChunk in order (runShell's guest-merged stream). */
	merged?: string[];
	/** Emitted through opts.onStdout in order (runArgv's split stream). */
	stdoutChunks?: string[];
	/** Emitted through opts.onStderr in order. */
	stderrChunks?: string[];
	/** Rides the resolved SshExecResult's stderr tail (the 255 error's detail). */
	stderrTail?: string;
}

/**
 * The injected exec seam (fs-ssh.test.ts's recordingExec shape): records every (remoteArgv,
 * opts), answers from the script — the first UNCONSUMED matching entry wins and is spent. An
 * unscripted call THROWS (a missing script must fail loudly, FakeBackend's rule) rather than
 * silently resolving 0.
 */
function recordingExec(script: ScriptedVmExec[] = []): {
	exec: typeof sshExec;
	calls: Array<{ remoteArgv: string[]; opts: SshExecOptions }>;
} {
	const calls: Array<{ remoteArgv: string[]; opts: SshExecOptions }> = [];
	const spent = new Set<number>();
	const exec: typeof sshExec = async (_target, remoteArgv, opts = {}) => {
		calls.push({ remoteArgv: [...remoteArgv], opts });
		const joined = remoteArgv.join(" ");
		let entry: ScriptedVmExec | undefined;
		for (const [index, candidate] of script.entries()) {
			if (spent.has(index)) continue;
			const hit =
				typeof candidate.match === "string" ? joined.includes(candidate.match) : candidate.match.test(joined);
			if (hit) {
				spent.add(index);
				entry = candidate;
				break;
			}
		}
		if (entry === undefined) {
			throw new Error(`vm-backend test: no script for remote argv: ${joined}`);
		}
		for (const chunk of entry.merged ?? []) opts.onChunk?.(Buffer.from(chunk, "utf8"));
		for (const chunk of entry.stdoutChunks ?? []) opts.onStdout?.(Buffer.from(chunk, "utf8"));
		for (const chunk of entry.stderrChunks ?? []) opts.onStderr?.(Buffer.from(chunk, "utf8"));
		return { exitCode: entry.exitCode, timedOut: false, stdoutTail: "", stderrTail: entry.stderrTail ?? "" };
	};
	return { exec, calls };
}

/** An exec the test controls by hand: never settles until finish()/fail() (the abort races). */
function deferredExec(): {
	exec: typeof sshExec;
	calls: Array<{ remoteArgv: string[]; opts: SshExecOptions }>;
	emitStdout(text: string): void;
	finish(result: SshExecResult): void;
	fail(error: Error): void;
} {
	const calls: Array<{ remoteArgv: string[]; opts: SshExecOptions }> = [];
	let currentOpts: SshExecOptions | undefined;
	let finish: ((result: SshExecResult) => void) | undefined;
	let fail: ((error: Error) => void) | undefined;
	const exec: typeof sshExec = (_target, remoteArgv, opts = {}) => {
		calls.push({ remoteArgv: [...remoteArgv], opts });
		currentOpts = opts;
		return new Promise<SshExecResult>((resolve, reject) => {
			finish = resolve;
			fail = reject;
		});
	};
	return {
		exec,
		calls,
		emitStdout: (text) => currentOpts?.onStdout?.(Buffer.from(text, "utf8")),
		finish: (result) => finish?.(result),
		fail: (error) => fail?.(error),
	};
}

/** The injected synchronous probe seam: records every remoteArgv, answers from the function. */
function recordingExecSync(answer: (remoteArgv: string[]) => number): { execSync: VmExecSync; calls: string[][] } {
	const calls: string[][] = [];
	const execSync: VmExecSync = (_target, remoteArgv) => {
		calls.push([...remoteArgv]);
		return answer([...remoteArgv]);
	};
	return { execSync, calls };
}

/** The injected mux teardown: records the target it tore down. */
function recordingCloseMux(): { closeMux: typeof sshCloseMux; calls: SshTarget[] } {
	const calls: SshTarget[] = [];
	const closeMux: typeof sshCloseMux = async (target) => {
		calls.push(target);
		return true;
	};
	return { closeMux, calls };
}

/** A tool Result as comparable text: ok text, or the err message (the parity comparison key). */
function outcomeText(res: Result<ToolOk, Error>): string {
	if (!res.ok) return res.error.message;
	const block = res.value.content[0];
	return block?.type === "text" ? block.text : "";
}

// ------------------------------------------------------------ identity & lifecycle ----

describe("VmBackend identity & lifecycle", () => {
	it("kind is 'vm'; homedir is the guest home (default /home/<guestUser>, override honored)", () => {
		expect(createVmBackend(SPEC).kind).toBe("vm");
		expect(createVmBackend(SPEC).homedir()).toBe("/home/sandbox");
		expect(createVmBackend({ ...SPEC, guestHome: "/home/other" }).homedir()).toBe("/home/other");
	});

	it("fs is createSshFs over the same target and the same injected exec seam", async () => {
		const { exec, calls } = recordingExec([{ match: "test -e", exitCode: 0 }]);
		const backend = createVmBackend(SPEC, { exec });
		await expect(backend.fs.exists("/work")).resolves.toEqual({ ok: true, value: true });
		expect(calls[0]?.remoteArgv).toEqual(["test", "-e", "/work"]);
	});

	it("overflowPath is a fresh unique GUEST path: <dir>/<prefix>-<16hex>.log, honoring prefix and dir", () => {
		const backend = createVmBackend(SPEC);
		const a = backend.overflowPath("openhammer");
		const b = backend.overflowPath("openhammer");
		expect(a).toMatch(new RegExp(`^${DEFAULT_GUEST_OVERFLOW_DIR}/openhammer-[0-9a-f]{16}\\.log$`));
		expect(a).not.toBe(b);
		expect(backend.overflowPath("other")).toMatch(
			new RegExp(`^${DEFAULT_GUEST_OVERFLOW_DIR}/other-[0-9a-f]{16}\\.log$`),
		);
		expect(createVmBackend({ ...SPEC, overflowDir: "/guest/ov" }).overflowPath("openhammer")).toMatch(
			/^\/guest\/ov\/openhammer-[0-9a-f]{16}\.log$/,
		);
	});

	it("the always-wrapped ceiling is 86400 (24h) — documented, not incidental", () => {
		expect(GUEST_TIMEOUT_CEILING_SEC).toBe(86400);
	});

	it("close tears the mux down exactly once, clears the probe cache, and is idempotent", async () => {
		const { exec } = recordingExec([{ match: "bash", exitCode: 0 }]);
		const probe = recordingExecSync(() => 0);
		const mux = recordingCloseMux();
		const backend = createVmBackend(SPEC, { exec, execSync: probe.execSync, closeMux: mux.closeMux });
		expect(backend.probe("rg")).toBe(true);
		expect(probe.calls).toHaveLength(1);
		await backend.close();
		await backend.close(); // idempotent: still exactly one teardown
		expect(mux.calls).toEqual([TARGET]);
		// The cache was cleared: the same probe re-executes after close.
		expect(backend.probe("rg")).toBe(true);
		expect(probe.calls).toHaveLength(2);
	});
});

// ------------------------------------------------------------------- runShell ----

describe("VmBackend runShell (the wrapper)", () => {
	it("builds the exact remote argv: compile-time script, cwd/timeout/cmd/overflow in slots", async () => {
		const { exec, calls } = recordingExec([{ match: "bash", exitCode: 0 }]);
		const backend = createVmBackend(SPEC, { exec });
		await backend.runShell("echo 'hi there'", { cwd: "/work", timeoutSec: 30 });
		expect(calls).toHaveLength(1);
		const argv = calls[0]?.remoteArgv ?? [];
		expect(argv).toHaveLength(8);
		expect(argv[0]).toBe("bash");
		expect(argv[1]).toBe("-c");
		expect(argv[2]).toBe(RUN_SHELL_SCRIPT); // the golden — nothing is ever spliced into it
		expect(argv[3]).toBe("bash"); // the $0 name operand
		expect(argv[4]).toBe("/work"); // $1 cwd
		expect(argv[5]).toBe("30"); // $2 timeout seconds
		expect(argv[6]).toBe("echo 'hi there'"); // $3 the command, verbatim, one element
		expect(argv[7]).toMatch(new RegExp(`^${DEFAULT_GUEST_OVERFLOW_DIR}/openhammer-[0-9a-f]{16}\\.log$`)); // $4 tee target
	});

	it("a hostile command rides $3 whole — never split, spliced, or re-quoted host-side", async () => {
		const hostile = 'echo "it\'s $(rm -rf /) `x`";\n\techo -n --flag';
		const { exec, calls } = recordingExec([{ match: "bash", exitCode: 0 }]);
		await createVmBackend(SPEC, { exec }).runShell(hostile, { cwd: "/work" });
		expect(calls[0]?.remoteArgv[6]).toBe(hostile);
	});

	it("the env prefix is 22-measured's verified source form, export-marked and guarded", () => {
		// Gate 4 / finding 11: prefix-sourcing ~/.openhammer/env is the ONLY context that
		// works for plain non-interactive ssh. The full literal is the golden above; these
		// pin the measured line's load-bearing parts.
		expect(RUN_SHELL_SCRIPT).toContain(". ~/.openhammer/env");
		expect(RUN_SHELL_SCRIPT).toContain("set -a;");
		expect(RUN_SHELL_SCRIPT).toContain("[ ! -f ~/.openhammer/env ] ||");
	});

	it("undefined and non-positive timeoutSec still wrap: the ceiling rides the $2 slot", async () => {
		const { exec, calls } = recordingExec([
			{ match: "bash", exitCode: 0 },
			{ match: "bash", exitCode: 0 },
		]);
		const backend = createVmBackend(SPEC, { exec });
		await backend.runShell("true", { cwd: "/work" });
		expect(calls[0]?.remoteArgv[5]).toBe("86400");
		await backend.runShell("true", { cwd: "/work", timeoutSec: 0 }); // LocalBackend gates > 0
		expect(calls[1]?.remoteArgv[5]).toBe("86400");
	});

	it("onChunk is wired straight through: the guest-merged stream arrives in order", async () => {
		const { exec } = recordingExec([{ match: "bash", exitCode: 0, merged: ["one\n", "two\n", "three\n"] }]);
		const chunks: string[] = [];
		const r = await createVmBackend(SPEC, { exec }).runShell("seq 3", {
			cwd: "/work",
			onChunk: (b) => chunks.push(b.toString("utf8")),
		});
		expect(r).toEqual({ exitCode: 0, timedOut: false });
		expect(chunks).toEqual(["one\n", "two\n", "three\n"]);
	});

	it("guest exit codes pass through; the wrapper's 124 maps to LocalBackend's timeout shape", async () => {
		const { exec } = recordingExec([
			{ match: "bash", exitCode: 0 },
			{ match: "bash", exitCode: 3 },
			{ match: "bash", exitCode: 124 },
			{ match: "bash", exitCode: -1 },
		]);
		const backend = createVmBackend(SPEC, { exec });
		expect(await backend.runShell("true", { cwd: "/work" })).toEqual({ exitCode: 0, timedOut: false });
		expect(await backend.runShell("exit 3", { cwd: "/work" })).toEqual({ exitCode: 3, timedOut: false });
		expect(await backend.runShell("sleep 30", { cwd: "/work", timeoutSec: 1 })).toEqual({
			exitCode: -1,
			timedOut: true,
		});
		// -1 without a timeout = the ssh client signal-died: LocalBackend's signal-death shape.
		expect(await backend.runShell("kill -9 $$", { cwd: "/work" })).toEqual({ exitCode: -1, timedOut: false });
	});

	it("rc 255 rejects with the actionable transport-death error naming the serial log", async () => {
		const { exec } = recordingExec([
			{ match: "bash", exitCode: 255, stderrTail: "mux_client_request_session: session from master: read failed\n" },
			{ match: "bash", exitCode: 255 },
		]);
		const backend = createVmBackend(SPEC, { exec });
		await expect(backend.runShell("echo hi", { cwd: "/work" })).rejects.toThrow(
			"ssh transport died (exit 255; the guest is unreachable or the connection was lost): " +
				"mux_client_request_session: session from master: read failed; " +
				"see the VM serial log: /vm/sessions/s1/serial.log",
		);
		// runArgv shares the mapping (the bare-tail variant exercises the no-stderr branch).
		await expect(backend.runArgv("rg", ["--json"], {})).rejects.toThrow(
			"ssh transport died (exit 255; the guest is unreachable or the connection was lost): no ssh stderr captured",
		);
	});
});

// -------------------------------------------------------------------- runArgv ----

describe("VmBackend runArgv (the hygiene twin)", () => {
	it("builds the exact remote argv: script constant, bin as $0, cwd/timeout slots, args after", async () => {
		const { exec, calls } = recordingExec([{ match: "bash", exitCode: 0 }]);
		const backend = createVmBackend(SPEC, { exec });
		await backend.runArgv("rg", ["--json", "--", "pat", "/work"], { cwd: "/guest/work", timeoutSec: 5 });
		const argv = calls[0]?.remoteArgv ?? [];
		expect(argv.slice(0, 6)).toEqual(["bash", "-c", RUN_ARGV_SCRIPT, "rg", "/guest/work", "5"]);
		expect(argv.slice(6)).toEqual(["--json", "--", "pat", "/work"]);
	});

	it("a hostile operand arrives as ONE argv element — no shell re-parse anywhere", async () => {
		const hostile = 'it\'s "quoted" $(x) `y`\n-prefixed --flag';
		const { exec, calls } = recordingExec([{ match: "bash", exitCode: 0 }]);
		await createVmBackend(SPEC, { exec }).runArgv("rg", ["--json", "--", hostile, "/work"], {});
		const argv = calls[0]?.remoteArgv ?? [];
		expect(argv.slice(0, 6)).toEqual(["bash", "-c", RUN_ARGV_SCRIPT, "rg", "/home/sandbox", "86400"]);
		expect(argv[6]).toBe("--json");
		expect(argv[7]).toBe("--");
		expect(argv[8]).toBe(hostile); // spaces, quotes, $(), newline: one element, verbatim
		expect(argv[9]).toBe("/work");
	});

	it("cwd defaults to the guest home (sshd's own start-in-home); streams stay split", async () => {
		const { exec, calls } = recordingExec([
			{ match: "bash", exitCode: 0, stdoutChunks: ["OUT-1", "OUT-2"], stderrChunks: ["ERR-1"] },
		]);
		const out: string[] = [];
		const errOut: string[] = [];
		const r = await createVmBackend(SPEC, { exec }).runArgv("rg", ["--json"], {
			onStdout: (b) => out.push(b.toString("utf8")),
			onStderr: (b) => errOut.push(b.toString("utf8")),
		});
		expect(r).toEqual({ exitCode: 0, timedOut: false });
		expect(out).toEqual(["OUT-1", "OUT-2"]);
		expect(errOut).toEqual(["ERR-1"]);
		// Merging is runShell's contract only: runArgv wires no onChunk into the exec.
		expect(calls[0]?.opts.onChunk).toBeUndefined();
		expect(calls[0]?.remoteArgv[4]).toBe("/home/sandbox");
	});

	it("exit mappings mirror runShell: 124 → timedOut, N passes through", async () => {
		const { exec } = recordingExec([
			{ match: "bash", exitCode: 2 },
			{ match: "bash", exitCode: 124 },
		]);
		const backend = createVmBackend(SPEC, { exec });
		expect(await backend.runArgv("rg", ["--json"], {})).toEqual({ exitCode: 2, timedOut: false });
		expect(await backend.runArgv("rg", ["--json"], { timeoutSec: 1 })).toEqual({ exitCode: -1, timedOut: true });
	});

	it("abort mid-flight resolves { -1, false } immediately; forwarding stops; the drained outcome never surfaces", async () => {
		const d = deferredExec();
		const backend = createVmBackend(SPEC, { exec: d.exec });
		const controller = new AbortController();
		const out: string[] = [];
		const pending = backend.runArgv("rg", ["--json"], {
			signal: controller.signal,
			onStdout: (b) => out.push(b.toString("utf8")),
		});
		d.emitStdout("early\n");
		controller.abort();
		await expect(pending).resolves.toEqual({ exitCode: -1, timedOut: false });
		expect(out).toEqual(["early\n"]);
		d.emitStdout("late\n"); // post-abort: gated off
		expect(out).toEqual(["early\n"]);
		// The eventual exec outcome is moot and must not surface (including as unhandled).
		d.fail(new Error("spawn ssh ENOENT"));
		await new Promise((resolve) => setTimeout(resolve, 5));
	});

	it("an already-aborted signal spawns nothing: immediate { -1, false }, zero exec calls", async () => {
		const { exec, calls } = recordingExec([]);
		const controller = new AbortController();
		controller.abort();
		await expect(
			createVmBackend(SPEC, { exec }).runArgv("rg", ["--json"], { signal: controller.signal }),
		).resolves.toEqual({ exitCode: -1, timedOut: false });
		expect(calls).toHaveLength(0);
	});

	it("a normal completion after no abort resolves the mapped outcome (the plain path)", async () => {
		const d = deferredExec();
		const pending = createVmBackend(SPEC, { exec: d.exec }).runArgv("fd", ["--glob", "*.ts"], {});
		d.finish({ exitCode: 0, timedOut: false, stdoutTail: "a.ts\n", stderrTail: "" });
		await expect(pending).resolves.toEqual({ exitCode: 0, timedOut: false });
	});
});

// ------------------------------------------------------------- probe / probeFlag ----

describe("VmBackend probe / probeFlag", () => {
	it("probe runs `command -v` guest-side and caches per instance", () => {
		const { execSync, calls } = recordingExecSync(() => 0);
		const backend = createVmBackend(SPEC, { execSync });
		expect(backend.probe("rg")).toBe(true);
		expect(backend.probe("rg")).toBe(true); // cached: no second exec
		expect(calls).toEqual([["bash", "-c", 'command -v "$1"', "probe", "rg"]]);
	});

	it("probe is false on rc 1 (absent) and rc 255 (dead guest — the safe direction)", () => {
		expect(createVmBackend(SPEC, { execSync: recordingExecSync(() => 1).execSync }).probe("nope")).toBe(false);
		expect(createVmBackend(SPEC, { execSync: recordingExecSync(() => 255).execSync }).probe("rg")).toBe(false);
	});

	it("probeFlag runs `<bin> <flag> --help`, caches under '<bin> <flag>' — a separate keyspace from probe", () => {
		let answer = 0;
		const { execSync, calls } = recordingExecSync(() => answer);
		const backend = createVmBackend(SPEC, { execSync });
		expect(backend.probeFlag("fd", "--no-require-git")).toBe(true);
		expect(backend.probeFlag("fd", "--no-require-git")).toBe(true); // cached
		expect(backend.probe("fd")).toBe(true); // separate cache key, one more exec
		expect(calls).toEqual([
			["bash", "-c", 'exec "$0" "$1" --help', "fd", "--no-require-git"],
			["bash", "-c", 'command -v "$1"', "probe", "fd"],
		]);
		answer = 1;
		expect(backend.probeFlag("fd", "--no-require-git")).toBe(true); // still the cached value
		expect(backend.probeFlag("fd", "--definitely-not")).toBe(false); // fresh key, failing probe
	});
});

// -------------------------------------------------------- bash-tool parity (spec 25) ----

// Spec 25's acceptance: "the guest stream is shaped by the same accumulator as local bash —
// verified by reusing LocalBackend's tests against a scripted fake ssh — same fixtures,
// different backend". Each fixture runs the bash TOOL twice — against 23e's FakeBackend (the
// local reference) and against a VmBackend whose sshExec is scripted with the ssh-level
// EQUIVALENT outcome (124 where the fake says timedOut, the merged stream where the fake has
// separate stdout/stderr) — and asserts byte-identical final texts.
interface ParityFixture {
	name: string;
	command: string;
	timeout?: number;
	fake: ShellScriptEntry;
	vm: ScriptedVmExec;
}

const PARITY_FIXTURES: ParityFixture[] = [
	{
		name: "exit 0 with stdout → ok text",
		command: "echo hello",
		fake: { match: "echo hello", result: { exitCode: 0 }, stdout: "hello\n" },
		vm: { match: "bash", exitCode: 0, merged: ["hello\n"] },
	},
	{
		name: "exit 0 with no output → '(no output)'",
		command: "true",
		fake: { match: "true", result: { exitCode: 0 } },
		vm: { match: "bash", exitCode: 0 },
	},
	{
		name: "non-zero exit → err 'Command exited with code 3' over the captured output",
		command: "make all",
		fake: { match: "make", result: { exitCode: 3 }, stdout: "building...\n", stderr: "make: error\n" },
		vm: { match: "bash", exitCode: 3, merged: ["building...\n", "make: error\n"] },
	},
	{
		name: "guest timeout (wrapper's 124) → err 'Command timed out after N seconds' over captured output",
		command: "sleep 30",
		timeout: 2,
		fake: { match: "sleep", result: { exitCode: -1, timedOut: true }, stdout: "started\n" },
		vm: { match: "bash", exitCode: 124, merged: ["started\n"] },
	},
	{
		name: "guest timeout (124) with no output → the bare status line",
		command: "hang",
		timeout: 1,
		fake: { match: "hang", result: { exitCode: -1, timedOut: true } },
		vm: { match: "bash", exitCode: 124 },
	},
	{
		name: "multi-chunk merged stream → arrival order preserved",
		command: "build --all",
		fake: { match: "build", result: { exitCode: 0 }, stdout: "step-one-", stderr: "step-two-", chunkDelayMs: 1 },
		vm: { match: "bash", exitCode: 0, merged: ["step-", "one-", "step-two-"] },
	},
	{
		name: "signal death (-1, no timeout) → ok, the old null-exit branch",
		command: "kill -9 $$",
		fake: { match: "kill", result: { exitCode: -1 }, stdout: "partial\n" },
		vm: { match: "bash", exitCode: -1, merged: ["partial\n"] },
	},
];

describe("bash tool parity: FakeBackend (local reference) vs VmBackend (scripted ssh)", () => {
	for (const fixture of PARITY_FIXTURES) {
		it(fixture.name, async () => {
			// The local reference: 23e's scripted FakeBackend, spawn-free.
			const localBackend = fakeBackend({ dirs: ["/work"], script: [fixture.fake] });
			const localRes = await bashTool.execute(
				{ command: fixture.command, timeout: fixture.timeout },
				{ rootDir: "/work", backend: localBackend },
			);
			// The VM twin: same tool, VmBackend, sshExec scripted with the ssh-level outcome.
			// The leading `test -e` entry answers bash.ts's fs.exists precheck (25b's fs op
			// rides the same seam); outputs stay under the truncation caps, so the
			// accumulator never spills (the fake's overflowPath mint is a pure string).
			const { exec } = recordingExec([{ match: "test -e", exitCode: 0 }, fixture.vm]);
			const vmBackend = createVmBackend(SPEC, { exec });
			const vmRes = await bashTool.execute(
				{ command: fixture.command, timeout: fixture.timeout },
				{ rootDir: "/work", backend: vmBackend },
			);
			expect(vmRes.ok).toBe(localRes.ok);
			expect(outcomeText(vmRes)).toBe(outcomeText(localRes));
		});
	}

	// Pin two literals outright so the parity claim does not lean on FakeBackend staying stable.
	it("pinned literals: the vm texts are exactly the 23e shapes", async () => {
		const { exec } = recordingExec([
			// Two executes → two fs.exists prechecks → two `test -e` answers.
			{ match: "test -e", exitCode: 0 },
			{ match: "test -e", exitCode: 0 },
			{ match: "bash", exitCode: 0, merged: ["hello\n"] },
			{ match: "bash", exitCode: 124 },
		]);
		const backend = createVmBackend(SPEC, { exec });
		const ok = await bashTool.execute({ command: "echo hello" }, { rootDir: "/work", backend });
		expect(outcomeText(ok)).toBe("hello\n");
		const timed = await bashTool.execute({ command: "hang", timeout: 1 }, { rootDir: "/work", backend });
		expect(outcomeText(timed)).toBe("Command timed out after 1 seconds");
	});
});

// ------------------------------------------------------ real-bash wrapper gates ----
// The unit fakes prove CONSTRUCTION (the argv that would ride ssh). These gates execute the
// actual scripts through the host's real bash + coreutils — the closest hermetic stand-in for
// the guest — so the SEMANTICS are verified, not trusted: pipeline exit propagation, the merged
// tee stream, the guest-side timeout kill, the guarded env prefix, and the argv twin's
// no-re-parse. Skip — never fail — where bash/coreutils are absent (the ssh.test.ts precedent).

const BASH = statSync("/bin/bash", { throwIfNoEntry: false })?.isFile() ? "/bin/bash" : undefined;

function commandPath(bin: string): string | undefined {
	if (BASH === undefined) return undefined;
	const probe = spawnSync(BASH, ["-c", `command -v ${bin}`], { encoding: "utf8" });
	const path = probe.stdout.trim();
	return probe.status === 0 && path !== "" && !path.includes("\n") ? path : undefined;
}

const TIMEOUT_BIN = commandPath("timeout");
const COREUTILS = BASH !== undefined && TIMEOUT_BIN !== undefined && commandPath("tee") !== undefined;
const itBash = COREUTILS ? it : it.skip;

/**
 * Run the wrapper script exactly as sshd would hand it to the guest's bash: argv is
 * `bash -c <script> <name> <$1> <$2> …` — the FIRST slot is the $0 name operand ("bash" for
 * runShell's wrapper, the bin for the argv twin), mirroring the backend's construction.
 */
function runScript(
	script: string,
	slots: string[],
	opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = realSpawn(BASH ?? "/bin/bash", ["-c", script, ...slots], {
			env: opts.env ?? process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => reject(error));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
	});
}

describe("wrapper scripts against real bash", () => {
	let home: string;
	let work: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "openhammer-vmbackend-home-"));
		work = mkdtempSync(join(tmpdir(), "openhammer-vmbackend-work-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
		rmSync(work, { recursive: true, force: true });
	});

	// The guest environment stand-in: HOME points at a controlled dir (no real
	// ~/.openhammer/env can leak in or be missed), PATH keeps coreutils resolvable.
	const guestEnv = (): NodeJS.ProcessEnv => ({ ...process.env, HOME: home });

	itBash(
		"exit codes propagate through the pipeline; the merged stream tees to the file",
		async () => {
			const overflow = join(home, "ov.log");
			const { code, stdout, stderr } = await runScript(
				RUN_SHELL_SCRIPT,
				["bash", work, "30", "echo out; echo err >&2; exit 3", overflow],
				{ env: guestEnv() },
			);
			expect(code).toBe(3);
			// 2>&1 merged GUEST-side: both lines ride the one pipe, in write order.
			expect(stdout).toBe("out\nerr\n");
			expect(stderr).toBe("");
			// tee's copy is the full merged stream at the $4 slot.
			expect(readFileSync(overflow, "utf8")).toBe("out\nerr\n");
		},
		15000,
	);

	itBash(
		"the guarded env prefix exports ~/.openhammer/env into the command (22-measured gate 4)",
		async () => {
			mkdirSync(join(home, ".openhammer"), { recursive: true });
			writeFileSync(join(home, ".openhammer", "env"), "OH_VM_TEST=prefix-works\n");
			const { code, stdout } = await runScript(
				RUN_SHELL_SCRIPT,
				["bash", work, "30", `printf 'P:%s' "$OH_VM_TEST"`, join(home, "ov.log")],
				{ env: guestEnv() },
			);
			expect(code).toBe(0);
			expect(stdout).toBe("P:prefix-works");
		},
		15000,
	);

	itBash(
		"the prefix is silent when ~/.openhammer/env does not exist (the [ ! -f ] guard)",
		async () => {
			const { code, stdout, stderr } = await runScript(
				RUN_SHELL_SCRIPT,
				["bash", work, "30", "printf ok", join(home, "ov.log")],
				{ env: guestEnv() },
			);
			expect(code).toBe(0);
			expect(stdout).toBe("ok");
			expect(stderr).toBe(""); // no sourcing error pollutes the merged stream
		},
		15000,
	);

	itBash(
		"the timeout wrapper kills the command and exits 124 (TERM, well before -k is needed)",
		async () => {
			const start = Date.now();
			const { code, stdout } = await runScript(
				RUN_SHELL_SCRIPT,
				["bash", work, "1", "sleep 30", join(home, "ov.log")],
				{ env: guestEnv() },
			);
			expect(code).toBe(124);
			expect(stdout).toBe("");
			expect(Date.now() - start).toBeLessThan(10000); // killed at ~1s, not after sleep 30
		},
		15000,
	);

	itBash(
		"a missing cd target exits 125 (the wrapper-environment failure code)",
		async () => {
			const { code } = await runScript(
				RUN_SHELL_SCRIPT,
				["bash", "/no/such/openhammer-dir", "30", "printf unreachable", join(home, "ov.log")],
				{ env: guestEnv() },
			);
			expect(code).toBe(125);
		},
		15000,
	);

	itBash(
		"the overflow dir is created by the script (tee never fails on a fresh tree)",
		async () => {
			const overflow = join(home, "made", "by", "script.log");
			const { code } = await runScript(RUN_SHELL_SCRIPT, ["bash", work, "30", "printf hi", overflow], {
				env: guestEnv(),
			});
			expect(code).toBe(0);
			expect(readFileSync(overflow, "utf8")).toBe("hi");
		},
		15000,
	);

	itBash(
		"the argv twin execs $0 with the true argv — a hostile operand stays ONE element",
		async () => {
			const hostile = 'it\'s $(x) `y` -dash "q"';
			const { code, stdout } = await runScript(RUN_ARGV_SCRIPT, ["printf", work, "30", "[%s]", hostile], {
				env: guestEnv(),
			});
			expect(code).toBe(0);
			// printf saw exactly two arguments; a re-parse/split would yield several bracketed words.
			expect(stdout).toBe(`[${hostile}]`);
		},
		15000,
	);

	itBash(
		"the argv twin propagates exit codes and kills under timeout like runShell",
		async () => {
			const failing = await runScript(RUN_ARGV_SCRIPT, ["bash", work, "30", "-c", "exit 7"], { env: guestEnv() });
			expect(failing.code).toBe(7);
			const start = Date.now();
			const timed = await runScript(RUN_ARGV_SCRIPT, ["sleep", work, "1", "30"], { env: guestEnv() });
			expect(timed.code).toBe(124);
			expect(Date.now() - start).toBeLessThan(10000);
		},
		15000,
	);
});
