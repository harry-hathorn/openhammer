import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RequestEvent, RequestRecorder } from "../mcp/telemetry.ts";
import {
	formatEventLine,
	handleConnection,
	type StatusSocket,
	startStatusSocket,
	statusSocketPath,
} from "./status-socket.ts";

/** A minimal recording socket conforming to {@link StatusSocket} (no real I/O). */
function fakeSocket(): StatusSocket & {
	emit(event: "close" | "error"): void;
	failNext(v: boolean): void;
	lines: string[];
} {
	const lines: string[] = [];
	const handlers = new Map<string, () => void>();
	let failNext = false;
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
		emit(event) {
			handlers.get(event)?.();
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
});
