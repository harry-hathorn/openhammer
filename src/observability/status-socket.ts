/**
 * The local "inspector" channel (spec 17s): a Unix domain socket at
 * `~/.openhammer/openhammer.sock` (mode 0600, owner-only — no token, not
 * network-reachable) that serves {@link RequestEvent}s as NDJSON. On connect it
 * dumps the recorder's recent buffer, then streams live events as they arrive —
 * the ngrok `:4040` inspector, minus the network exposure. `openhammer monitor`
 * (17t) tails this feed.
 *
 * **Auth-free by design.** A Unix domain socket is filesystem-local, so it is
 * unreachable over any network. The socket file is `0600` under the owner's
 * `~/.openhammer` (the same dir as `credential.json`), so only the same OS user
 * can connect — the same trust boundary the bearer token already lives behind.
 * No token is required or checked: the OS file permissions are the gate.
 *
 * **Best-effort + null-safe** (mirrors `startTunnel`, spec 13): a bind failure
 * (an unwritable dir, a stale socket that can't be cleared) returns `null` and
 * the server keeps serving — the status socket is a local convenience, never a
 * boot gate. Each connection's writes are best-effort: a dead client (write
 * throws / the socket closes) is cleaned up and dropped, never propagated.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { RequestEvent, RequestRecorder } from "../mcp/telemetry.ts";

const SOCKET_DIR = ".openhammer";
const SOCKET_FILE = "openhammer.sock";

/**
 * Resolve the status-socket path under a home dir (defaults to `os.homedir()`).
 * Mirrors `credentialPath` / `settingsPath`: same `~/.openhammer` dir, distinct
 * file (`openhammer.sock`).
 */
export function statusSocketPath(homeDir: string = homedir()): string {
	return join(homeDir, SOCKET_DIR, SOCKET_FILE);
}

/** Serialize an event as one NDJSON line (compact JSON + `\n`). */
export function formatEventLine(event: RequestEvent): string {
	return `${JSON.stringify(event)}\n`;
}

/**
 * The minimal sink a connection needs — `net.Socket` satisfies it. Declared so a
 * unit test can inject a recording fake without spinning a real socket. `once`
 * returns `unknown` (we never use the return value); `net.Socket.once` returns
 * `this`, which is assignable.
 */
export interface StatusSocket {
	write(chunk: string | Uint8Array): boolean;
	once(event: "close" | "error", listener: () => void): unknown;
}

/** A started status socket — `close()` stops serving, drops clients, removes the file. */
export interface StatusSocketHandle {
	/** The filesystem path the socket is bound to. */
	path: string;
	/** Stop serving, destroy active connections, and remove the socket file. */
	close(): Promise<void>;
}

/** Injection seams (the `11a`/`13`/`17d` precedent): a temp `path` + a `warn` logger keep tests hermetic. */
export interface StartStatusSocketDeps {
	/** Override the socket path (tests use a temp dir). Defaults to {@link statusSocketPath}. */
	path?: string;
	/** Factory for the net server (tests inject a fresh one). Defaults to `net.createServer()`. */
	createServer?: () => Server;
	/** Best-effort logger for a server-level socket error. Defaults to `console.warn`. */
	warn?: (message: string) => void;
}

/** `net.Server.listen` → Promise that resolves on `listening`, rejects on `error`. */
function listen(server: Server, path: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const onError = (err: NodeJS.ErrnoException): void => {
			server.off("listening", onListening);
			reject(err);
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(path);
	});
}

/** `net.Server.close` → Promise that resolves once stopped (callback form). */
function closeServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		server.close(() => resolve());
	});
}

/**
 * Write a line to a socket, best-effort. Returns `false` when the write threw
 * (a destroyed/gone socket raises `ERR_STREAM_DESTROYED`); the caller then treats
 * the connection as dead. `socket.write`'s own `false` (backpressure) is left to
 * flow-control — only a throw signals a dead client here.
 */
export function safeWrite(socket: StatusSocket, line: string): boolean {
	try {
		return socket.write(line);
	} catch {
		return false;
	}
}

/**
 * Handle one monitor connection: dump the recent buffer (history), then stream
 * live events. A write failure or a `close`/`error` on the socket unsubscribes
 * (idempotently) so a dead client never leaks a subscriber. Exported so the
 * dump-then-stream + cleanup logic is unit-tested with a fake socket.
 */
export function handleConnection(socket: StatusSocket, recorder: RequestRecorder): void {
	let closed = false;
	// Initialized to a no-op so `cleanup` can run before `subscribe` reassigns it.
	let unsub: () => void = () => {};
	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		unsub();
	};

	unsub = recorder.subscribe((event) => {
		if (!safeWrite(socket, formatEventLine(event))) cleanup();
	});

	// Dump history first (oldest → newest); bail out if the client is already gone.
	for (const event of recorder.recent()) {
		if (!safeWrite(socket, formatEventLine(event))) {
			cleanup();
			return;
		}
	}

	socket.once("close", cleanup);
	socket.once("error", cleanup);
}

/**
 * Start the status socket: clear any stale file, listen, `chmod 0600`, wire the
 * dump-then-stream connection handler. Returns `null` (never throws) when it
 * can't bind — the caller logs and continues serving without a live inspector.
 */
export async function startStatusSocket(
	recorder: RequestRecorder,
	deps: StartStatusSocketDeps = {},
): Promise<StatusSocketHandle | null> {
	const path = deps.path ?? statusSocketPath();
	const server = deps.createServer?.() ?? createServer();
	const warn = deps.warn ?? ((message: string) => console.warn(message));
	const sockets = new Set<Socket>();

	// Track open connections so `close()` can drop monitor clients promptly.
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleConnection(socket, recorder);
	});
	// A server-level error after listen must not crash the process (connection
	// errors are handled per-socket in `handleConnection`).
	server.on("error", (err) => warn(`status socket error: ${err instanceof Error ? err.message : String(err)}`));

	try {
		// Ensure the parent dir exists (0700, the credential-dir precedent). It is
		// NOT guaranteed to exist: `ensureToken` creates `~/.openhammer` only when
		// minting a credential, but an `MCP_AUTH_TOKEN` override skips that — so an
		// override-driven boot would otherwise ENOENT here and lose the inspector.
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		// Clear a stale socket file from a previous (crashed) run, else listen EADDRINUSE.
		if (existsSync(path)) unlinkSync(path);
		await listen(server, path);
		chmodSync(path, 0o600);
	} catch {
		// Best-effort: tear the half-built server down and let the server keep serving.
		await closeServer(server);
		return null;
	}

	return {
		path,
		async close(): Promise<void> {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await closeServer(server);
			if (existsSync(path)) unlinkSync(path);
		},
	};
}
