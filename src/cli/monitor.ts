/**
 * The `openhammer monitor` command (spec 17t): connect to the status socket
 * (`~/.openhammer/openhammer.sock`, the spec-17s local inspector) and stream a
 * live feed of inbound `POST /mcp` activity — each event as a tail-`f` line
 * (`[HH:MM:SS] client  method tool  duration bytes`), with a rolling header of
 * active clients + call counts reprinted whenever a new client joins. Local-only
 * by design: the socket is a Unix domain file (`0600`, owner-only), unreachable
 * over any network (no token, no exposure) — the same trust boundary the
 * credential lives behind.
 *
 * **Streaming, not a dashboard.** There is no render loop (the §2.1 footprint
 * rule): lines append tail-`f`-style. The pure parse/format/state logic lives in
 * {@link src/tui/monitor-view.ts} (unit-tested directly); this module owns only
 * the socket connection + the line-by-line stream → render loop.
 *
 * **The banner** is printed by `runCli` on an interactive (TTY) launch, as for
 * `doctor`/`config`/`channel list` — `monitorCommand` does not self-print it (it
 * would double). It writes a one-line intro framing the feed, then streams.
 *
 * **Graceful boundary.** A missing socket (the server isn't running) → a
 * one-line actionable stderr message + exit `1`, never a thrown stack. The
 * command blocks until the socket closes (the server stopped) or the operator
 * Ctrl+Cs the process (the default SIGINT behavior terminates it, like `tail -f`).
 */
import { createConnection } from "node:net";
import { statusSocketPath } from "../observability/status-socket.ts";
import type { BannerStream } from "../tui/banner.ts";
import { formatClientHeader, formatEvent, MonitorState, parseEventLine } from "../tui/monitor-view.ts";

/** Where {@link monitorCommand} writes — a structural slice of the CLI's `CommandIo` (avoids a `cli.ts` import cycle, mirroring `DoctorIo`). */
export interface MonitorIo {
	stdout: BannerStream;
	stderr: BannerStream;
}

/**
 * The minimal connection surface `monitorCommand` needs. Per-event methods (not
 * an overloaded `on`) so the unit-test fake stores typed listeners with **no
 * `as` cast** — `net.Socket` (via the default {@link defaultConnect} adapter)
 * satisfies each method's `socket.on(event, cb)` overload.
 */
export interface MonitorConnection {
	onData(listener: (chunk: Buffer) => void): void;
	onError(listener: (err: Error) => void): void;
	onClose(listener: () => void): void;
	/** Destroy the connection (best-effort — the OS reaps the socket file on process exit regardless). */
	destroy(): void;
}

/** Injectable seams for {@link monitorCommand} (the `11a`/`13`/`17b`–`17s` precedent): a temp `path` + a `connect` factory keep tests hermetic. */
export interface MonitorDeps {
	/** Override the socket path (tests use a temp path). Defaults to {@link statusSocketPath}. */
	path?: string;
	/** Factory for the connection (tests inject a fake). Defaults to {@link defaultConnect} (a real `net.createConnection`). */
	connect?: (path: string) => MonitorConnection;
}

/**
 * The default connection: a real Unix-domain-socket client, adapted to the
 * per-event surface. `void` discards `socket.on`'s `this` return; the typed
 * `cb` matches each `net.Socket.on(event, …)` overload, so there is **no `as`**.
 */
const defaultConnect = (path: string): MonitorConnection => {
	const socket = createConnection(path);
	return {
		onData: (cb) => void socket.on("data", cb),
		onError: (cb) => void socket.on("error", cb),
		onClose: (cb) => void socket.on("close", cb),
		destroy: () => void socket.destroy(),
	};
};

/** Narrow an unknown catch/error value to its message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Read an `ErrnoException.code` (`"ENOENT"`/`"ECONNREFUSED"`) if present, else
 * `null` — the no-`as` `"code" in` + `typeof` narrowing (the `errnoCode` in
 * `src/tools/edit.ts` precedent).
 */
function errnoCodeOf(err: unknown): string | null {
	if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "string") {
		return err.code;
	}
	return null;
}

/**
 * The `openhammer monitor` command: connect to the status socket, stream events
 * as monitor lines, and block until the socket closes. Returns `0` on a clean
 * close, `1` when the socket can't be reached (the server isn't running) or the
 * stream errors. `deps.path`/`deps.connect` inject a temp socket + fake
 * connection for hermetic tests.
 */
export async function monitorCommand(io: MonitorIo, deps: MonitorDeps = {}): Promise<number> {
	const path = deps.path ?? statusSocketPath();
	const connect = deps.connect ?? defaultConnect;
	const state = new MonitorState();
	let buf = "";

	/** Parse one line, fold it into the active-client state, and render it (+ a header on a new client). */
	const consumeLine = (line: string): void => {
		const event = parseEventLine(line);
		if (event === null) return; // blank/malformed — skip, the feed never aborts
		const isNew = !state.has(event.client);
		state.apply(event);
		if (isNew) io.stdout.write(`${formatClientHeader(state.stats())}\n`);
		io.stdout.write(`${formatEvent(event)}\n`);
	};

	let connection: MonitorConnection;
	try {
		connection = connect(path);
	} catch (e) {
		io.stderr.write(`Not monitoring: cannot open the status socket (${messageOf(e)}).\n`);
		io.stderr.write(`Is the OpenHammer server running? The socket is at ${path}.\n`);
		return 1;
	}

	io.stdout.write(`Monitoring ${path} — Ctrl+C to stop.\n`);

	return new Promise<number>((resolve) => {
		let settled = false;
		const finish = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve(code);
		};

		connection.onData((chunk) => {
			buf += chunk.toString("utf8");
			// Split on `\n` (NDJSON); the socket chunks may split a line or carry many.
			let nl = buf.indexOf("\n");
			while (nl >= 0) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				nl = buf.indexOf("\n");
				consumeLine(line);
			}
		});
		connection.onError((err) => {
			// The socket is absent (server not running) → the actionable hint; any
			// other error → the raw message. Either way the command exits 1.
			const code = errnoCodeOf(err);
			if (code === "ENOENT" || code === "ECONNREFUSED") {
				io.stderr.write(`Not monitoring: the status socket was not found at ${path}.\n`);
				io.stderr.write("Is the OpenHammer server running? Start it with `openhammer start`.\n");
			} else {
				io.stderr.write(`monitor: connection error (${messageOf(err)}).\n`);
			}
			finish(1);
		});
		connection.onClose(() => {
			finish(0); // the server stopped — a clean end of stream
		});
	});
}
