// QEMU process lifecycle — spec 24's src/vm/qemu/process.ts. The promotion point for the
// spec-22 spike's proven process wiring: the stop ladder, waitForExit and assertProcessGone
// are scripts/vm-spike/runtime.ts ported (same rungs, same tolerances); the spawn sequence
// (stderr to the session file, socket wait, exited-before-connect race, connect retry) is
// scripts/vm-spike/boot.ts's, with one deliberate improvement: the socket wait polls for
// the child's exit too, so a QEMU that dies at startup reports in milliseconds instead of
// burning the full 15 s budget before noticing.
//
// THE STOP-SEQUENCING CONTRACT (22-measured finding 2 — the corrupt-golden lesson): a bare
// ladder on a guest whose disks are MOUNTED corrupts filesystem state. The first golden
// image, torn down through QMP `quit` with btrfs mounted rw, never reached ssh readiness on
// any later overlay boot; its replacement, always shut down via a clean guest
// `systemctl poweroff`, booted 5/5. `stopQemu` is therefore the FORCED fallback — never the
// first shutdown move. The service layer above (spec 27) owns the sequencing: clean guest
// poweroff first whenever anything may be mounted; this ladder only at the LUKS prompt
// (nothing mounted yet), on an unresponsive guest, or after the poweroff budget expires.
// There is deliberately no `alreadyClean` hint on stopQemu — the process layer cannot know
// what the guest has mounted, and pushing that decision down would only hide it.
//
// Error model: process layer, not a tool. Failures REJECT, and every rejection carries the
// 4 KiB stderr tail — the spike's `run`/ShellResult philosophy (the runner resolves code +
// tails; its one caller converts a non-zero code into a throw that embeds the tail). Spec
// 27's service is the boundary that folds these rejections into the Result spine.
import { spawn } from "node:child_process";
import { closeSync, openSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { isToolAvailable } from "../../tools/bin.ts";
import { connectQmp, type QmpClient } from "../qmp/client.ts";
import type { ConnectFn } from "../qmp/socket.ts";

/**
 * The system binary this layer spawns. args.ts deliberately emits flags only ("the binary
 * is the spawner's concern") — the spawner is here, so the name lives here.
 */
export const QEMU_BIN = "qemu-system-x86_64";

/** The image tool the session layer drives (overlay create; `qemu-img info` is spec 27's doctor). */
export const QEMU_IMG_BIN = "qemu-img";

/** Budget for the QMP socket file to appear after spawn (the spike's boot.ts 15 s). */
export const SOCKET_WAIT_MS = 15_000;
const SOCKET_POLL_MS = 100;

/** Connect attempts covering the socket-exists-but-not-listening-yet race (the spike: 5 × 500 ms). */
export const CONNECT_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 500;

/** One rung of the stop ladder (the spike runtime.ts LADDER_STEP_MS). */
export const LADDER_STEP_MS = 5_000;

/**
 * The stderr ring buffer size: the stderr FILE keeps everything (it is a session artifact);
 * `stderrTail()` hands back only this many trailing bytes.
 */
const STDERR_TAIL_BYTES = 4096;

/**
 * `qemu-system-x86_64` resolvable on PATH and healthy (`--version` exits 0) — the
 * `cloudflared` optional-binary precedent (src/tools/bin.ts `isToolAvailable`): presence
 * only, no download, and the caller turns `false` into its own graceful message.
 */
export function qemuAvailable(): boolean {
	return isToolAvailable(QEMU_BIN);
}

/** `qemu-img` on PATH — same check, same caller-owned error handling. */
export function qemuImgAvailable(): boolean {
	return isToolAvailable(QEMU_IMG_BIN);
}

/**
 * The one shared "binary missing" line (the tunnel precedent keeps actionable copy with
 * callers — doctor warns, boot notices; the difference here is TWO binaries plus the OVMF
 * images form ONE install, so this string is shared to keep doctor and spec 27's preflight
 * from drifting apart). The packages are the Arch target's (the VM sandbox host).
 */
export function missingBinaryHint(bin: string): string {
	return `${bin} is not on PATH — install the VM stack (Arch: sudo pacman -S qemu-desktop qemu-img edk2)`;
}

/**
 * The child-process surface this module drives — structural, so node's ChildProcess and a
 * test fake fit alike (the QmpDuplex trick from qmp/socket.ts). Only what the lifecycle
 * needs: the pid, the exit evidence, the error event (a spawn ENOENT arrives there), and
 * the kill rung.
 */
export interface QemuChild {
	readonly pid?: number;
	readonly exitCode: number | null;
	readonly signalCode: string | null;
	on(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals | number): boolean;
}

/** A `spawn()`-shaped seam: production opens stderr to the file and hands back the child; tests fake it. */
export type SpawnQemu = (bin: string, args: readonly string[], stderrPath: string) => QemuChild;

/** Injectable sleeps — tests tick instantly instead of waiting out the poll/retry budgets. */
export type SleepFn = (ms: number) => Promise<void>;

/** Injectable file-presence check — the socket wait polls this (default: a real stat). */
export type FileExistsFn = (path: string) => boolean;

/** The injectable seams (the `11a`/`13` injection-arg precedent: the production call shape stays clean). */
export interface QemuProcessDeps {
	/** Override the QEMU spawn (tests inject a fake child). Default: node:child_process, stderr → file. */
	readonly spawn?: SpawnQemu;
	/** Override the QMP socket connect (tests inject a scripted duplex). Default: qmp/socket.ts's unix connect. */
	readonly connect?: ConnectFn;
	/** Override every sleep this layer takes (tests: instant). Default: real setTimeout. */
	readonly sleep?: SleepFn;
	/** Override the socket-file existence probe (tests: deterministic appearance). Default: real stat. */
	readonly fileExists?: FileExistsFn;
}

/** What `exited` resolves with — exactly one of code/signal is non-null, Node's shape. */
export interface QemuExit {
	readonly code: number | null;
	readonly signal: string | null;
}

/** A live QEMU: the process, its QMP client, and the evidence surfaces. */
export interface QemuHandle {
	readonly pid: number;
	readonly qmp: QmpClient;
	/** Resolves once when the process exits (also on a spawn error, so no waiter can hang). Never rejects. */
	readonly exited: Promise<QemuExit>;
	/** The recorded exit, once it happened (`undefined` while running) — the ladder's evidence. */
	exitInfo(): QemuExit | undefined;
	/** Send a signal (the ladder's rungs); no signal = SIGTERM, Node's default. */
	kill(signal?: NodeJS.Signals | number): boolean;
	/** The last 4 KiB of the stderr file — the evidence half of every failure message here. */
	stderrTail(): Promise<string>;
}

export interface StartQemuOptions {
	/** All per-session artifacts live here; the QMP socket defaults to `<sessionDir>/qmp.sock`. */
	readonly sessionDir: string;
	/** QEMU stderr is redirected to this file (the whole file is kept; `stderrTail()` reads the end). */
	readonly stderrPath: string;
	/** QMP socket path to wait for and connect (default `<sessionDir>/qmp.sock`, matching qemuBootArgs). */
	readonly qmpSockPath?: string;
	/** Budget for the socket to appear (default SOCKET_WAIT_MS; tests pass milliseconds). */
	readonly socketWaitMs?: number;
}

export interface StopQemuOptions {
	/** Per-rung exit wait (default LADDER_STEP_MS; tests pass milliseconds). */
	readonly stepMs?: number;
}

/** Which rung ended the process. The service layer logs this; capture.ts keys off non-clean paths. */
export type StopPath = "quit" | "sigterm" | "sigkill" | "already-exited";

export interface StopOutcome {
	readonly path: StopPath;
	readonly detail: string;
}

const sleep: SleepFn = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const fileExistsDefault: FileExistsFn = (path: string): boolean =>
	statSync(path, { throwIfNoEntry: false }) !== undefined;

// The spike's boot.ts spawn wiring, verbatim in shape: stderr → an fd on the session file,
// the parent's fd closed right after (the child holds its own dup).
const spawnQemuDefault: SpawnQemu = (bin: string, args: readonly string[], stderrPath: string): QemuChild => {
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(bin, [...args], { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	return child;
};

/**
 * Spawn `qemu-system-x86_64` and come back only once the QMP client is connected: wait for
 * the socket file (bounded), surviving the exited-before-connect race (a child that dies
 * first rejects immediately with the stderr tail — the spike's boot.ts pattern), then
 * connect with {@link CONNECT_ATTEMPTS} retries (the socket file can exist a beat before
 * QEMU listens). A start that fails after spawn never leaks the child: the error path runs
 * a bare SIGTERM→SIGKILL ladder before rejecting.
 */
export async function startQemu(
	argv: readonly string[],
	opts: StartQemuOptions,
	deps: QemuProcessDeps = {},
): Promise<QemuHandle> {
	const doSpawn = deps.spawn ?? spawnQemuDefault;
	const sleepFn = deps.sleep ?? sleep;
	const exists = deps.fileExists ?? fileExistsDefault;
	const socketPath = opts.qmpSockPath ?? join(opts.sessionDir, "qmp.sock");
	const socketWaitMs = opts.socketWaitMs ?? SOCKET_WAIT_MS;

	const child = doSpawn(QEMU_BIN, argv, opts.stderrPath);
	// Listeners before the pid check: a spawn ENOENT emits "error" asynchronously, and an
	// unhandled error event would crash the process. The error settles `exited` (with the
	// null/null sentinel) instead of rejecting it, so no waiter can ever hang.
	let exitInfoValue: QemuExit | undefined;
	const exited = new Promise<QemuExit>((resolveExit) => {
		child.on("exit", (code, signal) => {
			exitInfoValue = { code, signal };
			resolveExit(exitInfoValue);
		});
		child.on("error", () => {
			exitInfoValue = { code: null, signal: null };
			resolveExit(exitInfoValue);
		});
	});
	if (child.pid === undefined) {
		throw new Error(`qemu: spawn ${QEMU_BIN} failed (no pid) — ${missingBinaryHint(QEMU_BIN)}`);
	}
	const stderrTail = (): Promise<string> => tailText(opts.stderrPath, STDERR_TAIL_BYTES);
	// The exit as observable NOW: through the listener, or — for a child that died before
	// the listener attached — through the exitCode/signalCode fields (the spike's hasExited:
	// Node does not replay a missed "exit" event, but the fields stay set).
	const observedExit = (): QemuExit | undefined => {
		if (exitInfoValue !== undefined) {
			return exitInfoValue;
		}
		if (child.exitCode !== null || child.signalCode !== null) {
			return { code: child.exitCode, signal: child.signalCode };
		}
		return undefined;
	};

	// Wait for the socket, noticing a dead child on the same poll instead of after the budget.
	const deadline = Date.now() + socketWaitMs;
	let socketAppeared = false;
	for (;;) {
		if (exists(socketPath)) {
			socketAppeared = true;
			break;
		}
		if (observedExit() !== undefined || Date.now() >= deadline) {
			break;
		}
		await sleepFn(SOCKET_POLL_MS);
	}
	if (!socketAppeared) {
		const exit = observedExit();
		const why =
			exit !== undefined
				? `exited before the QMP socket appeared (exitCode=${exit.code} signalCode=${exit.signal})`
				: `no QMP socket at ${socketPath} within ${socketWaitMs} ms`;
		await abandonQemu(exited, child, observedExit);
		throw new Error(`qemu: ${why}; stderr: ${await stderrTail()}`);
	}

	let qmp: QmpClient;
	try {
		qmp = await connectQmpWithRetry(socketPath, deps);
	} catch (error) {
		await abandonQemu(exited, child, observedExit);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`qemu: QMP connect failed after ${CONNECT_ATTEMPTS} attempts: ${message}; stderr: ${await stderrTail()}`,
		);
	}
	return {
		pid: child.pid,
		qmp,
		exited,
		exitInfo: observedExit,
		kill: (signal?: NodeJS.Signals | number): boolean => child.kill(signal),
		stderrTail,
	};
}

/**
 * The stop ladder, verbatim from the spike's runtime.ts shutdownLadder (minus its optional
 * `guest-poweroff` path — that is the service layer's sequencing, see the module header):
 * QMP `quit` (the reply routinely races the socket teardown as QEMU exits, so a lost reply
 * is tolerated — only the observed exit decides the path) → ≤ stepMs → SIGTERM → ≤ stepMs →
 * SIGKILL → throw if it survived even that. `assertProcessGone` runs after every successful
 * rung (a reaped child is unsignalable; a killable pid is a leak). The QMP client is left
 * as-is: QEMU's exit closes the socket, which fails any in-flight command (24b's close
 * detection) — callers may await `handle.qmp.closed` after the ladder.
 */
export async function stopQemu(handle: QemuHandle, opts: StopQemuOptions = {}): Promise<StopOutcome> {
	const stepMs = opts.stepMs ?? LADDER_STEP_MS;
	const describe = (): string => {
		const info = handle.exitInfo();
		return `exitCode=${info?.code ?? "null"} signalCode=${info?.signal ?? "null"}`;
	};
	if (handle.exitInfo() !== undefined) {
		return { path: "already-exited", detail: describe() };
	}
	let quitNote = "quit sent";
	try {
		await handle.qmp.execute("quit");
	} catch (error) {
		quitNote = `quit sent (reply lost to close, expected: ${error instanceof Error ? error.message : String(error)})`;
	}
	if (await waitForExit(handle.exited, stepMs)) {
		assertProcessGone(handle.pid);
		return { path: "quit", detail: `${quitNote}; ${describe()}` };
	}
	handle.kill("SIGTERM");
	if (await waitForExit(handle.exited, stepMs)) {
		assertProcessGone(handle.pid);
		return { path: "sigterm", detail: describe() };
	}
	handle.kill("SIGKILL");
	if (await waitForExit(handle.exited, stepMs)) {
		assertProcessGone(handle.pid);
		return { path: "sigkill", detail: describe() };
	}
	throw new Error(`qemu pid ${handle.pid} survived SIGKILL`);
}

/**
 * Belt-and-braces after the ladder (the spike's runtime.ts): signal 0 probes existence —
 * ESRCH means gone as required; a still-signalable pid means the process leaked and every
 * caller of this deserves to know immediately.
 */
export function assertProcessGone(pid: number): void {
	try {
		process.kill(pid, 0);
	} catch {
		return; // ESRCH — gone, as required
	}
	throw new Error(`qemu pid ${pid} is still signalable after the stop ladder`);
}

// The socket file can appear a beat before QEMU finishes listening — retry the connect
// (the spike's runtime.ts connectQmpWithRetry, same count, same delay).
async function connectQmpWithRetry(socketPath: string, deps: QemuProcessDeps): Promise<QmpClient> {
	const sleepFn = deps.sleep ?? sleep;
	let lastError: unknown = new Error("connectQmpWithRetry: no attempts");
	for (let attempt = 0; attempt < CONNECT_ATTEMPTS; attempt++) {
		try {
			return await connectQmp(socketPath, { connect: deps.connect });
		} catch (error) {
			lastError = error;
		}
		await sleepFn(CONNECT_RETRY_DELAY_MS);
	}
	return Promise.reject(lastError instanceof Error ? lastError : new Error(String(lastError)));
}

// The failed-start cleanup: no QMP client exists to `quit` through, so this is the bare
// SIGTERM → SIGKILL tail of the ladder. Best-effort by design — the rejection that follows
// is the real report; this just guarantees no live QEMU outlives a failed start. An
// already-dead child is left un-signaled (killing a reaped pid is noise at best).
async function abandonQemu(
	exited: Promise<QemuExit>,
	child: QemuChild,
	observed: () => QemuExit | undefined,
): Promise<void> {
	if (observed() !== undefined) {
		return;
	}
	child.kill("SIGTERM");
	if (await waitForExit(exited, LADDER_STEP_MS)) {
		return;
	}
	child.kill("SIGKILL");
	await waitForExit(exited, LADDER_STEP_MS);
}

// The spike's runtime.ts waitForExit on a settled-able promise: true once it resolves,
// false on the timeout. An already-settled promise wins the race on a microtask.
function waitForExit(exited: Promise<QemuExit>, timeoutMs: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		void exited.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** The last `bytes` of a file (utf8) — the spike's runtime.ts tailText, the tail primitive (also capture.ts's). */
export async function tailText(path: string, bytes: number): Promise<string> {
	const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
	if (size === 0) {
		return "";
	}
	const length = Math.min(size, bytes);
	const buffer = Buffer.alloc(length);
	const handle = await open(path, "r");
	try {
		await handle.read(buffer, 0, length, size - length);
	} finally {
		await handle.close();
	}
	return buffer.toString("utf8");
}
