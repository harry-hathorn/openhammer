// Agent-session start (spec 29's "The session, started") — the one tmux command an agent-mode
// boot issues inside the guest, run in the extras phase right after the secrets push so the
// agent's first prompt already has its credentials. The session IS agent mode's whole product
// (the no-LLM clause): OpenHammer starts a DETACHED tmux session running the operator's
// command inside the guest and then never touches it again.
//
// OPENHAMMER-NEVER-REACTS (pinned by structure, not by comment alone): this module has no
// read path. The session is created `-d` (detached); no pane is captured, no keys are sent,
// no output is parsed, no state is watched — runArgv is called with NO onStdout reader (and
// only a bounded stderr collector on the failure path, so tmux's OWN error text can land in
// the thrown message; that is infrastructure feedback, never the session's pane). All
// judgment originates in the outer MCP client; the supervision doctrine — how a client
// DRIVES this session (capture-pane / send-keys / `omarchy agent prompt`) — is the
// agent-mode guide copy (29c), not code here. Restart is likewise not ours: the recipe is
// `tmux kill-session -t agent` + new-session, issued over plain bash by the client/operator
// (the spec's edge case: a dead tmux at supervision time is a bash-fixable state).
//
// THE COMMAND RIDES ARGV, VERBATIM: `MCP_VM_AGENT_CMD` (default "claude") is OPERATOR
// CONFIG, not client input, so the only validation here is non-emptiness — a belt over
// config.ts's boundary parse, which already rejects an empty setting. It travels as the
// LAST argv element of ONE `backend.runArgv("tmux", [...])` — the VmBackend's runArgv
// delivers each element to the guest whole (remoteQuote on the transport half, `exec`
// replacement on the guest half), so a cmd with quotes or flags (e.g. the documented
// `--dangerously-skip-permissions` opt-in) arrives byte-identical, never spliced into a
// shell string.
//
// IDEMPOTENT: `tmux has-session -t agent` first — rc 0 → report already-running and issue NO
// new-session. A service restart's fresh guest has no tmux session anyway (agent mode
// discards its overlay), so this guards a re-entrant extras phase (a relaunch/reuse boot
// finding the session its own predecessor started).
//
// ERROR MODEL: any failure THROWS (empty cmd before any spawn; a non-zero new-session exit,
// with the bounded stderr tail named) — the CALLER owns fatal-vs-logged, and the service
// wiring decides NON-FATAL (service.ts, consistent with the secrets push: the sandbox is up
// either way, and the remedy is a bash one-liner).
import type { ToolBackend } from "../tools/backend.ts";

/** The tmux session name the agent runs in (the guide's `-t agent` target everywhere). */
export const AGENT_SESSION_NAME = "agent";

/** The fixed pane geometry (spec 29: `-x 220 -y 50` — the guide's capture/send coordinates). */
export const AGENT_SESSION_WIDTH = 220;
export const AGENT_SESSION_HEIGHT = 50;

/** What one start amounted to — the wiring's log line and the tests' assertion target. */
export interface SessionReport {
	/** `"started"` = new-session ran; `"already-running"` = has-session found the session. */
	readonly action: "started" | "already-running";
	/** The (constant) tmux session name. */
	readonly session: typeof AGENT_SESSION_NAME;
}

/** The start's inputs — both guest-side values (the cmd is a guest program; the dir a guest path). */
export interface AgentSessionOpts {
	/** The operator's guest command (`MCP_VM_AGENT_CMD`, default "claude") — verbatim, last slot. */
	readonly agentCmd: string;
	/** The GUEST rootDir the session starts in (the resolved config's rootDir — the guest path). */
	readonly rootDir: string;
}

/**
 * Start — or observe already-running — the detached agent tmux session, per the module
 * header. No deps parameter: every effect already rides the injected backend (its runArgv
 * IS the seam, the same hermetic-fake shape secrets-push tests drive). Throws on an empty
 * agentCmd (before any spawn) or a failed new-session; the caller decides fatal vs logged.
 */
export async function startAgentSession(backend: ToolBackend, opts: AgentSessionOpts): Promise<SessionReport> {
	if (opts.agentCmd.trim() === "") {
		throw new Error(
			'agent session: MCP_VM_AGENT_CMD is empty — set the guest command the tmux session runs (default "claude")',
		);
	}
	const running = await backend.runArgv("tmux", ["has-session", "-t", AGENT_SESSION_NAME], {});
	if (running.exitCode === 0) {
		return { action: "already-running", session: AGENT_SESSION_NAME };
	}
	let stderrTail = "";
	const created = await backend.runArgv(
		"tmux",
		[
			"new-session",
			"-d",
			"-s",
			AGENT_SESSION_NAME,
			"-x",
			String(AGENT_SESSION_WIDTH),
			"-y",
			String(AGENT_SESSION_HEIGHT),
			"-c",
			opts.rootDir,
			opts.agentCmd, // LAST: the operator's command, one verbatim argv element (the header)
		],
		{
			// tmux's own stderr, for the thrown message only — never the session's pane.
			onStderr: (chunk: Buffer) => {
				stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2048);
			},
		},
	);
	if (created.exitCode !== 0) {
		const detail = created.timedOut ? " (timed out)" : stderrTail.trim() === "" ? "" : `: ${stderrTail.trim()}`;
		throw new Error(`agent session: tmux new-session exited ${created.exitCode}${detail}`);
	}
	return { action: "started", session: AGENT_SESSION_NAME };
}
