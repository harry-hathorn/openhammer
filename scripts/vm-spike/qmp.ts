// Minimal QMP client over the unix socket — a plain-promise adaptation of Oligarchy's
// src/qmp/client.ts + framing: connect → greeting → qmp_capabilities → id-correlated
// commands, timeouts, and close detection failing every in-flight command.
import { connect, type Socket } from "node:net";

// QMP timing budget (ported): 10 s to see the greeting, 30 s per command — anything longer
// means QEMU is wedged with the socket still open, so fail the command instead of hanging.
export const HANDSHAKE_MS = 10_000;
export const COMMAND_TIMEOUT_MS = 30_000;

interface Pending {
	readonly command: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
}

export interface QmpClient {
	/** The raw greeting line (single-line JSON with the `QMP` key). */
	readonly greetingLine: string;
	/** The `qmp_capabilities` return (`{}` on success) — recorded in the run log. */
	readonly capabilitiesReturn: unknown;
	readonly execute: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
	/** `human-monitor-command` passthrough — later gates read `info usernet` through it. */
	readonly humanMonitorCommand: (commandLine: string) => Promise<string>;
	readonly close: () => void;
	/** Resolves with the reason once the socket is gone. */
	readonly closed: Promise<string>;
}

type Inbound = Record<string, unknown>;

function isInbound(value: unknown): value is Inbound {
	return typeof value === "object" && value !== null;
}

/**
 * Connect to a QMP control socket and complete the handshake (greeting +
 * `qmp_capabilities`). QMP frames are newline-delimited JSON. Resolves only once the
 * client is usable; rejects on handshake timeout, socket error, or early close.
 */
export function connectQmp(socketPath: string): Promise<QmpClient> {
	return new Promise<QmpClient>((resolveConnect, rejectConnect) => {
		const socket: Socket = connect({ path: socketPath });
		let buffer = "";
		let nextId = 0;
		let open = true;
		let greetingLine = "";
		let handshakeSettled = false;
		let resolveGreeting: (() => void) | undefined;
		const greetingPromise = new Promise<void>((resolve) => {
			resolveGreeting = resolve;
		});
		let resolveClosed: (reason: string) => void = () => {};
		const closed = new Promise<string>((resolve) => {
			resolveClosed = resolve;
		});
		const pending = new Map<number, Pending>();

		const handshakeTimer = setTimeout(() => {
			teardown(`no greeting within ${HANDSHAKE_MS} ms`);
		}, HANDSHAKE_MS);

		// Idempotent: first reason wins, later callers find nothing left to fail.
		const teardown = (reason: string): void => {
			if (!open) {
				return;
			}
			open = false;
			clearTimeout(handshakeTimer);
			if (!handshakeSettled) {
				handshakeSettled = true;
				rejectConnect(new Error(`qmp: handshake failed: ${reason}`));
			}
			socket.destroy();
			const closedError = new Error(`qmp: closed (${reason})`);
			for (const entry of pending.values()) {
				clearTimeout(entry.timer);
				entry.reject(closedError);
			}
			pending.clear();
			resolveClosed(reason);
		};

		const dispatch = (message: Inbound, line: string): void => {
			if ("QMP" in message) {
				greetingLine = line;
				resolveGreeting?.();
				return;
			}
			if ("event" in message) {
				return; // async events are noise for the spike
			}
			const id = message.id;
			if (typeof id !== "number") {
				return;
			}
			const entry = pending.get(id);
			if (entry === undefined) {
				return;
			}
			pending.delete(id);
			clearTimeout(entry.timer);
			if ("error" in message) {
				const error = isInbound(message.error)
					? String(message.error.desc ?? JSON.stringify(message.error))
					: "unknown error";
				entry.reject(new Error(`qmp ${entry.command}: ${error}`));
				return;
			}
			entry.resolve("return" in message ? message.return : undefined);
		};

		socket.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) {
					return;
				}
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line === "") {
					continue;
				}
				let parsed: unknown;
				try {
					parsed = JSON.parse(line);
				} catch {
					teardown(`invalid QMP frame: ${line}`);
					return;
				}
				if (isInbound(parsed)) {
					dispatch(parsed, line);
				}
			}
		});
		socket.on("error", (error: Error) => {
			teardown(`socket error: ${error.message}`);
		});
		socket.on("close", () => {
			teardown("socket closed");
		});

		const execute = (command: string, args: Record<string, unknown> = {}): Promise<unknown> =>
			new Promise<unknown>((resolve, reject) => {
				if (!open) {
					reject(new Error(`qmp ${command}: socket is closed`));
					return;
				}
				const id = ++nextId;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`qmp ${command}: no reply within ${COMMAND_TIMEOUT_MS} ms`));
				}, COMMAND_TIMEOUT_MS);
				pending.set(id, { command, resolve, reject, timer });
				socket.write(`${JSON.stringify({ execute: command, arguments: args, id })}\n`);
			});

		void (async () => {
			await greetingPromise;
			if (!open) {
				return; // teardown already failed the handshake
			}
			const capabilities = await execute("qmp_capabilities");
			if (handshakeSettled) {
				return;
			}
			handshakeSettled = true;
			clearTimeout(handshakeTimer);
			resolveConnect({
				greetingLine,
				capabilitiesReturn: capabilities,
				execute,
				humanMonitorCommand: async (commandLine: string) => {
					const returned = await execute("human-monitor-command", { "command-line": commandLine });
					return typeof returned === "string" ? returned : JSON.stringify(returned);
				},
				close: () => {
					socket.end();
				},
				closed,
			});
		})().catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			if (!handshakeSettled) {
				handshakeSettled = true;
				clearTimeout(handshakeTimer);
				rejectConnect(new Error(`qmp: handshake failed: ${message}`));
				teardown(message);
			}
		});
	});
}
