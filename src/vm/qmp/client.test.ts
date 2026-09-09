import { describe, expect, it } from "vitest";
import type { SendKeyTransport } from "../qemu/keys.ts";
import { COMMAND_TIMEOUT_MS, connectQmp, HANDSHAKE_MS, type QmpClient, type QmpClientOptions } from "./client.ts";
import type { ConnectFn, QmpDuplex } from "./socket.ts";

/** A QEMU stand-in: a recording duplex plus emit helpers — no real socket is ever opened. */
interface FakeQmpSocket extends QmpDuplex {
	written: string[];
	isEnded: boolean;
	isDestroyed: boolean;
	emitData(text: string): void;
	emitClose(): void;
	emitError(message: string): void;
}

function fakeQmpSocket(): FakeQmpSocket {
	const written: string[] = [];
	const dataListeners: Array<(chunk: Buffer) => void> = [];
	const closeListeners: Array<() => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	return {
		// The single-cast implementor of the overloaded `on`: TS cannot correlate the `event`
		// union with the matching listener union, so each branch narrows by hand.
		on(event: "data" | "close" | "error", listener: (...args: never[]) => void): unknown {
			if (event === "data") {
				dataListeners.push(listener as (chunk: Buffer) => void);
			} else if (event === "close") {
				closeListeners.push(listener as () => void);
			} else {
				errorListeners.push(listener as (error: Error) => void);
			}
			return undefined;
		},
		write(chunk: string): boolean {
			written.push(chunk);
			return true;
		},
		end(): void {
			this.isEnded = true;
		},
		destroy(): void {
			this.isDestroyed = true;
		},
		isEnded: false,
		isDestroyed: false,
		written,
		emitData(text: string): void {
			for (const listener of dataListeners) {
				listener(Buffer.from(text, "utf8"));
			}
		},
		emitClose(): void {
			for (const listener of closeListeners) {
				listener();
			}
		},
		emitError(message: string): void {
			for (const listener of errorListeners) {
				listener(new Error(message));
			}
		},
	};
}

const GREETING =
	'{"QMP": {"version": {"qemu": {"micro": 0, "minor": 2, "major": 9}, "package": ""}, "capabilities": ["qmp_capabilities"]}}';

/** The injected seam handing the client the fake peer. */
const fakeConnect =
	(socket: FakeQmpSocket): ConnectFn =>
	() =>
		socket;

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Spin the event loop until `count` MORE frames have been written (counted from call time). */
async function untilWritten(socket: FakeQmpSocket, count: number): Promise<void> {
	const baseline = socket.written.length;
	for (let i = 0; i < 50 && socket.written.length < baseline + count; i++) {
		await tick();
	}
	expect(socket.written.length).toBeGreaterThanOrEqual(baseline + count);
}

/** Connect against a fresh fake and complete the handshake (greeting answered with {}). */
async function connectFake(options: Partial<QmpClientOptions> = {}): Promise<{
	client: QmpClient;
	peer: FakeQmpSocket;
}> {
	const socket = fakeQmpSocket();
	const pending = connectQmp("/run/qmp.sock", {
		connect: fakeConnect(socket),
		handshakeMs: 250,
		commandTimeoutMs: 250,
		...options,
	});
	socket.emitData(`${GREETING}\n`);
	await untilWritten(socket, 1); // the qmp_capabilities request is out
	socket.emitData('{"return": {}, "id": 1}\n');
	return { client: await pending, peer: socket };
}

describe("connectQmp — handshake", () => {
	it("sends qmp_capabilities as id 1 once the greeting arrives (even split across chunks)", async () => {
		const socket = fakeQmpSocket();
		const pending = connectQmp("/run/qmp.sock", {
			connect: fakeConnect(socket),
			handshakeMs: 250,
			commandTimeoutMs: 250,
		});
		expect(socket.written).toEqual([]); // nothing goes out before the greeting
		socket.emitData(GREETING.slice(0, 60)); // partial greeting line — framing carries it
		socket.emitData(`${GREETING.slice(60)}\n`);
		await untilWritten(socket, 1);
		expect(socket.written[0]).toBe('{"execute":"qmp_capabilities","arguments":{},"id":1}\n');
		socket.emitData('{"return": {}, "id": 1}\n');
		const client = await pending;
		expect(client.greetingLine).toBe(GREETING);
		expect(client.capabilitiesReturn).toEqual({});
	});

	it("publishes the production timing budget (10 s handshake / 30 s command)", () => {
		expect(HANDSHAKE_MS).toBe(10_000);
		expect(COMMAND_TIMEOUT_MS).toBe(30_000);
	});

	it("rejects on greeting timeout and destroys the socket", async () => {
		const socket = fakeQmpSocket();
		const pending = connectQmp("/run/qmp.sock", {
			connect: fakeConnect(socket),
			handshakeMs: 25,
			commandTimeoutMs: 250,
		});
		await expect(pending).rejects.toThrow("qmp: handshake failed: no greeting within 25 ms");
		expect(socket.isDestroyed).toBe(true);
	});

	it("rejects on a socket error before the greeting (connect ENOENT shape)", async () => {
		const socket = fakeQmpSocket();
		const pending = connectQmp("/run/qmp.sock", {
			connect: fakeConnect(socket),
			handshakeMs: 250,
			commandTimeoutMs: 250,
		});
		socket.emitError("connect ENOENT /run/qmp.sock");
		await expect(pending).rejects.toThrow("qmp: handshake failed: socket error: connect ENOENT /run/qmp.sock");
		expect(socket.isDestroyed).toBe(true);
	});

	it("rejects on close before the greeting", async () => {
		const socket = fakeQmpSocket();
		const pending = connectQmp("/run/qmp.sock", {
			connect: fakeConnect(socket),
			handshakeMs: 250,
			commandTimeoutMs: 250,
		});
		socket.emitClose();
		await expect(pending).rejects.toThrow("qmp: handshake failed: socket closed");
		expect(socket.isDestroyed).toBe(true);
	});

	it("rejects when qmp_capabilities itself errors, naming the desc", async () => {
		const socket = fakeQmpSocket();
		const pending = connectQmp("/run/qmp.sock", {
			connect: fakeConnect(socket),
			handshakeMs: 250,
			commandTimeoutMs: 250,
		});
		socket.emitData(`${GREETING}\n`);
		await untilWritten(socket, 1);
		socket.emitData('{"error": {"class": "CommandDisabled", "desc": "capabilities refused"}, "id": 1}\n');
		await expect(pending).rejects.toThrow("qmp: handshake failed: qmp qmp_capabilities: capabilities refused");
		expect(socket.isDestroyed).toBe(true);
	});
});

describe("QmpClient — execute", () => {
	it("correlates replies by id, out of order, delivered in one chunk", async () => {
		const { client, peer } = await connectFake();
		const first = client.execute("query-status");
		const second = client.execute("query-vnc");
		await tick(); // execute writes synchronously; just let microtasks settle
		// Ids run on past the handshake's qmp_capabilities (id 1): 2, 3, monotonically.
		expect(peer.written.slice(-2).map((frame) => JSON.parse(frame))).toEqual([
			{ execute: "query-status", arguments: {}, id: 2 },
			{ execute: "query-vnc", arguments: {}, id: 3 },
		]);
		peer.emitData('{"return": "answer-to-3", "id": 3}\n{"return": "answer-to-2", "id": 2}\n');
		expect(await second).toBe("answer-to-3");
		expect(await first).toBe("answer-to-2");
	});

	it("times out a command that never gets a reply — and the client stays usable", async () => {
		const { client, peer } = await connectFake({ commandTimeoutMs: 30 });
		await expect(client.execute("query-status")).rejects.toThrow("qmp query-status: no reply within 30 ms");
		// The timeout fails the command, not the connection: the next exchange still works.
		const followUp = client.execute("query-vnc");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"return": "still-alive", "id": 3}\n');
		expect(await followUp).toBe("still-alive");
	});

	it("rejects with the error object's desc; falls back to the raw error object", async () => {
		const { client, peer } = await connectFake();
		const withDesc = client.execute("device_del", { id: "virtio0" });
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"error": {"class": "GenericError", "desc": "device not found"}, "id": 2}\n');
		await expect(withDesc).rejects.toThrow("qmp device_del: device not found");
		const withoutDesc = client.execute("device_del", { id: "x" });
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"error": {"class": "GenericError"}, "id": 3}\n');
		await expect(withoutDesc).rejects.toThrow('qmp device_del: {"class":"GenericError"}');
		const notAnObject = client.execute("device_del", { id: "y" });
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"error": "kaput", "id": 4}\n');
		await expect(notAnObject).rejects.toThrow("qmp device_del: unknown error");
	});
});

describe("QmpClient — close detection (in-flight commands never hang)", () => {
	it("close mid-command: the in-flight command rejects immediately with the close reason", async () => {
		const { client, peer } = await connectFake();
		const inflight = client.execute("query-status");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitClose();
		await expect(inflight).rejects.toThrow("qmp: closed (socket closed)");
		await expect(client.closed).resolves.toBe("socket closed");
		expect(peer.isDestroyed).toBe(true);
		// Anything sent after the close fails fast instead of writing into the dead socket.
		await expect(client.execute("query-status")).rejects.toThrow("qmp query-status: socket is closed");
	});

	it("socket error mid-command: the same fail-in-flight with the error as the reason", async () => {
		const { client, peer } = await connectFake();
		const inflight = client.execute("query-status");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitError("EPIPE: broken pipe");
		await expect(inflight).rejects.toThrow("qmp: closed (socket error: EPIPE: broken pipe)");
		await expect(client.closed).resolves.toBe("socket error: EPIPE: broken pipe");
	});

	it("an invalid QMP frame tears the connection down and fails the in-flight command", async () => {
		const { client, peer } = await connectFake();
		const inflight = client.execute("query-status");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData("not json\n");
		await expect(inflight).rejects.toThrow("qmp: closed (invalid QMP frame: not json)");
		await expect(client.closed).resolves.toBe("invalid QMP frame: not json");
	});

	it("fails every in-flight command at once on close", async () => {
		const { client, peer } = await connectFake();
		const one = client.execute("query-status");
		const two = client.execute("query-vnc");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitClose();
		await expect(one).rejects.toThrow("qmp: closed (socket closed)");
		await expect(two).rejects.toThrow("qmp: closed (socket closed)");
	});
});

describe("QmpClient — humanMonitorCommand", () => {
	it("passes the line through as human-monitor-command and returns the string reply", async () => {
		const { client, peer } = await connectFake();
		const reply = client.humanMonitorCommand("info usernet");
		await tick(); // execute writes synchronously; just let microtasks settle
		expect(JSON.parse(peer.written.at(-1) ?? "{}")).toEqual({
			execute: "human-monitor-command",
			arguments: { "command-line": "info usernet" },
			id: 2,
		});
		peer.emitData(
			'{"return": "Protocol[IPv4]: 10.0.2.0\\nHost[IPv4] 127.0.0.1, forward 2222, guest 22\\n", "id": 2}\n',
		);
		await expect(reply).resolves.toContain("forward 2222");
	});

	it("stringifies a non-string return rather than leaking it", async () => {
		const { client, peer } = await connectFake();
		const reply = client.humanMonitorCommand("info block");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"return": {"drives": []}, "id": 2}\n');
		await expect(reply).resolves.toBe('{"drives":[]}');
	});
});

describe("QmpClient — async events", () => {
	it("delivers events only through onEvent; frames without an id (or non-frames) are ignored", async () => {
		const events: Array<Record<string, unknown>> = [];
		const { client, peer } = await connectFake({ onEvent: (event) => events.push(event) });
		peer.emitData('{"event": "RESET", "data": {}, "timestamp": {"seconds": 1, "microseconds": 2}}\n');
		peer.emitData("42\n"); // JSON, but not an object — not a QMP message
		peer.emitData('{"return": {}}\n'); // no id — no command to correlate
		const status = client.execute("query-status");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"return": "running", "id": 2}\n');
		expect(await status).toBe("running");
		expect(events).toEqual([{ event: "RESET", data: {}, timestamp: { seconds: 1, microseconds: 2 } }]);
	});

	it("drops events silently when no onEvent hook is set", async () => {
		const { client, peer } = await connectFake();
		peer.emitData('{"event": "POWERDOWN", "data": {}}\n');
		const status = client.execute("query-status");
		await tick(); // execute writes synchronously; just let microtasks settle
		peer.emitData('{"return": "running", "id": 2}\n');
		expect(await status).toBe("running");
	});
});

describe("QmpClient — close()/closed", () => {
	it("close() ends the duplex gracefully; closed resolves once the peer closes", async () => {
		const { client, peer } = await connectFake();
		client.close();
		expect(peer.isEnded).toBe(true);
		expect(peer.isDestroyed).toBe(false);
		peer.emitClose();
		await expect(client.closed).resolves.toBe("socket closed");
	});
});

describe("QmpClient — structural seam", () => {
	it("QmpClient satisfies SendKeyTransport structurally", () => {
		// Compile-time only (an identity needs no client or socket): 24a's keys.ts accepts the
		// production client through the structural seam, exactly as its docstring promises.
		const asTransport = (client: QmpClient): SendKeyTransport => client;
		expect(typeof asTransport).toBe("function");
	});
});
