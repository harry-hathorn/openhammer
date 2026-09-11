// agent-session tests — spec 29's tmux command construction. A recording backend fake asserts
// the EXACT argv shapes (has-session probe; the new-session form with the fixed geometry and
// the agentCmd riding the LAST slot), the idempotency branch (has-session rc 0 → no
// new-session), the verbatim contract (a hostile-ish cmd arrives unmodified — arg arrays, no
// shell splicing), and the throw paths (empty cmd before any spawn; a failed new-session).
// The never-reacts discipline is pinned structurally: no stdout reader is EVER attached.
import { describe, expect, it } from "vitest";
import type { ToolBackend } from "../tools/backend.ts";
import { ok } from "../tools/result.ts";
import { AGENT_SESSION_HEIGHT, AGENT_SESSION_NAME, AGENT_SESSION_WIDTH, startAgentSession } from "./agent-session.ts";

const ROOT_DIR = "/home/sandbox/work";
const AGENT_CMD = "claude";

/** Which stream readers one runArgv call carried (the never-reacts pin: stdout must never appear). */
interface RecordedCall {
	readonly argv: string[];
	readonly onStdout: boolean;
	readonly onStderr: boolean;
}

interface RecordingBackend extends ToolBackend {
	readonly calls: RecordedCall[];
}

function fakeBackend(
	options: { hasSessionExit?: number; newSessionExit?: number; newSessionStderr?: string } = {},
): RecordingBackend {
	const calls: RecordedCall[] = [];
	const notUsed = (): Promise<never> => Promise.reject(new Error("not used in this test"));
	return {
		kind: "vm",
		homedir: () => "/home/sandbox",
		fs: {
			readFile: notUsed,
			access: notUsed,
			stat: notUsed,
			readdir: notUsed,
			writeFile: notUsed,
			mkdir: notUsed,
			exists: async () => ok(false),
		},
		runShell: notUsed,
		runArgv: async (bin, args, opts) => {
			calls.push({
				argv: [bin, ...args],
				onStdout: opts?.onStdout !== undefined,
				onStderr: opts?.onStderr !== undefined,
			});
			if (args[0] === "has-session") {
				return { exitCode: options.hasSessionExit ?? 1, timedOut: false }; // 1 = no session (tmux's "not found")
			}
			if (options.newSessionStderr !== undefined && opts?.onStderr !== undefined) {
				opts.onStderr(Buffer.from(options.newSessionStderr, "utf8"));
			}
			return { exitCode: options.newSessionExit ?? 0, timedOut: false };
		},
		probe: () => false,
		probeFlag: () => false,
		overflowPath: () => "/tmp/.openhammer/unused.log",
		close: async () => {},
		calls,
	};
}

const NEW_SESSION_ARGV = (agentCmd: string): string[] => [
	"tmux",
	"new-session",
	"-d",
	"-s",
	AGENT_SESSION_NAME,
	"-x",
	String(AGENT_SESSION_WIDTH),
	"-y",
	String(AGENT_SESSION_HEIGHT),
	"-c",
	ROOT_DIR,
	agentCmd,
];

describe("startAgentSession", () => {
	it("not present: probes has-session, then issues the exact new-session form — agentCmd LAST, no output read", async () => {
		const backend = fakeBackend();
		const report = await startAgentSession(backend, { agentCmd: AGENT_CMD, rootDir: ROOT_DIR });

		expect(report).toEqual({ action: "started", session: "agent" });
		expect(backend.calls.map((call) => call.argv)).toEqual([
			["tmux", "has-session", "-t", "agent"],
			NEW_SESSION_ARGV(AGENT_CMD),
		]);
		// The never-reacts pin, structural: no stdout reader is EVER attached to either call —
		// there is no read path for the agent's output (the stderr collector below is the only
		// reader, and only on the new-session call, for the failure message).
		expect(backend.calls.map((call) => call.onStdout)).toEqual([false, false]);
		expect(backend.calls.map((call) => call.onStderr)).toEqual([false, true]);
	});

	it("idempotent: has-session rc 0 → no new-session issued, report already-running", async () => {
		const backend = fakeBackend({ hasSessionExit: 0 });
		const report = await startAgentSession(backend, { agentCmd: AGENT_CMD, rootDir: ROOT_DIR });

		expect(report).toEqual({ action: "already-running", session: "agent" });
		expect(backend.calls.map((call) => call.argv)).toEqual([["tmux", "has-session", "-t", "agent"]]);
	});

	it("agentCmd rides the last argv element UNMODIFIED — flags, quotes, shell metacharacters intact", async () => {
		const backend = fakeBackend();
		// The spec's documented opt-in flag plus shapes a shell string would mangle: a quoted
		// arg with a space, `$HOME`, a semicolon, a single quote.
		const hostile = "claude --dangerously-skip-permissions --model \"sonnet 4\" $HOME; echo 'hi'";
		const report = await startAgentSession(backend, { agentCmd: hostile, rootDir: ROOT_DIR });

		expect(report.action).toBe("started");
		const created = backend.calls[1];
		expect(created?.argv).toEqual(NEW_SESSION_ARGV(hostile));
		expect(created?.argv.at(-1)).toBe(hostile); // byte-identical — never re-parsed, never spliced
	});

	it("an empty agentCmd throws BEFORE any spawn (operator config's one validation — the belt over config.ts)", async () => {
		for (const empty of ["", "   "]) {
			const backend = fakeBackend();
			await expect(startAgentSession(backend, { agentCmd: empty, rootDir: ROOT_DIR })).rejects.toThrow(
				"agent session: MCP_VM_AGENT_CMD is empty",
			);
			expect(backend.calls).toEqual([]); // nothing ran
		}
	});

	it("a failed new-session throws with the exit code and tmux's stderr tail", async () => {
		const backend = fakeBackend({ newSessionExit: 1, newSessionStderr: "duplicate session: agent\n" });
		await expect(startAgentSession(backend, { agentCmd: AGENT_CMD, rootDir: ROOT_DIR })).rejects.toThrow(
			"agent session: tmux new-session exited 1: duplicate session: agent",
		);
	});

	it("a failed new-session without stderr degrades to the bare exit code", async () => {
		const silent = fakeBackend({ newSessionExit: 127 });
		await expect(startAgentSession(silent, { agentCmd: AGENT_CMD, rootDir: ROOT_DIR })).rejects.toThrow(
			"agent session: tmux new-session exited 127",
		);
	});
});
