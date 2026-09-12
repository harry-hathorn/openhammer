/**
 * The local "inspector" channel (spec 17s): a Unix domain socket at
 * `~/.openhammer/openhammer.sock` (mode 0600, owner-only — no token, not
 * network-reachable) that serves {@link RequestEvent}s as NDJSON. On connect it
 * dumps the recorder's recent buffer, then streams live events as they arrive —
 * the ngrok `:4040` inspector, minus the network exposure. `openhammer monitor`
 * (17t) tails this feed. With a command executor wired (`deps.commands`) the
 * socket also ACCEPTS lines: one operator command ({@link VmCommandRequest})
 * per NDJSON line in, one {@link VmCmdResultLine} back — accepted, NOT
 * completed (progress is the state feed the command's effects emit).
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
import type { VmStatus } from "../vm/service.ts";

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
 * A channel-state line — the server's report of a configured channel's live
 * reachability, emitted on the status socket (spec 19c-channel). Distinct from a
 * {@link RequestEvent} (which carries no `type`): the `type: "channel-state"`
 * discriminator lets a client tell the two line kinds apart on one NDJSON stream.
 * Carried in the connection dump (channel state is static for a server's lifetime
 * — resolved once at boot), so a connecting dashboard reads it once and renders
 * the channels panel's live `up`/`down` + URL instead of `unknown`.
 */
export interface ChannelStateLine {
	/** The wire discriminator — distinguishes this from a `RequestEvent` line. */
	type: "channel-state";
	/** The configured channel's id (matches a `Settings.channels[].id` row). */
	id: string;
	/** Is the channel up (the boot resolved a handle for it)? */
	up: boolean;
	/** The channel's public URL, or `null` when it is down/has no URL. */
	url: string | null;
	/**
	 * The boot's actionable reason the channel is down (28j's tunnel-error
	 * visibility — the boot notice folded into the line), or absent/`null` when
	 * it is up. ADDITIVE: an older server never sends it and every existing
	 * consumer ignores it.
	 */
	error?: string | null;
}

/** Serialize a channel-state line as one NDJSON line (compact JSON + `\n`). */
export function formatChannelStateLine(line: ChannelStateLine): string {
	return `${JSON.stringify(line)}\n`;
}

/** Is `v` a plain object (not an array, not null)? */
function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Is `v` a structurally-valid {@link ChannelStateLine}? */
function isChannelStateLine(v: unknown): v is ChannelStateLine {
	if (!isStringRecord(v)) return false;
	return (
		v.type === "channel-state" &&
		typeof v.id === "string" &&
		typeof v.up === "boolean" &&
		(v.url === null || typeof v.url === "string") &&
		(v.error === undefined || v.error === null || typeof v.error === "string")
	);
}

/**
 * Parse one NDJSON line into a {@link ChannelStateLine}. Returns `null` for a
 * blank line, malformed JSON, or a value that isn't a channel-state line (a
 * {@link RequestEvent} shares the socket but carries no `type`). A skipped line,
 * never a throw — the same posture as `parseEventLine`.
 */
export function parseChannelStateLine(line: string): ChannelStateLine | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isChannelStateLine(parsed) ? parsed : null;
}

/**
 * A vm-state line — the server's report of the VM sandbox's live boot lifecycle
 * (spec 27 "Observability"), shaped like {@link ChannelStateLine}: a `type`
 * discriminator over the same NDJSON stream, so a client tells the three line
 * kinds apart — a {@link RequestEvent} (no `type`), channel-state, vm-state.
 * Carried in the connection dump (the LATEST snapshot — the socket binds after
 * the eager-async boot may already have begun, see {@link StartStatusSocketDeps.vmState}),
 * and every `VmService` transition streams one line to connected clients. An
 * `off`-mode server emits none, ever (the zero-VM-code pin): no getter, no
 * transitions — the stream is byte-for-byte the pre-27h one.
 */
export interface VmStateLine {
	/** The wire discriminator — distinguishes this from the other line kinds. */
	type: "vm-state";
	/** The lifecycle state (`VmService`'s readiness machine, spec 27e). */
	state: "off" | "booting" | "ready" | "stopped" | "failed";
	/** The live session id, or `null` before one is minted/resolved. */
	sessionId: string | null;
	/** The boot phase (`prepare`/`spawn`/`unlock`/`ssh`/`extras`), or `null` when no boot is in flight. */
	phase: string | null;
	/** The guest ssh hostfwd port, or `null` before discovery. */
	sshPort: number | null;
	/** The failure's actionable one-liner, or `null` when the state is not `failed`. */
	error: string | null;
}

/** Serialize a vm-state line as one NDJSON line (compact JSON + `\n`). */
export function formatVmStateLine(line: VmStateLine): string {
	return `${JSON.stringify(line)}\n`;
}

/** Is `v` a structurally-valid {@link VmStateLine}? */
function isVmStateLine(v: unknown): v is VmStateLine {
	if (!isStringRecord(v)) return false;
	return (
		v.type === "vm-state" &&
		(v.state === "off" ||
			v.state === "booting" ||
			v.state === "ready" ||
			v.state === "stopped" ||
			v.state === "failed") &&
		(v.sessionId === null || typeof v.sessionId === "string") &&
		(v.phase === null || typeof v.phase === "string") &&
		(v.sshPort === null || typeof v.sshPort === "number") &&
		(v.error === null || typeof v.error === "string")
	);
}

/**
 * Parse one NDJSON line into a {@link VmStateLine}. Returns `null` for a blank
 * line, malformed JSON, or a value that isn't a vm-state line (an event or
 * channel-state line shares the socket but carries another/`no` `type`). A
 * skipped line, never a throw — the same posture as `parseEventLine` /
 * `parseChannelStateLine`, and the additive-parse guarantee: a future line kind
 * parses to `null` here instead of mis-rendering or aborting the feed.
 */
export function parseVmStateLine(line: string): VmStateLine | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isVmStateLine(parsed) ? parsed : null;
}

/**
 * Map the service's status snapshot (`VmService.status()`, spec 27e) to the
 * wire line — the main.ts wiring's one mapping step, kept beside the shape it
 * produces (`phase: "none"` means no boot is in flight → `null` on the wire).
 * The state field types match structurally (the line's union restates
 * `VmState` so this wire module stays decoupled from the vm stack at runtime).
 */
export function vmStateLineFromStatus(status: VmStatus): VmStateLine {
	return {
		type: "vm-state",
		state: status.state,
		sessionId: status.sessionId,
		phase: status.phase === "none" ? null : status.phase,
		sshPort: status.sshPort,
		error: status.error,
	};
}

/**
 * The operator verbs the status socket accepts (one request per NDJSON line).
 * Only these two: the sandbox lifecycle is operator-owned, and these are the
 * operators' levers — a stop (any state, epoch-safe) and a restart (stop, then
 * the re-arming start). Everything else stays a tool/bearer decision.
 */
export type VmCommandName = "vm-stop" | "vm-restart";

/** One operator command line, parsed: `{"cmd":"vm-stop"}`. */
export interface VmCommandRequest {
	cmd: VmCommandName;
}

/** Is `v` a structurally-valid {@link VmCommandRequest}? (Extra keys tolerated — the same parse posture as every line kind here.) */
function isVmCommandRequest(v: unknown): v is VmCommandRequest {
	return isStringRecord(v) && (v.cmd === "vm-stop" || v.cmd === "vm-restart");
}

/**
 * Parse one NDJSON line into a {@link VmCommandRequest}. Returns `null` for a
 * blank line, malformed JSON, or a payload whose `cmd` isn't one of the two
 * verbs — the caller answers those with a `vm-cmd-result` naming the problem
 * instead of guessing. Strict on the verb set: a typo'd command refuses, it
 * never executes something adjacent.
 */
export function parseVmCommand(line: string): VmCommandRequest | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isVmCommandRequest(parsed) ? parsed : null;
}

/**
 * The synchronous verdict of a {@link VmCommandExecutor}: `ok` means the
 * command was ACCEPTED (kicked off), never that it finished — the reply is
 * accepted-not-completed, and completion arrives as vm-state lines on the same
 * feed. `error` carries the actionable refusal when the executor won't accept
 * (e.g. an off-mode server has no sandbox to stop).
 */
export interface VmCommandOutcome {
	ok: boolean;
	error: string | null;
}

/**
 * Executes one accepted-shape command — main.ts builds this in the closure
 * where the `VmService` lives and fire-and-forgets the async stop/start behind
 * it (the socket callback stays synchronous: reply now, stream progress later).
 */
export type VmCommandExecutor = (request: VmCommandRequest) => VmCommandOutcome;

/**
 * One reply line to an operator command — the fourth line kind on the stream
 * (event / channel-state / vm-state / this). `cmd` echoes the attempted
 * command: a {@link VmCommandName} when the shape parsed, otherwise the raw
 * (truncated) payload so a malformed request is diagnosable from the reply
 * alone. `ok: false` + an actionable `error` for refusals and parse failures.
 */
export interface VmCmdResultLine {
	/** The wire discriminator — distinguishes this from the other line kinds. */
	type: "vm-cmd-result";
	/** The attempted command (see above). */
	cmd: string;
	/** Was the command accepted (kicked off)? Never "completed". */
	ok: boolean;
	/** The actionable refusal/parse problem, or `null` when accepted. */
	error: string | null;
}

/** Serialize a vm-cmd-result line as one NDJSON line (compact JSON + `\n`). */
export function formatVmCmdResultLine(line: VmCmdResultLine): string {
	return `${JSON.stringify(line)}\n`;
}

/** Is `v` a structurally-valid {@link VmCmdResultLine}? */
function isVmCmdResultLine(v: unknown): v is VmCmdResultLine {
	return (
		isStringRecord(v) &&
		v.type === "vm-cmd-result" &&
		typeof v.cmd === "string" &&
		typeof v.ok === "boolean" &&
		(v.error === null || typeof v.error === "string")
	);
}

/**
 * Parse one NDJSON line into a {@link VmCmdResultLine}. Returns `null` for a
 * blank line, malformed JSON, or another line kind — the additive-parse rule
 * every consumer on this stream shares (an unknown kind skips, never aborts).
 */
export function parseVmCmdResultLine(line: string): VmCmdResultLine | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isVmCmdResultLine(parsed) ? parsed : null;
}

/** Cap for the echoed `cmd` on a failed parse (a runaway line is not echoed whole). */
const ECHO_MAX = 80;

/** Collapse whitespace + truncate a raw payload for the reply's `cmd` echo. */
function echoOf(raw: string): string {
	const oneLine = raw.replace(/\s+/g, " ").trim();
	return oneLine.length > ECHO_MAX ? `${oneLine.slice(0, ECHO_MAX - 3)}...` : oneLine;
}

/**
 * Execute one raw command line against `commands`, producing exactly the reply
 * line. This is the whole request semantics: parse → execute → reply, with
 * parse failures answered (never thrown, never silent) so an operator sees
 * WHAT was wrong. Blank lines never reach here (skipped by the reader).
 */
export function runVmCommand(raw: string, commands: VmCommandExecutor): VmCmdResultLine {
	const trimmed = raw.trim();
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "not JSON";
		return {
			type: "vm-cmd-result",
			cmd: echoOf(trimmed),
			ok: false,
			error: `malformed command — not JSON: ${reason}`,
		};
	}
	const request = isVmCommandRequest(parsed) ? parsed : null;
	if (request === null) {
		const echoed = isStringRecord(parsed) && typeof parsed.cmd === "string" ? echoOf(parsed.cmd) : echoOf(trimmed);
		return {
			type: "vm-cmd-result",
			cmd: echoed,
			ok: false,
			error: `not a vm command — expected {"cmd":"vm-stop"} or {"cmd":"vm-restart"}`,
		};
	}
	const outcome = commands(request);
	return { type: "vm-cmd-result", cmd: request.cmd, ok: outcome.ok, error: outcome.error };
}

/**
 * Per-connection command-intake cap: a tail that grows past 8 KiB without a
 * newline is a runaway/foreign client (no real command is this big) — the
 * connection is destroyed rather than buffered forever.
 */
export const MAX_VM_COMMAND_BYTES = 8_192;

/**
 * The minimal sink a connection needs — `net.Socket` satisfies it. Declared so a
 * unit test can inject a recording fake without spinning a real socket. The
 * listener-returning methods return `unknown` (we never use the return value);
 * `net.Socket`'s return `this`, which is assignable.
 */
export interface StatusSocket {
	write(chunk: string | Uint8Array): boolean;
	once(event: "close" | "error", listener: () => void): unknown;
	/** The command-intake listener (`deps.commands` wired only — see {@link handleConnection}). */
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
	off(event: "data", listener: (chunk: Buffer) => void): unknown;
	/** Forcibly drop the connection (the command-cap escape hatch). */
	destroy(): void;
}

/** A started status socket — `close()` stops serving, drops clients, removes the file. */
export interface StatusSocketHandle {
	/** The filesystem path the socket is bound to. */
	path: string;
	/** Stop serving, destroy active connections, and remove the socket file. */
	close(): Promise<void>;
	/**
	 * Stream a vm-state transition line (spec 27h) to every connected client,
	 * best-effort: a write failure destroys just that connection (its
	 * `handleConnection` cleanup runs on the close event). The caller's latest-
	 * state ref stays caller-owned — the dump getter reads it; this only streams.
	 */
	emitVmState(line: VmStateLine): void;
}

/** Injection seams (the `11a`/`13`/`17d` precedent): a temp `path` + a `warn` logger keep tests hermetic. */
export interface StartStatusSocketDeps {
	/** Override the socket path (tests use a temp dir). Defaults to {@link statusSocketPath}. */
	path?: string;
	/** Factory for the net server (tests inject a fresh one). Defaults to `net.createServer()`. */
	createServer?: () => Server;
	/**
	 * The per-channel live-state snapshot to dump on each connect (spec 19c-channel).
	 * Static for a server's lifetime (resolved once at boot); absent/empty means no
	 * channel state is advertised and the dashboard shows `unknown`. Defaults to `[]`.
	 */
	channels?: ChannelStateLine[];
	/**
	 * The LATEST vm-state snapshot (spec 27h), read per connection for the dump.
	 * A GETTER, not a static value: the socket starts AFTER the service's
	 * eager-async boot (main.ts kicks `start()` off before binding), so the first
	 * `booting` transition can predate the bind — each connect must read the
	 * caller's latest ref, not a boot-time copy. Answer `null` for a non-VM mode
	 * or nothing-observed-yet: no vm-state line is dumped (the additive rule —
	 * the stream stays byte-for-byte the pre-27h one). Defaults to `() => null`.
	 */
	vmState?: () => VmStateLine | null;
	/**
	 * The operator-command executor (28i): when wired, each connection also READS
	 * — one {@link VmCommandRequest} per NDJSON line in, one
	 * {@link VmCmdResultLine} back. Unset (the default): the connection never
	 * registers a data listener and the stream is byte-for-byte the read-only
	 * pre-command one. Auth posture unchanged — the 0600 same-user file is the
	 * gate, and these verbs are operator levers the same user already owns.
	 */
	commands?: VmCommandExecutor;
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
 * Handle one monitor connection: dump the channel-state snapshot (the "what's
 * configured + live now" view), then the vm-state snapshot (the sandbox's boot
 * lifecycle, spec 27h — omitted when `vmState` is `null`), then the recent
 * buffer (history), then stream live events. With `commands` wired, the
 * connection also reads operator command lines (one reply per line; a tail
 * over {@link MAX_VM_COMMAND_BYTES} without a newline destroys the
 * connection). A write failure or a `close`/`error` on the socket unsubscribes
 * (idempotently) so a dead client never leaks a subscriber. Exported so the
 * dump-then-stream + cleanup logic is unit-tested with a fake socket.
 */
export function handleConnection(
	socket: StatusSocket,
	recorder: RequestRecorder,
	channels: readonly ChannelStateLine[] = [],
	vmState: VmStateLine | null = null,
	commands?: VmCommandExecutor,
): void {
	let closed = false;
	// Initialized to a no-op so `cleanup` can run before `subscribe` reassigns it.
	let unsub: () => void = () => {};
	let offData: () => void = () => {};
	const cleanup = (): void => {
		if (closed) return;
		closed = true;
		unsub();
		offData();
	};

	// Command intake (28i) — only when the executor is wired. Without it the
	// data listener is never registered and the stream is byte-for-byte the
	// read-only pre-command one. NDJSON per connection: complete lines execute
	// one-for-one (each answered), blank lines skip, and a tail over the cap
	// without a newline destroys the socket (cleanup runs on the close event
	// this fires).
	if (commands !== undefined) {
		const executor = commands;
		let pending = Buffer.alloc(0);
		const onData = (chunk: Buffer): void => {
			pending = Buffer.concat([pending, chunk]);
			if (pending.length > MAX_VM_COMMAND_BYTES) {
				socket.destroy();
				return;
			}
			let nl = pending.indexOf(0x0a);
			while (nl >= 0) {
				const raw = pending.subarray(0, nl).toString("utf8");
				pending = pending.subarray(nl + 1);
				nl = pending.indexOf(0x0a);
				const trimmed = raw.trim();
				if (trimmed === "") continue; // a blank line carries no command
				const result = runVmCommand(trimmed, executor);
				if (!safeWrite(socket, formatVmCmdResultLine(result))) {
					cleanup();
					return;
				}
			}
		};
		socket.on("data", onData);
		offData = () => {
			socket.off("data", onData);
		};
	}

	unsub = recorder.subscribe((event) => {
		if (!safeWrite(socket, formatEventLine(event))) cleanup();
	});

	// Channel state first (static per server lifetime — the dashboard reads it
	// once on connect to render the channels panel). Bail if the client is gone.
	for (const line of channels) {
		if (!safeWrite(socket, formatChannelStateLine(line))) {
			cleanup();
			return;
		}
	}

	// The vm-state snapshot next (the sandbox's boot lifecycle, spec 27h) — the
	// caller's latest read at connect time. `null` (off mode / nothing observed)
	// writes nothing: the stream stays byte-for-byte the pre-27h one.
	if (vmState !== null && !safeWrite(socket, formatVmStateLine(vmState))) {
		cleanup();
		return;
	}

	// Dump history next (oldest → newest); bail out if the client is already gone.
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
	const channels = deps.channels ?? [];
	const vmState = deps.vmState ?? ((): VmStateLine | null => null);
	const commands = deps.commands;
	const sockets = new Set<Socket>();

	// Track open connections so `close()` can drop monitor clients promptly. The
	// vm-state getter is read PER connection (not captured once at bind) so each
	// dump carries the latest state (spec 27h — the boot outlives the bind).
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		handleConnection(socket, recorder, channels, vmState(), commands);
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
		emitVmState(line: VmStateLine): void {
			for (const socket of sockets) {
				if (!safeWrite(socket, formatVmStateLine(line))) {
					// Dead client — destroy just this connection; its handleConnection
					// cleanup (unsubscribe) runs on the close event this fires.
					socket.destroy();
				}
			}
		},
		async close(): Promise<void> {
			for (const socket of sockets) socket.destroy();
			sockets.clear();
			await closeServer(server);
			if (existsSync(path)) unlinkSync(path);
		},
	};
}
