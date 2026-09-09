// The ssh transport — spec 25's src/vm/ssh.ts: the argv builders + process wrapper every VM
// tool op rides (25c's ToolBackend is the consumer; this file knows nothing about tools).
// System `ssh`, zero npm deps, ONE ControlMaster per session — 22-measured gate 7 / finding 13
// makes the mux mandatory: ~7.4 ms/op warm vs ~140 ms/op fresh (~20x), and the recorded ssh2
// fast-follow trigger did NOT fire. Everything below exists to make those numbers real while
// keeping AGENTS.md:78 spawn hygiene: openhammer never builds a host shell string at all, and
// the ONE remote shell string it produces (the pre-joined command) is assembled exclusively
// from remoteQuote()d words.
//
// THE PIN (no TOFU, ever): every argv these builders emit carries StrictHostKeyChecking=yes
// with a per-session UserKnownHostsFile AND GlobalKnownHostsFile=/dev/null (so the host's own
// /etc/ssh/ssh_known_hosts can never answer for the guest), plus `-F /dev/null` — no user or
// system ssh config contributes ANYTHING (no `Host *` ForwardAgent/ProxyJump surprise can
// ride the sandbox transport; the argv is the whole truth). Spec 26's provisioning writes the
// golden manifest's host key in OpenSSH's non-default-port form `[127.0.0.1]:<port>`. A
// missing/short pin file FAILS the connection ("Host key verification failed") — the safe
// direction: an orphan VM that happens to land on a reused ephemeral port cannot become the
// target, because it cannot present the pinned key. The check runs once, at master
// establishment; muxed connections inherit it (they ride the already-verified socket).
//
// THE QUOTING CHAIN (the one subtle part of this file): ssh receives the remote command as
// trailing argv elements, JOINS THEM WITH SPACES, and ships the joined string to the remote
// sshd, which hands it to the user's shell (`sh -c <joined>`). OpenSSH performs NO
// per-argument quoting on that join — an element containing spaces, quotes, `$()`, backticks,
// or newlines would otherwise arrive split and/or re-evaluated by the remote shell. So this
// layer quotes every element for POSIX sh (remoteQuote) and hands ssh exactly ONE pre-joined
// command element. 25b's hostile-input round-trips verify guest-side arrival verbatim rather
// than trusting this analysis.
//
// Error model: transport layer, not tools (the qemu/process.ts precedent). Non-zero guest
// exits RESOLVE (code + tails — the caller judges); the promise rejects only on a spawn
// error, i.e. the ssh binary itself missing. There is deliberately NO host-side timeout
// kill: killing the ssh client does not kill a remote non-PTY child (spec 25's sshd-orphan
// note), so the GUEST-side `timeout -k 5 <N>s` wrapper in 25c's runShell is the kill story —
// a hung ssh against a dead guest instead surfaces through ConnectTimeout (fresh connects)
// or master death (muxed clients exit 255), and connection death mid-command lands here as
// exitCode 255 + stderr tail for 25c to fold into its actionable error naming the serial log.
import { spawn } from "node:child_process";
import type { ShellResult } from "../tools/backend.ts";
import { isToolAvailable } from "../tools/bin.ts";

/** The system binary this layer spawns (the QEMU_BIN precedent: the name lives with the spawner). */
export const SSH_BIN = "ssh";

/**
 * Fresh-connect bound, seconds — the worst-case wall before a dead guest surfaces on an
 * unmuxed connect. Muxed ops never connect at all (gate 7's single-digit ms).
 */
export const SSH_CONNECT_TIMEOUT_SEC = 10;

/**
 * ControlPersist default, seconds: how long the background master survives with NO client
 * connections. It is an IDLE timer, not a TTL — every client connection resets it — so a
 * live session keeps the mux alive indefinitely while a crashed openhammer leaves at most
 * this much master behind. `sshCloseMux()` is the deliberate early kill at session close;
 * this expiry is only the backstop for whoever forgets to call it.
 */
export const SSH_CONTROL_PERSIST_SEC = 600;

/** Per-pipe diagnostic tail kept on every sshExec resolution (the qemu STDERR_TAIL_BYTES precedent). */
export const SSH_TAIL_BYTES = 4096;

/** Where an ssh command goes: one QEMU guest, by loopback port, pinned key, and session mux socket. */
export interface SshTarget {
	/** The guest user (the manifest's guestUser — never the host user's name). */
	readonly user: string;
	/**
	 * FIXED loopback: QEMU slirp hostfwd binds 127.0.0.1 ONLY (qemu/args.ts's
	 * `hostfwd=tcp:127.0.0.1:0-:22`), so the transport's target is always loopback — the
	 * literal type makes "point this at another host" a compile error instead of a config
	 * accident.
	 */
	readonly host: "127.0.0.1";
	/** The slirp-assigned ephemeral host port, learned via QMP `info usernet` (spec 24). */
	readonly port: number;
	/** The host-minted ed25519 private key (spec 26 provisions it; 0600). */
	readonly keyPath: string;
	/**
	 * The per-session known_hosts carrying the PINNED host key, entry shape
	 * `[127.0.0.1]:<port>` (OpenSSH's non-default-port form). A missing file fails the
	 * connection — the safe direction; see the module header.
	 */
	readonly knownHostsPath: string;
	/**
	 * The ControlMaster socket (session.ts's cmSockPath): a fixed per-session path with no
	 * %h/%r/%p tokens, so exactly one master exists per session and nothing can share it.
	 */
	readonly controlPath: string;
	/** ControlPersist seconds (default {@link SSH_CONTROL_PERSIST_SEC}). */
	readonly controlPersistSec?: number;
}

/**
 * Quote ONE remote command argument so it arrives in the guest verbatim.
 *
 * WHY THIS LIVES HERE (and not "OpenSSH does the quoting"): ssh JOINS the trailing command
 * argv elements with spaces and ships the joined string to the remote sshd, which runs it
 * through the user's shell (`sh -c <joined>`). OpenSSH performs NO per-argument quoting on
 * that join — an element with spaces, quotes, `$()`, backticks, or newlines would otherwise
 * arrive split and/or re-evaluated. The host-side spawn is a plain arg array (host-shell
 * injection already impossible); remoteQuote closes the remote-shell half. Per-argument
 * safety is THIS layer's job.
 *
 * The scheme is the standard POSIX single-quote escaper: wrap in `'…'`, and emit any
 * embedded `'` as `'\''` (close the quote, an escaped quote, reopen). Everything between the
 * wraps is literal to POSIX sh — spaces, `"`, `$()`, backticks, newlines, leading `-`,
 * unicode, all verbatim. The empty string maps to `''` (a quoted empty word — a real
 * argument, not a dropped one).
 *
 * Verified, not trusted: 25b's hostile-input round-trips assert guest-side arrival of every
 * hostile shape through a stub ssh; this module's own tests additionally re-evaluate the
 * output through a real `/bin/sh -c` locally.
 */
export function remoteQuote(arg: string): string {
	return `'${arg.replaceAll("'", `'\\''`)}'`;
}

// The shared option tail (everything after the binary): one `-o` pair per knob, each key
// exactly once, `-p` port last. `-i` is deliberately absent — it is the same knob as
// `-o IdentityFile=` and spelling it twice would add the key to the identity list twice.
function sshOptionArgv(target: SshTarget): string[] {
	return [
		"-F",
		"/dev/null",
		"-o",
		"BatchMode=yes",
		"-o",
		"StrictHostKeyChecking=yes",
		"-o",
		`UserKnownHostsFile=${target.knownHostsPath}`,
		"-o",
		"GlobalKnownHostsFile=/dev/null",
		"-o",
		`IdentityFile=${target.keyPath}`,
		"-o",
		"IdentitiesOnly=yes",
		"-o",
		`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`,
		"-o",
		"ControlMaster=auto",
		"-o",
		`ControlPath=${target.controlPath}`,
		"-o",
		`ControlPersist=${target.controlPersistSec ?? SSH_CONTROL_PERSIST_SEC}`,
		"-p",
		String(target.port),
	];
}

function sshDestination(target: SshTarget): string {
	return `${target.user}@${target.host}`;
}

/**
 * The pure argv prefix EVERY ssh invocation here shares (binary first, so the golden tests
 * assert the whole truth): `-F /dev/null` (no config file contributes anything — see the
 * module header), BatchMode (never prompt — unattended), the host-key PIN
 * (StrictHostKeyChecking=yes + per-session UserKnownHostsFile + GlobalKnownHostsFile=/dev/null),
 * the pinned identity (IdentityFile + IdentitiesOnly=yes, so no agent keys can leak into the
 * offer), the mux (ControlMaster=auto + ControlPath + ControlPersist — gate 7's ~20x), and
 * ConnectTimeout to bound a fresh connect. ControlMaster=auto means the FIRST connection
 * establishes the background master — that one pays ConnectTimeout and the host-key check —
 * and every later op multiplexes over the socket in single-digit ms.
 */
export function sshBaseArgv(target: SshTarget): string[] {
	return [SSH_BIN, ...sshOptionArgv(target)];
}

/**
 * The exec argv: {@link sshBaseArgv} + `--` + `<user>@127.0.0.1` + the remote command as ONE
 * pre-joined element — each argument through {@link remoteQuote}, the words joined with
 * single spaces. `--` guards the destination (it cannot start with `-` — the host type pins
 * loopback and the user is a POSIX name — but the discipline is free). The command is ONE
 * element rather than spread trailing elements because that is deterministic: ssh would join
 * trailing elements with spaces anyway (see the module header), and the quoting has already
 * happened here. An empty remoteArgv is a dev bug (a silent remote no-op) and throws.
 */
export function sshExecArgv(target: SshTarget, remoteArgv: readonly string[]): string[] {
	if (remoteArgv.length === 0) {
		throw new Error("sshExecArgv: remoteArgv must have at least one element (the guest binary)");
	}
	return [...sshBaseArgv(target), "--", sshDestination(target), remoteArgv.map(remoteQuote).join(" ")];
}

/** The read half this layer needs from a child pipe (structural: node's Readable fits). */
export interface SshReadStream {
	on(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/** The write half this layer needs (structural: node's Writable fits). */
export interface SshWriteStream {
	write(chunk: string): boolean;
	end(): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * The child-process surface sshExec/sshCloseMux drive — structural, so node's ChildProcess
 * and a test fake fit alike (the QemuChild trick). `close` (both pipes flushed) settles
 * promises; `error` carries spawn failures; the streams are optional because fakes may omit
 * the pipes they do not exercise. There is deliberately no kill surface: this layer never
 * kills anything (see the module header — the guest-side wrapper owns kills).
 */
export interface SshChild {
	readonly stdin?: SshWriteStream;
	readonly stdout?: SshReadStream;
	readonly stderr?: SshReadStream;
	on(event: "close", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
}

/** A `spawn()`-shaped seam: production spawns the real ssh; tests record argv or script stdio. */
export type SpawnSsh = (bin: string, args: readonly string[]) => SshChild;

/** The injectable seams (the qemu/process.ts injection-arg precedent: the production call shape stays clean). */
export interface SshDeps {
	/** Override the ssh spawn. Default: node:child_process, all three pipes, env inherited. */
	readonly spawn?: SpawnSsh;
}

/** sshExec's streaming options. */
export interface SshExecOptions {
	/** Written to ssh's stdin, then EOF'd. stdin is ALWAYS EOF'd (with or without a write) — a remote command must never wait on host stdin. */
	readonly stdin?: string;
	/** Merged-stream view: BOTH pipes' chunks in arrival order (runShell's onChunk contract). */
	readonly onChunk?: (chunk: Buffer) => void;
	/** This pipe only (callers parsing NDJSON-style stdout need it alone). */
	readonly onStdout?: (chunk: Buffer) => void;
	/** This pipe only. */
	readonly onStderr?: (chunk: Buffer) => void;
	/**
	 * Accepted for call-shape parity with runShell/runArgv and DELIBERATELY NOT ENFORCED
	 * here: this layer has no host-side kill (see the module header — the guest-side
	 * `timeout` wrapper is the kill story, because killing ssh does not kill the remote
	 * child). The value is 25c's to thread into the guest-side wrapper, not this spawn's.
	 */
	readonly timeoutSec?: number;
}

/** sshExec's outcome: ShellResult (exitCode, `-1` signal sentinel; timedOut is ALWAYS false here) + both pipes' bounded tails. */
export type SshExecResult = ShellResult & {
	readonly stdoutTail: string;
	readonly stderrTail: string;
};

// A bounded byte tail: concat, keep the last `bytes`. Buffer-based (not string.slice) so the
// window is exactly N bytes; a code point straddling the window edge becomes a replacement
// character at the tail's start — these are diagnostics, not payloads.
function tailSink(bytes: number): { push(chunk: Buffer): void; text(): string } {
	let buffer = Buffer.alloc(0);
	return {
		push(chunk: Buffer): void {
			buffer = Buffer.concat([buffer, chunk]).subarray(-bytes);
		},
		text(): string {
			return buffer.toString("utf8");
		},
	};
}

// All three pipes always: sshExec writes-then-EOFs stdin when there is input (and EOFs it
// regardless — the remote must never wait on host stdin), and mux control mode ignores stdin.
// No `detached`/process-group story exists here because this layer never kills anything — a
// plain child is the honest shape.
const spawnSshDefault: SpawnSsh = (bin, args): SshChild =>
	spawn(bin, [...args], { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

/**
 * Run `remoteArgv` in the guest over the mux and resolve its outcome.
 *
 * Streams: split by pipe — `onStdout`/`onStderr` see their own stream, `onChunk` sees BOTH
 * in arrival order (runShell's merged contract, so 25c can hand the bash tool one ordered
 * stream while argv-style callers parse stdout alone) — and the last {@link SSH_TAIL_BYTES}
 * of each pipe ride the resolution regardless of callbacks.
 *
 * Resolution: `{ exitCode: code ?? -1, timedOut: false }`, settled on `close` (both pipes
 * flushed — tails cannot drop trailing bytes; the runArgv precedent). `timedOut` is CONSTANT
 * false: there is no host-side kill in this layer (`opts.timeoutSec` is accepted for parity
 * and ignored — see its doc). Signal death maps to the `-1` sentinel; guest non-zero exits
 * (including 255 for connection death) resolve rather than reject — the caller judges.
 * Rejects ONLY on a spawn error (the ssh binary missing).
 */
export async function sshExec(
	target: SshTarget,
	remoteArgv: readonly string[],
	opts: SshExecOptions = {},
	deps: SshDeps = {},
): Promise<SshExecResult> {
	const doSpawn = deps.spawn ?? spawnSshDefault;
	const argv = sshExecArgv(target, remoteArgv); // argv[0] is SSH_BIN by construction
	const child = doSpawn(argv[0], argv.slice(1));
	return new Promise<SshExecResult>((resolve, reject) => {
		const stdoutTail = tailSink(SSH_TAIL_BYTES);
		const stderrTail = tailSink(SSH_TAIL_BYTES);
		const onStdout = opts.onStdout;
		const onStderr = opts.onStderr;
		const onChunk = opts.onChunk;
		let settled = false;

		child.stdout?.on("data", (chunk: Buffer) => {
			stdoutTail.push(chunk);
			if (onStdout !== undefined) onStdout(chunk);
			if (onChunk !== undefined) onChunk(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail.push(chunk);
			if (onStderr !== undefined) onStderr(chunk);
			if (onChunk !== undefined) onChunk(chunk);
		});

		// The stdin error listener goes on before the write: EPIPE from a child that died
		// before consuming stdin is stream-level noise — the child's close/error events own
		// the actual report, so this only prevents an unhandled stream 'error' crash.
		const stdin = child.stdin;
		if (stdin !== undefined) {
			stdin.on("error", () => {
				// EPIPE against an already-dead child; nothing to report here.
			});
			if (opts.stdin !== undefined) stdin.write(opts.stdin);
			stdin.end(); // ALWAYS EOF — see SshExecOptions.stdin
		}

		// `close` also fires after a spawn `error` (streams still open) — the settled guard
		// keeps the rejection authoritative, mirroring backend.ts's runArgv.
		const settle = (finish: () => void): void => {
			if (settled) return;
			settled = true;
			finish();
		};
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) =>
			settle(() => {
				resolve({
					exitCode: code ?? -1,
					timedOut: false,
					stdoutTail: stdoutTail.text(),
					stderrTail: stderrTail.text(),
				});
			}),
		);
	});
}

/**
 * Tear the ControlMaster down now: `ssh -O exit` over the same pinned option set (control
 * mode addresses the master through the ControlPath socket — no connection is made, fresh or
 * muxed, so a dead guest cannot hang this). True iff the master exited cleanly ("Exit
 * request sent.", rc 0); false when no master was running / the socket is gone (ssh exits
 * 255) — both are acceptable at session close, which is why this maps to a boolean instead
 * of throwing. Rejects only on a spawn error. Without this call the master still
 * self-terminates after the ControlPersist idle expiry — this is the early, deterministic
 * kill 25c's close() wants.
 */
export function sshCloseMux(target: SshTarget, deps: SshDeps = {}): Promise<boolean> {
	const doSpawn = deps.spawn ?? spawnSshDefault;
	const argv = [SSH_BIN, "-O", "exit", ...sshOptionArgv(target), "--", sshDestination(target)];
	const child = doSpawn(argv[0], argv.slice(1));
	return new Promise<boolean>((resolve, reject) => {
		let settled = false;
		// Drain both pipes even though nothing needs the bytes (a control reply is one short
		// line): flowing listeners guarantee EOF propagation so `close` cannot wait on a
		// paused stream.
		const drain = tailSink(SSH_TAIL_BYTES);
		child.stdout?.on("data", (chunk: Buffer) => {
			drain.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			drain.push(chunk);
		});
		const stdin = child.stdin;
		stdin?.on("error", () => {
			// EPIPE against an already-dead child; the boolean mapping owns the report.
		});
		stdin?.end(); // control mode ignores stdin; EOF it so nothing waits on this end
		const settle = (finish: () => void): void => {
			if (settled) return;
			settled = true;
			finish();
		};
		child.on("error", (error) => settle(() => reject(error)));
		child.on("close", (code) => settle(() => resolve(code === 0)));
	});
}

/**
 * `ssh` resolvable on PATH — the cloudflared/qemu optional-binary precedent
 * (isToolAvailable: presence only, no download; the caller turns `false` into its own
 * graceful message).
 */
export function sshAvailable(): boolean {
	return isToolAvailable(SSH_BIN);
}
