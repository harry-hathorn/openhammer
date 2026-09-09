import { describe, expect, it } from "vitest";
import { type ConnectFn, openQmpSocket, type QmpDuplex } from "./socket.ts";

/** A recording duplex standing in for net.Socket — no I/O, just what the wrapper drives. */
function fakeDuplex(): QmpDuplex & {
	written: string[];
	isEnded: boolean;
	isDestroyed: boolean;
	emitData(text: string): void;
	emitClose(): void;
	emitError(message: string): void;
} {
	const written: string[] = [];
	const dataListeners: Array<(chunk: Buffer) => void> = [];
	const closeListeners: Array<() => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	return {
		// The single-cast implementor of the overloaded `on`: TS cannot correlate the `event`
		// union with the matching listener union, so each branch narrows by hand (documented
		// exception — assert only where the compiler cannot see the correlation).
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

describe("openQmpSocket", () => {
	it("passes the socket path to the injected connect seam", () => {
		const paths: string[] = [];
		const connect: ConnectFn = (socketPath: string): QmpDuplex => {
			paths.push(socketPath);
			return fakeDuplex();
		};
		openQmpSocket("/run/qmp.sock", { onData: () => {}, onClose: () => {}, onError: () => {} }, connect);
		expect(paths).toEqual(["/run/qmp.sock"]);
	});

	it("routes data, close, and error events to the handlers", () => {
		const socket = fakeDuplex();
		const chunks: string[] = [];
		const closes: number[] = [];
		const errors: string[] = [];
		openQmpSocket(
			"/run/qmp.sock",
			{
				onData: (chunk) => chunks.push(chunk.toString("utf8")),
				onClose: () => closes.push(1),
				onError: (error) => errors.push(error.message),
			},
			() => socket,
		);
		socket.emitData("hello\n");
		socket.emitData("world\n");
		socket.emitError("EPIPE");
		socket.emitClose();
		expect(chunks).toEqual(["hello\n", "world\n"]);
		expect(errors).toEqual(["EPIPE"]);
		expect(closes).toEqual([1]);
	});

	it("delegates write, end, and destroy to the duplex", () => {
		const socket = fakeDuplex();
		const handle = openQmpSocket(
			"/run/qmp.sock",
			{ onData: () => {}, onClose: () => {}, onError: () => {} },
			() => socket,
		);
		handle.write('{"execute":"qmp_capabilities"}\n');
		expect(socket.written).toEqual(['{"execute":"qmp_capabilities"}\n']);
		expect(socket.isEnded).toBe(false);
		expect(socket.isDestroyed).toBe(false);
		handle.end();
		expect(socket.isEnded).toBe(true);
		handle.destroy();
		expect(socket.isDestroyed).toBe(true);
	});
});
