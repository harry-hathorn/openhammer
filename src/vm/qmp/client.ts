// QMP client — the spec-24 promotion of the vm-spike's single-file client
// (scripts/vm-spike/qmp.ts, which drove every spike run), split onto the pure framer
// (framing.ts) and the dumb socket wrapper (socket.ts): unix-socket connect → greeting →
// qmp_capabilities → id-correlated command/response map, 10 s handshake / 30 s per-command
// timeouts, and close detection that fails every in-flight command instead of hanging (the
// steal-list explicit requirement — the teardown/relaunch failure mode).
import { encodeQmpCommand, type QmpDecodedLine, QmpDecoder } from "./framing.ts";
import { type ConnectFn, openQmpSocket } from "./socket.ts";

export const HANDSHAKE_MS = 10_000;
// A QMP reply is near-instant; anything this long means QEMU is wedged with its socket
// still open (so a close teardown never fires). Fail the command instead of hanging.
export const COMMAND_TIMEOUT_MS = 30_000;

export interface QmpClientOptions {
	/** The socket factory — tests inject a fake duplex; production uses node:net. */
	readonly connect?: ConnectFn;
	/** Time allowed for greeting + qmp_capabilities (default HANDSHAKE_MS). */
	readonly handshakeMs?: number;
	/** Time allowed per command reply (default COMMAND_TIMEOUT_MS). */
	readonly commandTimeoutMs?: number;
	/** Async QMP events are dropped by default (the spike dropped them); set this to observe. */
	readonly onEvent?: (event: Record<string, unknown>) => void;
	/**
	 * Every QMP wire line, in order, terminator-free: outbound commands as sent plus every
	 * inbound frame (greeting, async events, responses). Absent by default — exactly
	 * today's traffic-dropping behavior; capture.ts feeds this an exchange ring so the
	 * teardown debug log keeps the last exchanges.
	 */
	readonly onExchange?: (line: string) => void;
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

interface Pending {
	readonly command: string;
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timer: NodeJS.Timeout;
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
export function connectQmp(socketPath: string, options: QmpClientOptions = {}): Promise<QmpClient> {
	const handshakeMs = options.handshakeMs ?? HANDSHAKE_MS;
	const commandTimeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
	return new Promise<QmpClient>((resolveConnect, rejectConnect) => {
		const decoder = new QmpDecoder();
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

		const socket = openQmpSocket(
			socketPath,
			{
				onData: (chunk: Buffer) => {
					for (const decoded of decoder.push(chunk)) {
						consume(decoded);
					}
				},
				onClose: () => {
					teardown("socket closed");
				},
				onError: (error: Error) => {
					teardown(`socket error: ${error.message}`);
				},
			},
			options.connect,
		);

		const handshakeTimer = setTimeout(() => {
			teardown(`no greeting within ${handshakeMs} ms`);
		}, handshakeMs);

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
			// Fires for EVERY inbound frame, not just responses: greeting and async events are
			// teardown evidence too (a SHUTDOWN event is exactly the fact capture exists to keep).
			options.onExchange?.(line);
			if ("QMP" in message) {
				greetingLine = line;
				resolveGreeting?.();
				return;
			}
			if ("event" in message) {
				options.onEvent?.(message);
				return; // async events are noise unless someone asked for them
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

		const consume = (decoded: QmpDecodedLine): void => {
			if (!decoded.ok) {
				teardown(decoded.error.message);
				return;
			}
			if (isInbound(decoded.value)) {
				dispatch(decoded.value, decoded.line);
			}
		};

		const execute = (command: string, args: Record<string, unknown> = {}): Promise<unknown> =>
			new Promise<unknown>((resolve, reject) => {
				if (!open) {
					reject(new Error(`qmp ${command}: socket is closed`));
					return;
				}
				const id = ++nextId;
				const timer = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`qmp ${command}: no reply within ${commandTimeoutMs} ms`));
				}, commandTimeoutMs);
				pending.set(id, { command, resolve, reject, timer });
				const frame = encodeQmpCommand(command, args, id);
				// The exchange log's unit is the LINE, both directions: inbound lines arrive
				// terminator-free (framing.ts trims), so the outbound frame's single trailing
				// "\n" (encodeQmpCommand's invariant) is dropped here for a uniform fire.
				options.onExchange?.(frame.slice(0, -1));
				socket.write(frame);
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
