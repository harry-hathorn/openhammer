import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RequestEvent, RequestRecorder } from "../mcp/telemetry.ts";
import { startStatusSocket } from "../observability/status-socket.ts";
import { type MonitorConnection, type MonitorIo, monitorCommand } from "./monitor.ts";

/** A recording `BannerStream` fake: collects writes as a string. */
function recordingStream() {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
	};
	return { stream, text: () => chunks.join("") };
}

/** A `MonitorIo` backed by two recording streams, with read-backs for both. */
function recordingIo(): MonitorIo & { outText: () => string; errText: () => string } {
	const out = recordingStream();
	const err = recordingStream();
	return { stdout: out.stream, stderr: err.stream, outText: out.text, errText: err.text };
}

/**
 * A fake {@link MonitorConnection} the test feeds NDJSON into and drives to a
 * close/error. Typed listeners per event (the per-method surface) need **no
 * `as` cast** — the production `defaultConnect` adapts `net.Socket` to the same
 * surface.
 */
function fakeConnection() {
	const data: Array<(chunk: Buffer) => void> = [];
	const errs: Array<(err: Error) => void> = [];
	const closes: Array<() => void> = [];
	let destroyed = false;
	const conn: MonitorConnection = {
		onData(cb) {
			data.push(cb);
		},
		onError(cb) {
			errs.push(cb);
		},
		onClose(cb) {
			closes.push(cb);
		},
		destroy() {
			destroyed = true;
		},
	};
	return {
		conn,
		/** Push one NDJSON line to the data listeners (newline-terminated, as the socket sends). */
		push(line: string): void {
			const chunk = Buffer.from(`${line}\n`, "utf8");
			for (const cb of data) cb(chunk);
		},
		/** Push raw bytes verbatim (no auto-newline) — for exercising cross-chunk reassembly. */
		pushRaw(text: string): void {
			const chunk = Buffer.from(text, "utf8");
			for (const cb of data) cb(chunk);
		},
		close(): void {
			for (const cb of closes) cb();
		},
		error(err: Error): void {
			for (const cb of errs) cb(err);
		},
		isDestroyed(): boolean {
			return destroyed;
		},
	};
}

/** A minimal event serialized as one NDJSON line. */
function line(over: Partial<RequestEvent> = {}): string {
	const e: RequestEvent = {
		ts: "2026-06-24T12:01:03.456Z",
		client: "claude-code/1.0",
		method: "tools/call",
		tool: "bash",
		reqBytes: 10,
		resBytes: 200,
		ms: 1200,
		status: 200,
		...over,
	};
	return JSON.stringify(e);
}

describe("monitorCommand", () => {
	it("streams dump + live events as formatted lines, then exits 0 on close", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { path: "/tmp/x.sock", connect: () => fake.conn });

		fake.push(line({ ts: "2026-06-24T12:01:03.100Z" })); // dump
		fake.push(line({ ts: "2026-06-24T12:01:04.000Z", tool: "read" })); // live
		fake.close();

		expect(await p).toBe(0);
		const text = io.outText();
		expect(text).toContain("Monitoring /tmp/x.sock");
		// header reprinted once (the first client is new), then both event lines.
		expect(text).toContain("active clients: claude-code/1.0×1");
		expect(text).toContain("[12:01:03] claude-code/1.0  tools/call bash  1.2s  200B");
		expect(text).toContain("[12:01:04] claude-code/1.0  tools/call read  1.2s  200B");
	});

	it("reprints the rolling header when a new client joins", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		fake.push(line({ client: "a", ts: "t1" }));
		fake.push(line({ client: "a", ts: "t2" })); // not new → no reprint
		fake.push(line({ client: "b", ts: "t3" })); // new → reprint
		fake.close();

		await p;
		const text = io.outText();
		expect(text).toContain("active clients: a×1");
		expect(text).toContain("active clients: a×2, b×1");
	});

	it("skips blank + malformed lines without aborting the feed", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		fake.push("");
		fake.push("{not json");
		fake.push(line({ tool: "ls" }));
		fake.close();

		await p;
		const text = io.outText();
		expect(text).toContain("tools/call ls");
		expect(text).not.toContain("{not json");
	});

	it("splits a line that arrives across two chunks", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		const whole = line({ tool: "grep" });
		fake.pushRaw(whole.slice(0, 10));
		fake.pushRaw(`${whole.slice(10)}\n`);
		fake.close();

		await p;
		expect(io.outText()).toContain("tools/call grep");
	});

	it("reports a missing socket (ENOENT) with an actionable hint + exits 1", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		fake.error(Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }));

		expect(await p).toBe(1);
		expect(io.errText()).toContain("status socket was not found");
		expect(io.errText()).toContain("server running");
	});

	it("reports ECONNREFUSED the same way", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		fake.error(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));

		expect(await p).toBe(1);
		expect(io.errText()).toContain("status socket was not found");
	});

	it("surfaces a non-errno connection error with its message + exits 1", async () => {
		const fake = fakeConnection();
		const io = recordingIo();
		const p = monitorCommand(io, { connect: () => fake.conn });

		fake.error(new Error("boom"));

		expect(await p).toBe(1);
		expect(io.errText()).toContain("boom");
	});

	it("returns 1 + a stderr message when `connect` throws synchronously", async () => {
		const io = recordingIo();
		const code = await monitorCommand(io, {
			path: "/nope",
			connect: () => {
				throw new Error("factory blew up");
			},
		});
		expect(code).toBe(1);
		expect(io.errText()).toContain("factory blew up");
	});
});

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
	const dir = mkdtempSync(join(tmpdir(), "oh-monitor-"));
	tempDirs.push(dir);
	return dir;
}

/** Resolve once `predicate` is true (polling; rejects on timeout — the status-socket.test.ts pattern). */
function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
	return new Promise((resolve, reject) => {
		const start = Date.now();
		const tick = (): void => {
			if (predicate()) {
				resolve();
				return;
			}
			if (Date.now() - start >= ms) {
				reject(new Error("timed out waiting for predicate"));
				return;
			}
			setTimeout(tick, 5);
		};
		tick();
	});
}

/**
 * Real Unix-domain-socket end-to-end (hermetic — local socket, no network):
 * proves the production {@link defaultConnect} adapter (`net.createConnection`)
 * reads the dump then a live event from a real {@link startStatusSocket}, and
 * resolves `0` once the server-side handle closes the connection.
 */
describe("monitorCommand (real status socket)", () => {
	it("dumps history + streams live via the default net connection, then exits 0 on server close", async () => {
		const recorder = new RequestRecorder();
		const dumpEvent: RequestEvent = {
			ts: "2026-06-24T12:01:03.100Z",
			client: "claude-code/1.0",
			method: "tools/call",
			tool: "bash",
			reqBytes: 1,
			resBytes: 200,
			ms: 1200,
			status: 200,
		};
		recorder.record(dumpEvent);
		const path = join(tempDir(), "openhammer.sock");
		const handle = await startStatusSocket(recorder, { path, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const io = recordingIo();
		const p = monitorCommand(io, { path }); // no `connect` dep → the real net adapter

		await waitFor(() => io.outText().includes("tools/call bash")); // dump delivered
		recorder.record({ ...dumpEvent, ts: "2026-06-24T12:01:04.000Z", tool: "ls", resBytes: 64 }); // live
		await waitFor(() => io.outText().includes("tools/call ls"));

		await handle.close(); // destroys the monitor's connection → monitorCommand resolves
		expect(await p).toBe(0);
		expect(io.outText()).toContain("Monitoring ");
		expect(io.outText()).toContain("[12:01:03] claude-code/1.0  tools/call bash");
		expect(io.outText()).toContain("[12:01:04] claude-code/1.0  tools/call ls");
	});
});
