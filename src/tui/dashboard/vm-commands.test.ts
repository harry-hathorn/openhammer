import { describe, expect, it } from "vitest";
import { sendVmCommand, VM_COMMAND_TIMEOUT_MESSAGE, type VmCommandConnection } from "./vm-commands.ts";

/**
 * A scripted connection: records writes, lets the test drive data/error/close.
 * The {@link VmCommandConnection} surface plus test handles — no real socket.
 */
interface ScriptedConn extends VmCommandConnection {
	receive(chunk: string): void;
	fail(error: Error): void;
	closeConn(): void;
	written: string[];
	wasDestroyed(): boolean;
}

function scriptedConnect(): { connect: (path: string) => VmCommandConnection; conns: ScriptedConn[] } {
	const conns: ScriptedConn[] = [];
	const connect = (_path: string): VmCommandConnection => {
		const dataHandlers: Array<(chunk: Buffer) => void> = [];
		const errorHandlers: Array<(err: Error) => void> = [];
		const closeHandlers: Array<() => void> = [];
		let destroyCount = 0;
		const conn: ScriptedConn = {
			written: [],
			write(chunk) {
				conn.written.push(chunk);
			},
			onData(cb) {
				dataHandlers.push(cb);
			},
			onError(cb) {
				errorHandlers.push(cb);
			},
			onClose(cb) {
				closeHandlers.push(cb);
			},
			destroy() {
				destroyCount += 1;
			},
			receive(chunk) {
				for (const cb of dataHandlers) cb(Buffer.from(chunk, "utf8"));
			},
			fail(error) {
				for (const cb of errorHandlers) cb(error);
			},
			closeConn() {
				for (const cb of closeHandlers) cb();
			},
			wasDestroyed: () => destroyCount > 0,
		};
		conns.push(conn);
		return conn;
	};
	return { connect, conns };
}

/** A well-formed request-event line (the dump a real connect delivers first). */
function eventLine(): string {
	return `${JSON.stringify({
		ts: "1",
		client: "claude-code/1.0",
		method: "tools/call",
		tool: "bash",
		reqBytes: 1,
		resBytes: 2,
		ms: 3,
		status: 200,
	})}\n`;
}

/** A well-formed vm-state line (rides the same dump). */
function vmStateLine(): string {
	return `${JSON.stringify({ type: "vm-state", state: "ready", sessionId: "vm-1", phase: null, sshPort: 1, error: null })}\n`;
}

describe("sendVmCommand", () => {
	it("writes the exact request line and resolves ok on the acceptance reply", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect });
		expect(conns[0]?.written).toEqual(['{"cmd":"vm-stop"}\n']);
		conns[0]?.receive('{"type":"vm-cmd-result","cmd":"vm-stop","ok":true,"error":null}\n');
		expect(await promise).toEqual({ ok: true, value: undefined });
		expect(conns[0]?.wasDestroyed()).toBe(true); // settled → the one-shot connection is dropped
	});

	it("sends vm-restart verbatim and carries an acceptance through", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-restart", { path: "/tmp/fake.sock", connect });
		expect(conns[0]?.written).toEqual(['{"cmd":"vm-restart"}\n']);
		conns[0]?.receive('{"type":"vm-cmd-result","cmd":"vm-restart","ok":true,"error":null}\n');
		expect(await promise).toEqual({ ok: true, value: undefined });
	});

	it("resolves err with the server's verbatim refusal", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect });
		conns[0]?.receive(
			`${JSON.stringify({
				type: "vm-cmd-result",
				cmd: "vm-stop",
				ok: false,
				error: "nothing to stop — the sandbox boot mode is off",
			})}\n`,
		);
		expect(await promise).toEqual({
			ok: false,
			error: new Error("nothing to stop — the sandbox boot mode is off"),
		});
	});

	it("skips other line kinds and other verbs' echoes before the reply", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect });
		conns[0]?.receive(
			`${eventLine()}${vmStateLine()}{"type":"vm-cmd-result","cmd":"vm-restart","ok":true,"error":null}\n`,
		);
		expect(conns[0]?.wasDestroyed()).toBe(false); // nothing settled yet
		conns[0]?.receive('{"type":"vm-cmd-result","cmd":"vm-stop","ok":true,"error":null}\n');
		expect(await promise).toEqual({ ok: true, value: undefined });
	});

	it("reassembles a reply split across chunks", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-restart", { path: "/tmp/fake.sock", connect });
		conns[0]?.receive('{"type":"vm-cmd-result","cmd":"vm-re');
		conns[0]?.receive('start","ok":true,"error":null}\n');
		expect(await promise).toEqual({ ok: true, value: undefined });
	});

	it("times out with the older-server hint when the server never answers", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect, timeoutMs: 20 });
		expect(await promise).toEqual({ ok: false, error: new Error(VM_COMMAND_TIMEOUT_MESSAGE) });
		expect(conns[0]?.wasDestroyed()).toBe(true);
	});

	it("a connect error resolves err naming the control socket (never throws)", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect });
		conns[0]?.fail(new Error("connect ENOENT /tmp/fake.sock"));
		expect(await promise).toEqual({
			ok: false,
			error: new Error("cannot reach the server's control socket: connect ENOENT /tmp/fake.sock"),
		});
	});

	it("a close before the reply resolves err (never hangs)", async () => {
		const { connect, conns } = scriptedConnect();
		const promise = sendVmCommand("vm-stop", { path: "/tmp/fake.sock", connect });
		conns[0]?.closeConn();
		expect(await promise).toEqual({
			ok: false,
			error: new Error("the server closed the control connection without answering"),
		});
	});

	it("a synchronous connect throw resolves err (never throws)", async () => {
		const promise = sendVmCommand("vm-stop", {
			path: "/tmp/fake.sock",
			connect: () => {
				throw new Error("bad path");
			},
		});
		expect(await promise).toEqual({
			ok: false,
			error: new Error("cannot reach the server's control socket: bad path"),
		});
	});
});
