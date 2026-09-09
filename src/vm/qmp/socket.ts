// The thinnest node:net wrapper the QMP client sits on (spec 24): open a unix socket,
// route data/close/error to handlers, expose write/end/destroy. Deliberately dumb — no
// QMP knowledge; framing lives in framing.ts and the protocol in client.ts. The connect
// seam is injectable so the whole client is testable against a fake duplex, zero real
// sockets. QEMU's exit closes this socket: the close/error handlers are what lets the
// client fail in-flight commands instead of writing into a dead socket where Node drops
// the bytes silently.
import { connect as nodeConnect } from "node:net";

/**
 * The duplex surface this wrapper drives — structural, so a real net.Socket and a test
 * fake fit alike.
 */
export interface QmpDuplex {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	on(event: "close", listener: () => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	write(chunk: string): boolean;
	end(): void;
	destroy(): void;
}

/** Opens the QMP control socket — the injectable seam; production is node:net's unix connect. */
export type ConnectFn = (socketPath: string) => QmpDuplex;

// The return annotation here is the compile-time proof that a real net.Socket satisfies
// QmpDuplex structurally (no cast needed anywhere else).
export const netConnectUnix: ConnectFn = (socketPath: string): QmpDuplex => nodeConnect({ path: socketPath });

export interface QmpSocketHandlers {
	onData: (chunk: Buffer) => void;
	onClose: () => void;
	onError: (error: Error) => void;
}

export interface QmpSocketHandle {
	write(text: string): void;
	end(): void;
	destroy(): void;
}

export function openQmpSocket(
	socketPath: string,
	handlers: QmpSocketHandlers,
	connect: ConnectFn = netConnectUnix,
): QmpSocketHandle {
	const socket = connect(socketPath);
	socket.on("data", handlers.onData);
	socket.on("close", handlers.onClose);
	socket.on("error", handlers.onError);
	return {
		write: (text: string): void => {
			socket.write(text);
		},
		end: (): void => {
			socket.end();
		},
		destroy: (): void => {
			socket.destroy();
		},
	};
}
