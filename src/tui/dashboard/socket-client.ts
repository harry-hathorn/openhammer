/**
 * The dashboard's status-socket client (spec 19c): connects to the running
 * server's inspector socket (spec 17s — `statusSocketPath()` + `RequestEvent`
 * NDJSON) and delivers parsed events into the dashboard's `subscribe` seam
 * (19b), which folds them into the monitor feed + clients panel. This is a
 * **view over the running server, not a second socket**: it reuses the exact
 * wire protocol `openhammer monitor` (17t) tails — `statusSocketPath` (17s) +
 * `parseEventLine` (17t) — so there is one source of truth for the event format.
 *
 * **The subscribe seam.** `runDashboard`'s `DashboardDeps.subscribe` is
 * `(onEvent) => () => void` — register a listener, get an unsubscribe. This module
 * builds that seam from a real socket connection: {@link createSocketSubscriber}
 * returns a `subscribe` function that, when the dashboard calls it (once, on
 * start), opens a connection, buffers + splits the NDJSON stream, parses each
 * line via `parseEventLine`, and forwards valid {@link RequestEvent}s (the dump
 * on connect first, then live). The returned unsubscribe destroys the connection
 * (idempotent) so a dashboard quit leaves no orphan socket.
 *
 * **Graceful-absent, never throws.** The socket may not exist (the server isn't
 * running yet) or may close mid-stream; either way the client delivers nothing
 * more and tears down quietly — the dashboard shows "(none connected)"/"(quiet …)"
 * rather than crashing. A connect throw or stream error is logged via the injected
 * `warn` (not propagated), mirroring the null-safe `startTunnel`/`startStatusSocket`
 * posture (a local convenience, never a boot gate).
 *
 * **Connection seam (injectable).** `connect: (path) => SocketConnection` defaults
 * to a real `net.createConnection` adapter; tests inject a fake that feeds NDJSON
 * chunks. The surface mirrors `MonitorConnection` in `src/cli/monitor.ts` (the
 * same per-event `net.Socket` listeners); it is kept local so the dashboard (a
 * lower layer than the CLI) does not depend on `src/cli/` — a future consolidation
 * could lift a shared status-socket client into `src/observability/`.
 *
 * **Channel live-state (spec 19c-channel).** The server emits a
 * `{ type: "channel-state", id, up, url }` line in the connection dump (threaded
 * from `resolveChannelHandle` in `main.ts` via `startStatusSocket`). This client
 * parses both line kinds — `RequestEvent`s go to `onEvent` (unchanged),
 * channel-state lines go to an optional `onChannelState` callback (the 2nd arg).
 * The 2nd arg is optional, so every existing `subscribe((e) => …)` call site is
 * unchanged; `openhammer monitor` (which ignores channel-state) is unaffected too.
 */
import { createConnection } from "node:net";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import { type ChannelStateLine, parseChannelStateLine, statusSocketPath } from "../../observability/status-socket.ts";
import { parseEventLine } from "../monitor-view.ts";

/**
 * The minimal connection surface the client needs. `net.Socket` satisfies it via
 * the default {@link connectStatusSocket} adapter. Structurally identical to
 * `MonitorConnection` in `src/cli/monitor.ts`; kept local so the dashboard does
 * not depend on the CLI module (a lower layer must not import a higher one).
 */
export interface SocketConnection {
	onData(listener: (chunk: Buffer) => void): void;
	onError(listener: (err: Error) => void): void;
	onClose(listener: () => void): void;
	/** Destroy the connection (best-effort — the OS reaps the socket on exit regardless). */
	destroy(): void;
}

/** Injection seams for {@link createSocketSubscriber} (the `11a`/`13`/`17b`–`17t` precedent). */
export interface DashboardSocketDeps {
	/** Override the socket path (tests use a temp path). Defaults to {@link statusSocketPath}. */
	path?: string;
	/** Factory for the connection (tests inject a fake). Defaults to {@link connectStatusSocket}. */
	connect?: (path: string) => SocketConnection;
	/** Best-effort logger for a connect/stream error. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/**
 * The default connection: a real Unix-domain-socket client adapted to the
 * per-event surface (mirrors `monitor.ts`'s adapter). `void` discards
 * `socket.on`'s `this` return; the typed callback matches each `net.Socket.on`
 * overload, so there is **no `as`**.
 */
export function connectStatusSocket(path: string): SocketConnection {
	const socket = createConnection(path);
	return {
		onData: (cb) => void socket.on("data", cb),
		onError: (cb) => void socket.on("error", cb),
		onClose: (cb) => void socket.on("close", cb),
		destroy: () => void socket.destroy(),
	};
}

/** Narrow an unknown catch/error value to its message (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Build the dashboard's `subscribe` seam from the status socket. The returned
 * function opens a fresh connection when the dashboard subscribes (once, on
 * start), delivers the recent dump then live {@link RequestEvent}s to `onEvent`,
 * and any channel-state lines to the optional `onChannelState` (the dashboard
 * folds them into its `channelState` snapshot). Returns an idempotent unsubscribe
 * that destroys the connection. Never throws — a missing/errored socket warns +
 * delivers nothing.
 */
export function createSocketSubscriber(
	deps: DashboardSocketDeps = {},
): (onEvent: (event: RequestEvent) => void, onChannelState?: (state: ChannelStateLine) => void) => () => void {
	const path = deps.path ?? statusSocketPath();
	const connect = deps.connect ?? connectStatusSocket;
	const warn = deps.warn ?? ((message: string) => console.warn(message));

	return (
		onEvent: (event: RequestEvent) => void,
		onChannelState?: (state: ChannelStateLine) => void,
	): (() => void) => {
		let destroyed = false;
		let buf = "";
		let conn: SocketConnection | undefined;

		/** Idempotent teardown: destroy the connection once, then ignore further events. */
		const teardown = (): void => {
			if (destroyed) return;
			destroyed = true;
			conn?.destroy();
			conn = undefined;
		};

		try {
			conn = connect(path);
		} catch (e) {
			// Never connected — there is nothing to tear down. The dashboard shows its
			// empty panels; 19e (server lifecycle) surfaces a real "server down" status.
			warn(`dashboard status-socket client: cannot connect (${messageOf(e)}).`);
			return () => {};
		}

		conn.onData((chunk) => {
			if (destroyed) return;
			buf += chunk.toString("utf8");
			// NDJSON: a chunk may split a line or carry many. Parse each complete line:
			// a RequestEvent → onEvent; a channel-state line → onChannelState (19c-channel).
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				const event = parseEventLine(line);
				if (event !== null) {
					onEvent(event);
					continue;
				}
				const state = parseChannelStateLine(line);
				if (state !== null && onChannelState !== undefined) onChannelState(state);
				// blank/malformed lines are skipped — the feed never aborts
			}
		});
		conn.onError((err) => {
			warn(`dashboard status-socket client: ${messageOf(err)}.`);
			teardown();
		});
		conn.onClose(() => {
			// The server stopped (a clean end of stream). v1 does not auto-reconnect — the
			// status panel (19e) shows "down" and the feed simply goes quiet.
			teardown();
		});

		return teardown;
	};
}
