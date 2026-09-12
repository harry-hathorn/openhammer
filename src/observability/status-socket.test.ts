import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RequestEvent, RequestRecorder } from "../mcp/telemetry.ts";
import { parseEventLine } from "../tui/monitor-view.ts";
import type { VmStatus } from "../vm/service.ts";
import {
	type ChannelStateLine,
	formatChannelStateLine,
	formatEventLine,
	formatVmCmdResultLine,
	formatVmStateLine,
	handleConnection,
	MAX_VM_COMMAND_BYTES,
	parseChannelStateLine,
	parseVmCmdResultLine,
	parseVmCommand,
	parseVmStateLine,
	runVmCommand,
	type StatusSocket,
	startStatusSocket,
	statusSocketPath,
	type VmCmdResultLine,
	type VmCommandExecutor,
	type VmCommandOutcome,
	type VmCommandRequest,
	type VmStateLine,
	vmStateLineFromStatus,
} from "./status-socket.ts";

/** A minimal recording socket conforming to {@link StatusSocket} (no real I/O). */
function fakeSocket(): StatusSocket & {
	emit(event: "close" | "error"): void;
	failNext(v: boolean): void;
	/** Deliver a chunk to the registered data listener (command intake). */
	data(chunk: Buffer | string): void;
	wasDestroyed(): boolean;
	/** Was a data listener ever registered? (`commands === undefined` must never wire one.) */
	hasDataListener(): boolean;
	lines: string[];
} {
	const lines: string[] = [];
	const handlers = new Map<string, () => void>();
	let failNext = false;
	let destroyCount = 0;
	let dataHandler: ((chunk: Buffer) => void) | undefined;
	return {
		write(chunk) {
			if (failNext) {
				failNext = false;
				return false;
			}
			lines.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		},
		once(event, listener) {
			handlers.set(event, listener);
		},
		on(event, listener) {
			if (event === "data") dataHandler = listener;
		},
		off(event, listener) {
			if (event === "data" && dataHandler === listener) dataHandler = undefined;
		},
		destroy() {
			destroyCount += 1;
		},
		emit(event) {
			handlers.get(event)?.();
		},
		data(chunk) {
			dataHandler?.(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
		},
		wasDestroyed() {
			return destroyCount > 0;
		},
		hasDataListener() {
			return dataHandler !== undefined;
		},
		failNext(v) {
			failNext = v;
		},
		lines,
	};
}

/** Build a minimal event. */
function event(ts: string, tool: string | null = null): RequestEvent {
	return {
		ts,
		client: "claude-code/1.0",
		method: "tools/call",
		tool,
		reqBytes: 1,
		resBytes: 2,
		ms: 3,
		status: 200,
	};
}

/** Build a channel-state line. */
function channelState(id: string, up: boolean, url: string | null): ChannelStateLine {
	return { type: "channel-state", id, up, url };
}

/** Build a vm-state line (spec 27h). */
function vmState(over: Partial<VmStateLine> = {}): VmStateLine {
	return {
		type: "vm-state",
		state: "ready",
		sessionId: "vm-20260911T101112Z-ab",
		phase: null,
		sshPort: 42255,
		error: null,
		...over,
	};
}

/** Build a full `VmStatus` (vm/service.ts's snapshot) for the mapper tests. */
function vmStatus(over: Partial<VmStatus> = {}): VmStatus {
	return {
		state: "booting",
		phase: "ssh",
		sessionId: "vm-1",
		sshPort: null,
		bootStartedAt: 1000,
		bootTimeoutMs: 180_000,
		readyAt: null,
		error: null,
		relaunchUsed: false,
		...over,
	};
}

/** An executor that records every request and answers with a fixed outcome. */
function recordingExecutor(outcome: VmCommandOutcome = { ok: true, error: null }): VmCommandExecutor & {
	requests: VmCommandRequest[];
} {
	const requests: VmCommandRequest[] = [];
	const exec: VmCommandExecutor = (request) => {
		requests.push(request);
		return outcome;
	};
	return Object.assign(exec, { requests });
}

/** Clean up any temp dirs created during a test. */
const tempDirs: string[] = [];
afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	}
});

/** A unique temp dir under the OS tmpdir. */
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "oh-status-"));
	tempDirs.push(dir);
	return dir;
}

describe("statusSocketPath + formatEventLine", () => {
	it("resolves under ~/.openhammer/openhammer.sock", () => {
		expect(statusSocketPath("/home/u")).toBe(join("/home/u", ".openhammer", "openhammer.sock"));
	});

	it("serializes an event as compact JSON + newline", () => {
		const line = formatEventLine(event("1", "bash"));
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line)).toMatchObject({ ts: "1", tool: "bash" });
	});
});

describe("channel-state wire format", () => {
	it("serializes a channel-state line as compact JSON + newline", () => {
		const line = formatChannelStateLine(channelState("deployed", true, "https://x.ngrok.app"));
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line)).toMatchObject({
			type: "channel-state",
			id: "deployed",
			up: true,
			url: "https://x.ngrok.app",
		});
	});

	it("parses a well-formed channel-state line", () => {
		expect(parseChannelStateLine(formatChannelStateLine(channelState("a", false, null)))).toEqual(
			channelState("a", false, null),
		);
	});

	it("returns null for blank / malformed / non-channel-state lines", () => {
		// A RequestEvent line shares the socket but carries no `type` → not channel-state.
		expect(parseChannelStateLine(formatEventLine(event("1", "bash")))).toBeNull();
		expect(parseChannelStateLine("")).toBeNull();
		expect(parseChannelStateLine("not-json")).toBeNull();
		// Right shape, wrong value types → rejected (never mis-parsed).
		expect(
			parseChannelStateLine(JSON.stringify({ type: "channel-state", id: "a", up: "yes", url: null })),
		).toBeNull();
		expect(parseChannelStateLine(JSON.stringify({ type: "event", id: "a", up: true, url: null }))).toBeNull();
	});
});

describe("vm-state wire format (spec 27h)", () => {
	it("serializes a vm-state line as compact JSON + newline", () => {
		const line = formatVmStateLine(vmState());
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line)).toMatchObject({ type: "vm-state", state: "ready", sshPort: 42255 });
	});

	it("parses a well-formed vm-state line", () => {
		const booting = vmState({ state: "booting", phase: "ssh", sessionId: null, sshPort: null });
		expect(parseVmStateLine(formatVmStateLine(booting))).toEqual(booting);
	});

	it("returns null for blank / malformed / non-vm-state lines (the additive-parse rule)", () => {
		expect(parseVmStateLine("")).toBeNull();
		expect(parseVmStateLine("not-json")).toBeNull();
		// A future/unknown line kind parses to null — never mis-rendered, never fatal.
		expect(parseVmStateLine(JSON.stringify({ type: "future-thing" }))).toBeNull();
		// The other line kinds share the socket but are not vm-state.
		expect(parseVmStateLine(formatEventLine(event("1", "bash")))).toBeNull();
		expect(parseVmStateLine(formatChannelStateLine(channelState("a", true, null)))).toBeNull();
		// Right type, wrong value shapes → rejected (never mis-parsed).
		expect(parseVmStateLine(JSON.stringify({ type: "vm-state", state: "FROBNICATED" }))).toBeNull();
		expect(parseVmStateLine(JSON.stringify({ type: "vm-state", state: "ready", sshPort: "42255" }))).toBeNull();
		expect(parseVmStateLine(JSON.stringify({ type: "vm-state", state: "ready", sessionId: 7 }))).toBeNull();
	});

	it("maps the service status snapshot to the wire line (phase none → null)", () => {
		expect(vmStateLineFromStatus(vmStatus())).toEqual(
			vmState({ state: "booting", phase: "ssh", sessionId: "vm-1", sshPort: null }),
		);
		expect(vmStateLineFromStatus(vmStatus({ state: "ready", phase: "none", sshPort: 42255 }))).toEqual(
			vmState({ sessionId: "vm-1", phase: null, sshPort: 42255 }),
		);
		const failed = vmStatus({ state: "failed", error: "sandbox boot failed: no golden" });
		expect(vmStateLineFromStatus(failed)).toEqual(
			vmState({
				state: "failed",
				sessionId: "vm-1",
				phase: "ssh",
				sshPort: null,
				error: "sandbox boot failed: no golden",
			}),
		);
	});
});

describe("vm-command wire format (28i)", () => {
	it("serializes a vm-cmd-result line as compact JSON + newline", () => {
		const line = formatVmCmdResultLine({ type: "vm-cmd-result", cmd: "vm-stop", ok: true, error: null });
		expect(line.endsWith("\n")).toBe(true);
		expect(JSON.parse(line)).toMatchObject({ type: "vm-cmd-result", cmd: "vm-stop", ok: true, error: null });
	});

	it("parses a well-formed vm-cmd-result line", () => {
		const refusal: VmCmdResultLine = {
			type: "vm-cmd-result",
			cmd: "vm-restart",
			ok: false,
			error: "nothing to stop — the sandbox boot mode is off",
		};
		expect(parseVmCmdResultLine(formatVmCmdResultLine(refusal))).toEqual(refusal);
	});

	it("returns null for blank / malformed / other-line-kind inputs (the additive rule)", () => {
		expect(parseVmCmdResultLine("")).toBeNull();
		expect(parseVmCmdResultLine("not-json")).toBeNull();
		// A future/unknown line kind parses to null — never mis-rendered, never fatal.
		expect(parseVmCmdResultLine(JSON.stringify({ type: "future-thing" }))).toBeNull();
		// The other three line kinds share the socket but are not vm-cmd-result.
		expect(parseVmCmdResultLine(formatEventLine(event("1", "bash")))).toBeNull();
		expect(parseVmCmdResultLine(formatChannelStateLine(channelState("a", true, null)))).toBeNull();
		expect(parseVmCmdResultLine(formatVmStateLine(vmState()))).toBeNull();
		// Right type, wrong value shapes → rejected (never mis-parsed).
		expect(parseVmCmdResultLine(JSON.stringify({ type: "vm-cmd-result", cmd: 7, ok: true, error: null }))).toBeNull();
		expect(
			parseVmCmdResultLine(JSON.stringify({ type: "vm-cmd-result", cmd: "x", ok: "yes", error: null })),
		).toBeNull();
	});

	it("parseVmCommand accepts exactly the two verbs (extra keys tolerated)", () => {
		expect(parseVmCommand('{"cmd":"vm-stop"}')).toEqual({ cmd: "vm-stop" });
		expect(parseVmCommand('  {"cmd":"vm-restart"}\n')).toEqual({ cmd: "vm-restart" });
		expect(parseVmCommand('{"cmd":"vm-stop","req":1}')).toMatchObject({ cmd: "vm-stop" });
	});

	it("parseVmCommand refuses blank / malformed / wrong-verb payloads", () => {
		expect(parseVmCommand("")).toBeNull();
		expect(parseVmCommand("{")).toBeNull();
		expect(parseVmCommand("42")).toBeNull();
		expect(parseVmCommand('"vm-stop"')).toBeNull();
		expect(parseVmCommand('{"cmd":"vm-open"}')).toBeNull();
		expect(parseVmCommand('{"cmd":7}')).toBeNull();
		expect(parseVmCommand('{"req":1}')).toBeNull();
	});
});

describe("runVmCommand", () => {
	it("executes a parsed command and echoes the verdict", () => {
		const exec = recordingExecutor();
		const reply = runVmCommand('{"cmd":"vm-stop"}', exec);
		expect(exec.requests).toEqual([{ cmd: "vm-stop" }]);
		expect(reply).toEqual({ type: "vm-cmd-result", cmd: "vm-stop", ok: true, error: null });
	});

	it("carries the executor's refusal through verbatim", () => {
		const exec = recordingExecutor({ ok: false, error: "nothing to stop — the sandbox boot mode is off" });
		const reply = runVmCommand('{"cmd":"vm-stop"}', exec);
		expect(reply.ok).toBe(false);
		expect(reply.error).toBe("nothing to stop — the sandbox boot mode is off");
	});

	it("answers malformed JSON with ok:false naming the problem (never throws)", () => {
		const exec = recordingExecutor();
		const reply = runVmCommand("{not json", exec);
		expect(exec.requests).toHaveLength(0);
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not JSON");
		expect(reply.cmd).toBe("{not json");
	});

	it("answers a wrong-verb payload with ok:false echoing the attempted cmd", () => {
		const reply = runVmCommand('{"cmd":"vm-open"}', recordingExecutor());
		expect(reply.ok).toBe(false);
		expect(reply.error).toContain("not a vm command");
		expect(reply.cmd).toBe("vm-open");
	});

	it("bounds the echo of a runaway payload", () => {
		const reply = runVmCommand("x".repeat(500), recordingExecutor());
		expect(reply.cmd.length).toBeLessThanOrEqual(80);
	});
});

describe("vm-cmd-result is additive across every consumer parser", () => {
	it("parses to null in parseEventLine / parseChannelStateLine / parseVmStateLine", () => {
		const line = formatVmCmdResultLine({ type: "vm-cmd-result", cmd: "vm-stop", ok: true, error: null });
		expect(parseEventLine(line)).toBeNull();
		expect(parseChannelStateLine(line)).toBeNull();
		expect(parseVmStateLine(line)).toBeNull();
	});
});

describe("handleConnection (fake socket)", () => {
	it("dumps the recent buffer, then streams live events", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		recorder.record(event("2", "read"));
		const socket = fakeSocket();

		handleConnection(socket, recorder);
		expect(socket.lines).toHaveLength(2); // dump delivered
		expect(JSON.parse(socket.lines[0] ?? "{}").ts).toBe("1");
		expect(JSON.parse(socket.lines[1] ?? "{}").ts).toBe("2");

		recorder.record(event("3", "ls")); // live
		expect(socket.lines).toHaveLength(3);
		expect(JSON.parse(socket.lines[2] ?? "{}").ts).toBe("3");
	});

	it("cleans up + unsubscribes when a dump write fails", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1"));
		const socket = fakeSocket();
		socket.failNext(true); // the first dump write throws/returns false

		handleConnection(socket, recorder);
		expect(socket.lines).toHaveLength(0); // nothing buffered (failed before push)
		recorder.record(event("2")); // should NOT be delivered (unsubscribed)
		expect(socket.lines).toHaveLength(0);
	});

	it("cleans up + unsubscribes on socket close", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1"));
		const socket = fakeSocket();
		handleConnection(socket, recorder);
		expect(socket.lines).toHaveLength(1);

		socket.emit("close");
		recorder.record(event("2")); // NOT delivered
		expect(socket.lines).toHaveLength(1);
	});

	it("cleans up + unsubscribes on socket error", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		handleConnection(socket, recorder);
		socket.emit("error");
		recorder.record(event("2"));
		expect(socket.lines).toHaveLength(0);
	});

	it("dumps the channel-state snapshot before the event history", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		const socket = fakeSocket();

		handleConnection(socket, recorder, [
			channelState("deployed", true, "https://x.ngrok.app"),
			channelState("down", false, null),
		]);
		// 2 channel-state lines first, then the 1 historical event.
		expect(socket.lines).toHaveLength(3);
		expect(JSON.parse(socket.lines[0] ?? "{}")).toMatchObject({ type: "channel-state", id: "deployed", up: true });
		expect(JSON.parse(socket.lines[1] ?? "{}")).toMatchObject({
			type: "channel-state",
			id: "down",
			up: false,
			url: null,
		});
		expect(JSON.parse(socket.lines[2] ?? "{}").tool).toBe("bash");

		recorder.record(event("2", "ls")); // live event streams after the dumps
		expect(socket.lines).toHaveLength(4);
		expect(JSON.parse(socket.lines[3] ?? "{}").tool).toBe("ls");
	});

	it("stops the channel-state dump when a client is already gone (first write fails)", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1"));
		const socket = fakeSocket();
		socket.failNext(true); // the first channel-state write returns false

		handleConnection(socket, recorder, [channelState("a", true, "https://x")]);
		expect(socket.lines).toHaveLength(0); // nothing buffered; unsubscribed before the event dump
		recorder.record(event("2"));
		expect(socket.lines).toHaveLength(0);
	});

	it("dumps the vm-state snapshot between channel-state and the event history", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		const socket = fakeSocket();

		const booting = vmState({ state: "booting", phase: "ssh", sessionId: null, sshPort: null });
		handleConnection(socket, recorder, [channelState("deployed", true, "https://x")], booting);
		expect(socket.lines).toHaveLength(3);
		expect(JSON.parse(socket.lines[0] ?? "{}").type).toBe("channel-state");
		expect(JSON.parse(socket.lines[1] ?? "{}")).toMatchObject({ type: "vm-state", state: "booting", phase: "ssh" });
		expect(JSON.parse(socket.lines[2] ?? "{}").tool).toBe("bash");
	});

	it("dumps NO vm-state line when the snapshot is null (off mode — the additive rule)", () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		const socket = fakeSocket();

		handleConnection(socket, recorder, [], null);
		expect(socket.lines).toHaveLength(1); // only the event — no vm-state line
		expect(JSON.parse(socket.lines[0] ?? "{}").tool).toBe("bash");
	});

	it("wires command intake only when an executor is given (the byte-identical stream pin)", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		handleConnection(socket, recorder, [], null);
		expect(socket.hasDataListener()).toBe(false);
		socket.data('{"cmd":"vm-stop"}\n'); // nobody home — no crash, no reply
		expect(socket.lines).toHaveLength(0);
	});

	it("executes a command line and answers one result line", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);
		expect(socket.hasDataListener()).toBe(true);

		socket.data('{"cmd":"vm-stop"}\n');
		expect(exec.requests).toEqual([{ cmd: "vm-stop" }]);
		expect(socket.lines).toEqual([
			formatVmCmdResultLine({ type: "vm-cmd-result", cmd: "vm-stop", ok: true, error: null }),
		]);
	});

	it("executes several commands from one chunk, in order, one reply each", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);

		socket.data('{"cmd":"vm-stop"}\n{"cmd":"vm-restart"}\n');
		expect(exec.requests.map((r) => r.cmd)).toEqual(["vm-stop", "vm-restart"]);
		expect(socket.lines).toHaveLength(2);
	});

	it("reassembles a command split across chunks before executing it", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);

		socket.data('{"cmd":"vm-');
		expect(exec.requests).toHaveLength(0);
		socket.data('stop"}\n');
		expect(exec.requests).toEqual([{ cmd: "vm-stop" }]);
		expect(socket.lines).toHaveLength(1);
	});

	it("skips blank lines without executing or replying", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);

		socket.data("\n \n");
		expect(exec.requests).toHaveLength(0);
		expect(socket.lines).toHaveLength(0);
	});

	it("answers a malformed line with ok:false instead of silence", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		handleConnection(socket, recorder, [], null, recordingExecutor());

		socket.data("open sesame\n");
		expect(socket.lines).toHaveLength(1);
		const reply = parseVmCmdResultLine(socket.lines[0] ?? "");
		expect(reply?.ok).toBe(false);
		expect(reply?.error).toContain("not JSON");
	});

	it("destroys the connection when the tail passes the cap without a newline", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);

		socket.data(Buffer.alloc(MAX_VM_COMMAND_BYTES + 1, 0x61));
		expect(socket.wasDestroyed()).toBe(true);
		expect(exec.requests).toHaveLength(0);
	});

	it("cleans up when a reply write fails (no further live events)", () => {
		const recorder = new RequestRecorder();
		const socket = fakeSocket();
		const exec = recordingExecutor();
		handleConnection(socket, recorder, [], null, exec);
		socket.failNext(true);

		socket.data('{"cmd":"vm-stop"}\n');
		expect(exec.requests).toHaveLength(1); // executed
		expect(socket.lines).toHaveLength(0); // the reply write failed → unsubscribed
		recorder.record(event("2"));
		expect(socket.lines).toHaveLength(0); // not delivered
	});
});

/**
 * Real Unix-domain-socket end-to-end (hermetic — local socket, no network):
 * proves dump-then-stream, the 0600 mode, clean close, and the null-safe bind
 * failure.
 */
describe("startStatusSocket (real net)", () => {
	/** Connect a real client that collects NDJSON lines; resolves once `n` arrive. */
	function collectLines(path: string): {
		lines: string[];
		waitFor: (n: number, ms?: number) => Promise<void>;
		send: (text: string) => void;
		close: () => void;
	} {
		const lines: string[] = [];
		let buf = "";
		const waiters: Array<{ n: number; resolve: () => void }> = [];
		const socket = createConnection(path);
		socket.on("data", (chunk) => {
			buf += chunk.toString("utf8");
			let idx = buf.indexOf("\n");
			while (idx >= 0) {
				lines.push(buf.slice(0, idx));
				buf = buf.slice(idx + 1);
				idx = buf.indexOf("\n");
			}
			for (const w of waiters.splice(0)) {
				if (lines.length >= w.n) w.resolve();
			}
		});
		return {
			lines,
			waitFor(n, ms = 2000) {
				if (lines.length >= n) return Promise.resolve();
				return new Promise((resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error(`timed out waiting for ${n} lines (got ${lines.length})`)),
						ms,
					);
					waiters.push({
						n,
						resolve: () => {
							clearTimeout(timer);
							resolve();
						},
					});
				});
			},
			send: (text) => socket.write(text),
			close: () => socket.destroy(),
		};
	}

	it("dumps the buffer, streams live, binds 0600, and cleans up on close", async () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		recorder.record(event("2", "read"));
		const path = join(tempDir(), "openhammer.sock");

		const handle = await startStatusSocket(recorder, { path, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		// Mode 0600 — owner-only, the local-only gate (auth-free by file perms).
		expect(statSync(path).mode & 0o777).toBe(0o600);

		const collector = collectLines(path);
		try {
			await collector.waitFor(2); // dump of the 2 pre-recorded events
			expect(JSON.parse(collector.lines[0] ?? "{}").ts).toBe("1");

			recorder.record(event("3", "ls")); // live event
			await collector.waitFor(3);
			expect(collector.lines).toHaveLength(3);
			expect(JSON.parse(collector.lines[2] ?? "{}").tool).toBe("ls");
		} finally {
			collector.close();
		}

		await handle.close();
		expect(existsSync(path)).toBe(false); // socket file removed
	});

	it("returns null when it cannot bind (parent path is a file → ENOTDIR)", async () => {
		const dir = tempDir();
		const blocker = join(dir, "blocker"); // a file, not a dir
		writeFileSync(blocker, "");
		const handle = await startStatusSocket(new RequestRecorder(), {
			path: join(blocker, "x.sock"),
			warn: () => {},
		});
		expect(handle).toBeNull();
	});

	it("dumps the channel-state snapshot to a connecting client (before events)", async () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		const path = join(tempDir(), "openhammer.sock");

		const handle = await startStatusSocket(recorder, {
			path,
			channels: [channelState("deployed", true, "https://edge.example/mcp")],
			warn: () => {},
		});
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const collector = collectLines(path);
		try {
			await collector.waitFor(2); // channel-state line, then the 1 historical event
			expect(JSON.parse(collector.lines[0] ?? "{}")).toMatchObject({
				type: "channel-state",
				id: "deployed",
				up: true,
				url: "https://edge.example/mcp",
			});
			expect(JSON.parse(collector.lines[1] ?? "{}").tool).toBe("bash");
		} finally {
			collector.close();
		}
		await handle.close();
	});

	it("dumps the latest vm-state per connect and streams transitions to connected clients (27h)", async () => {
		const recorder = new RequestRecorder();
		const path = join(tempDir(), "openhammer.sock");
		// The caller-owned latest-state ref (main.ts holds it; the socket reads it
		// PER connect via the getter) — mutable here to prove the dump carries the
		// latest, not a bind-time copy.
		let latest: VmStateLine | null = vmState({ state: "booting", phase: "ssh", sessionId: null, sshPort: null });

		const handle = await startStatusSocket(recorder, { path, vmState: () => latest, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const first = collectLines(path);
		try {
			await first.waitFor(1); // the vm-state dump (no channels, no events)
			expect(JSON.parse(first.lines[0] ?? "{}")).toMatchObject({
				type: "vm-state",
				state: "booting",
				phase: "ssh",
			});

			// A transition: the ref moves + emitVmState streams to the connected client.
			latest = vmState({ state: "ready", sessionId: "vm-20260911T101112Z-ab", sshPort: 42255 });
			handle.emitVmState(latest);
			await first.waitFor(2);
			expect(JSON.parse(first.lines[1] ?? "{}")).toMatchObject({
				type: "vm-state",
				state: "ready",
				sessionId: "vm-20260911T101112Z-ab",
				sshPort: 42255,
			});
		} finally {
			first.close();
		}

		// A LATER connect dumps the latest state (not the state the socket was seeded with).
		const second = collectLines(path);
		try {
			await second.waitFor(1);
			expect(JSON.parse(second.lines[0] ?? "{}")).toMatchObject({ type: "vm-state", state: "ready" });
		} finally {
			second.close();
		}

		// Emitting to a gone client is best-effort — never a throw.
		expect(() => handle.emitVmState(latest)).not.toThrow();
		await handle.close();
	});

	it("carries no vm-state line without the getter (off mode → the stream is unchanged)", async () => {
		const recorder = new RequestRecorder();
		recorder.record(event("1", "bash"));
		const path = join(tempDir(), "openhammer.sock");

		const handle = await startStatusSocket(recorder, { path, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const collector = collectLines(path);
		try {
			await collector.waitFor(1); // only the historical event — no vm-state line
			expect(collector.lines).toHaveLength(1);
			expect(JSON.parse(collector.lines[0] ?? "{}")).toMatchObject({ tool: "bash" });
		} finally {
			collector.close();
		}
		await handle.close();
	});

	it("answers an operator command on the real socket (deps.commands plumb-through)", async () => {
		const recorder = new RequestRecorder();
		const path = join(tempDir(), "openhammer.sock");
		const exec = recordingExecutor();

		const handle = await startStatusSocket(recorder, { path, commands: exec, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const client = collectLines(path);
		try {
			client.send('{"cmd":"vm-restart"}\n');
			await client.waitFor(1); // the reply (nothing else is dumped)
			expect(exec.requests).toEqual([{ cmd: "vm-restart" }]);
			expect(parseVmCmdResultLine(client.lines[0] ?? "")).toMatchObject({
				type: "vm-cmd-result",
				cmd: "vm-restart",
				ok: true,
				error: null,
			});
		} finally {
			client.close();
		}
		await handle.close();
	});
});
