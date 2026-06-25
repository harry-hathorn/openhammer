import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type RequestEvent, RequestRecorder } from "../../mcp/telemetry.ts";
import { type ChannelStateLine, formatChannelStateLine, startStatusSocket } from "../../observability/status-socket.ts";
import { createSocketSubscriber, type SocketConnection } from "./socket-client.ts";

/** A baseline event (the recorder's always-present 8 fields). */
function event(over: Partial<RequestEvent> = {}): RequestEvent {
	return {
		ts: "2026-06-24T12:01:03.000Z",
		client: "claude-code",
		method: "tools/call",
		tool: "bash",
		reqBytes: 10,
		resBytes: 200,
		ms: 12,
		status: 200,
		...over,
	};
}

/** Compact-JSON NDJSON line (exactly what `formatEventLine` emits on the wire). */
function ndjson(e: RequestEvent): string {
	return JSON.stringify(e);
}

/** A channel-state line (spec 19c-channel). */
function csLine(id: string, up: boolean, url: string | null): ChannelStateLine {
	return { type: "channel-state", id, up, url };
}

/**
 * A fake {@link SocketConnection} the test feeds NDJSON into and drives to a
 * close/error. Per-event listeners (mirrors `monitor.test.ts`'s fake) need **no
 * `as` cast** — the production `connectStatusSocket` adapts `net.Socket` to the
 * same surface.
 */
function fakeConnection() {
	const data: Array<(chunk: Buffer) => void> = [];
	const errs: Array<(err: Error) => void> = [];
	const closes: Array<() => void> = [];
	let destroyed = false;
	const conn: SocketConnection = {
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
		destroyed: () => destroyed,
		/** Push one or more newline-terminated NDJSON lines to the data listeners. */
		push(...lines: string[]): void {
			const chunk = Buffer.from(`${lines.join("\n")}\n`, "utf8");
			for (const cb of data) cb(chunk);
		},
		/** Push raw bytes verbatim (no auto-newline) — for cross-chunk reassembly. */
		pushRaw(bytes: string): void {
			const chunk = Buffer.from(bytes, "utf8");
			for (const cb of data) cb(chunk);
		},
		emitError(err: Error): void {
			for (const cb of errs) cb(err);
		},
		emitClose(): void {
			for (const cb of closes) cb();
		},
	};
}

/** A factory bound to a fake connection, returning the subscribe seam. `maxAttempts: 0`
 *  keeps the single-attempt semantics the parse/teardown tests assert (no retry timers). */
function subscriberOver(conn: SocketConnection) {
	return createSocketSubscriber({ connect: () => conn, warn: () => {}, maxAttempts: 0 });
}

describe("createSocketSubscriber — NDJSON parsing", () => {
	it("delivers each valid event line to onEvent", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.push(ndjson(event({ tool: "bash" })), ndjson(event({ tool: "ls", ms: 5 })));
		expect(received).toHaveLength(2);
		expect(received[0]?.tool).toBe("bash");
		expect(received[1]?.tool).toBe("ls");
		unsub();
	});

	it("skips blank + malformed lines but keeps delivering the valid ones", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.push("", "not-json", ndjson(event({ client: "a" })), "{bad", ndjson(event({ client: "b" })));
		// Only the two well-formed event lines survive `parseEventLine`.
		expect(received.map((e) => e.client)).toEqual(["a", "b"]);
		unsub();
	});

	it("rejects structurally-invalid JSON (right keys, wrong value types)", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		// `status` is a string, not a number → not a valid RequestEvent → skipped.
		fake.push(`${JSON.stringify({ ...event(), status: "200" })}`);
		expect(received).toHaveLength(0);
		unsub();
	});

	it("reassembles a line split across chunks", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		const line = ndjson(event({ tool: "grep" }));
		fake.pushRaw(line.slice(0, 10)); // no newline yet → buffered, not delivered
		expect(received).toHaveLength(0);
		fake.pushRaw(`${line.slice(10)}\n`); // completes the line
		expect(received).toHaveLength(1);
		expect(received[0]?.tool).toBe("grep");
		unsub();
	});

	it("handles many lines arriving in one chunk", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.push(...Array.from({ length: 5 }, (_, i) => ndjson(event({ ms: i }))));
		expect(received).toHaveLength(5);
		unsub();
	});
});

describe("createSocketSubscriber — channel-state (19c-channel)", () => {
	it("delivers channel-state lines to onChannelState, events to onEvent", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const events: RequestEvent[] = [];
		const states: ChannelStateLine[] = [];
		const unsub = subscribe(
			(e) => events.push(e),
			(s) => states.push(s),
		);

		// A mixed stream — channel-state line, then an event, then another channel-state.
		fake.push(
			formatChannelStateLine(csLine("deployed", true, "https://edge.example/mcp")),
			ndjson(event({ tool: "bash" })),
			formatChannelStateLine(csLine("broken", false, null)),
		);
		expect(events).toHaveLength(1);
		expect(events[0]?.tool).toBe("bash");
		expect(states).toEqual([csLine("deployed", true, "https://edge.example/mcp"), csLine("broken", false, null)]);
		unsub();
	});

	it("delivers nothing to onChannelState when it is omitted (backward compatible)", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const events: RequestEvent[] = [];
		// 1-arg subscribe — the existing call shape (monitor-style consumers).
		const unsub = subscribe((e) => events.push(e));

		fake.push(formatChannelStateLine(csLine("deployed", true, "https://x")), ndjson(event({ tool: "ls" })));
		// Events still flow; channel-state lines are simply skipped (no callback).
		expect(events).toHaveLength(1);
		expect(events[0]?.tool).toBe("ls");
		unsub();
	});
});

describe("createSocketSubscriber — teardown", () => {
	it("unsubscribe destroys the connection and stops further delivery", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.push(ndjson(event({ client: "a" })));
		expect(received).toHaveLength(1);

		unsub();
		expect(fake.destroyed()).toBe(true);

		// A late chunk after teardown is ignored (the guard short-circuits).
		fake.push(ndjson(event({ client: "b" })));
		expect(received).toHaveLength(1);
	});

	it("unsubscribe is idempotent", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const unsub = subscribe(() => {});
		unsub();
		unsub(); // second call is a no-op (destroy flag absorbs it)
		expect(fake.destroyed()).toBe(true);
	});

	it("onClose tears down (a stopped server ends the stream cleanly)", () => {
		const fake = fakeConnection();
		const subscribe = subscriberOver(fake.conn);
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.push(ndjson(event({ client: "a" })));
		fake.emitClose(); // server stopped
		fake.push(ndjson(event({ client: "b" }))); // ignored after close
		expect(received.map((e) => e.client)).toEqual(["a"]);
		expect(fake.destroyed()).toBe(true);
		unsub();
	});

	it("onError warns + retires the connection, never throws into onEvent", () => {
		const warnings: string[] = [];
		const fake = fakeConnection();
		const subscribe = createSocketSubscriber({
			connect: () => fake.conn,
			warn: (m) => warnings.push(m),
			maxAttempts: 0,
		});
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		fake.emitError(new Error("ECONNRESET"));
		fake.push(ndjson(event({ client: "a" }))); // ignored after the connection is retired
		expect(received).toHaveLength(0);
		expect(warnings[0]).toContain("ECONNRESET");
		expect(fake.destroyed()).toBe(true);
		unsub();
	});
});

describe("createSocketSubscriber — connection failures", () => {
	it("a throwing connect warns + returns a no-op unsubscribe (never connected)", () => {
		const warnings: string[] = [];
		const subscribe = createSocketSubscriber({
			connect: () => {
				throw new Error("ENOENT");
			},
			warn: (m) => warnings.push(m),
			maxAttempts: 0,
		});
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		expect(received).toHaveLength(0);
		expect(warnings[0]).toContain("cannot connect");
		expect(warnings[0]).toContain("ENOENT");
		expect(() => unsub()).not.toThrow(); // no-op, idempotent
	});

	it("passes the resolved socket path to the connect factory", () => {
		let seen: string | undefined;
		const subscribe = createSocketSubscriber({
			path: "/tmp/oh-test.sock",
			connect: (p) => {
				seen = p;
				return fakeConnection().conn;
			},
			warn: () => {},
			maxAttempts: 0,
		});
		subscribe(() => {})();
		expect(seen).toBe("/tmp/oh-test.sock");
	});
});

describe("createSocketSubscriber — retry/reconnect (the server-creates-the-socket race)", () => {
	/** Await the macrotask queue so `retryIntervalMs: 0` retry timers fire. */
	async function flush(): Promise<void> {
		for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
	}

	it("retries connect on ENOENT, then delivers once the socket appears", async () => {
		const working = fakeConnection();
		let calls = 0;
		const subscribe = createSocketSubscriber({
			connect: () => {
				calls += 1;
				if (calls < 3) throw new Error("ENOENT"); // first two attempts: socket not created yet
				return working.conn; // third attempt: the server created it
			},
			warn: () => {},
			retryIntervalMs: 0,
			maxAttempts: 10,
		});
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		await flush();
		expect(calls).toBe(3); // retried until it connected
		working.push(ndjson(event({ client: "late" })));
		expect(received.map((e) => e.client)).toEqual(["late"]);
		unsub();
	});

	it("reconnects after the server closes the socket", async () => {
		const first = fakeConnection();
		const second = fakeConnection();
		let calls = 0;
		const subscribe = createSocketSubscriber({
			connect: () => (calls++ === 0 ? first.conn : second.conn),
			warn: () => {},
			retryIntervalMs: 0,
			maxAttempts: 5,
		});
		const received: RequestEvent[] = [];
		const unsub = subscribe((e) => received.push(e));

		first.push(ndjson(event({ client: "a" })));
		first.emitClose(); // server dropped the connection
		await flush();
		expect(calls).toBe(2); // reconnected
		second.push(ndjson(event({ client: "b" })));
		expect(received.map((e) => e.client)).toEqual(["a", "b"]);
		unsub();
	});

	it("gives up after maxAttempts (the feed goes quiet, no leaky timer)", async () => {
		let calls = 0;
		const subscribe = createSocketSubscriber({
			connect: () => {
				calls += 1;
				throw new Error("ENOENT");
			},
			warn: () => {},
			retryIntervalMs: 0,
			maxAttempts: 3,
		});
		const unsub = subscribe(() => {});
		await flush();
		expect(calls).toBe(4); // 1 initial + 3 retries
		unsub();
	});
});

/**
 * Real Unix-domain-socket end-to-end (hermetic — local socket, no network):
 * proves the production {@link connectStatusSocket} adapter (`net.createConnection`)
 * reads the dump then a live event from a real {@link startStatusSocket}, and that
 * unsubscribe cleanly drops the connection.
 */
describe("createSocketSubscriber (real status socket)", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "oh-sock-"));
		tempDirs.push(dir);
		return dir;
	}

	/** Poll `predicate` until true, rejecting on timeout (mirrors monitor.test.ts). */
	function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
		return new Promise((resolve, reject) => {
			const start = Date.now();
			const tick = (): void => {
				if (predicate()) resolve();
				else if (Date.now() - start > ms) reject(new Error("waitFor timed out"));
				else setTimeout(tick, 10);
			};
			tick();
		});
	}

	it("delivers the dump then a live event, and unsubscribe is clean", async () => {
		const recorder = new RequestRecorder();
		const dump: RequestEvent = event({ ts: "2026-06-24T12:01:03.100Z", client: "claude-code/1.0", tool: "bash" });
		recorder.record(dump);
		const path = join(tempDir(), "openhammer.sock");
		const handle = await startStatusSocket(recorder, { path, warn: () => {} });
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const received: RequestEvent[] = [];
		// No `connect` dep → the real net adapter (`connectStatusSocket`).
		const subscribe = createSocketSubscriber({ path, warn: () => {} });
		const unsub = subscribe((e) => received.push(e));

		await waitFor(() => received.some((e) => e.tool === "bash")); // dump delivered
		// A live event streamed after connect.
		recorder.record(event({ ts: "2026-06-24T12:01:04.000Z", tool: "ls", resBytes: 64 }));
		await waitFor(() => received.some((e) => e.tool === "ls"));

		expect(received.map((e) => e.tool)).toContain("bash");
		expect(received.map((e) => e.tool)).toContain("ls");

		unsub();
		await handle.close(); // the server tears its side down cleanly
		expect(received.length).toBeGreaterThanOrEqual(2);
	});

	it("delivers the channel-state dump through the real net adapter (19c-channel)", async () => {
		const recorder = new RequestRecorder();
		const path = join(tempDir(), "openhammer.sock");
		const handle = await startStatusSocket(recorder, {
			path,
			channels: [csLine("deployed", true, "https://edge.example/mcp")],
			warn: () => {},
		});
		expect(handle).not.toBeNull();
		if (handle === null) return;

		const states: ChannelStateLine[] = [];
		const subscribe = createSocketSubscriber({ path, warn: () => {} });
		const unsub = subscribe(
			() => {},
			(s) => states.push(s),
		);

		await waitFor(() => states.some((s) => s.id === "deployed"));
		expect(states[0]).toEqual(csLine("deployed", true, "https://edge.example/mcp"));

		unsub();
		await handle.close();
	});
});
