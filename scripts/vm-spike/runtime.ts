// Shared runner helpers for the spike scripts (boot/install/matrix): everything every
// QEMU-runner needs — sleepy polling, the QMP reconnect wrapper, the stop ladder, and the
// slirp/ssh patterns 22a/22b validated (`parseUsernetHostPort`, the ssh round-trip
// primitives). Extracted verbatim from boot.ts/install.ts when matrix.ts became the third
// consumer, so the runners reuse one copy instead of forking it per script.
import type { ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { type RunOptions, type RunResult, run } from "./proc.ts";
import { connectQmp, type QmpClient } from "./qmp.ts";

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function statusState(returned: unknown): string {
	if (isRecord(returned) && typeof returned.status === "string") {
		return returned.status;
	}
	return `unexpected return: ${JSON.stringify(returned)}`;
}

export async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (statSync(path, { throwIfNoEntry: false }) !== undefined) {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await sleep(100);
	}
}

// The socket file can appear a beat before QEMU finishes listening — retry the connect.
export async function connectQmpWithRetry(socketPath: string, attempts: number): Promise<QmpClient> {
	let lastError: unknown = new Error("connectQmpWithRetry: no attempts");
	for (let attempt = 0; attempt < attempts; attempt++) {
		try {
			return await connectQmp(socketPath);
		} catch (error) {
			lastError = error;
		}
		await sleep(500);
	}
	return Promise.reject(lastError instanceof Error ? lastError : new Error(String(lastError)));
}

export function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

export function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (hasExited(child)) {
		return Promise.resolve(true);
	}
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => {
			child.removeListener("exit", onExit);
			resolve(false);
		}, timeoutMs);
		const onExit = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

export type LadderPath = "quit" | "sigterm" | "sigkill" | "already-exited" | "guest-poweroff";

export interface LadderResult {
	readonly path: LadderPath;
	readonly detail: string;
}

export const LADDER_STEP_MS = 5_000;

// The stop ladder (ported from Oligarchy's process.ts shape): QMP quit → wait ≤5 s →
// SIGTERM → wait 5 s → SIGKILL → wait. The quit reply routinely races the socket teardown,
// so only the observed exit decides the path.
export async function shutdownLadder(child: ChildProcess, qmp: QmpClient | undefined): Promise<LadderResult> {
	const describe = (): string => `exitCode=${child.exitCode} signalCode=${child.signalCode}`;
	if (hasExited(child)) {
		return { path: "already-exited", detail: describe() };
	}
	let quitNote = "quit sent";
	if (qmp !== undefined) {
		try {
			await qmp.execute("quit");
		} catch (error) {
			quitNote = `quit sent (reply lost to close, expected: ${error instanceof Error ? error.message : String(error)})`;
		}
	}
	if (await waitForExit(child, LADDER_STEP_MS)) {
		return { path: "quit", detail: `${quitNote}; ${describe()}` };
	}
	child.kill("SIGTERM");
	if (await waitForExit(child, LADDER_STEP_MS)) {
		return { path: "sigterm", detail: describe() };
	}
	child.kill("SIGKILL");
	if (await waitForExit(child, LADDER_STEP_MS)) {
		return { path: "sigkill", detail: describe() };
	}
	throw new Error(`qemu pid ${child.pid ?? "?"} survived SIGKILL`);
}

// Belt-and-braces after the ladder: a reaped child is un signalable; a killable pid is a leak.
export function assertProcessGone(child: ChildProcess): void {
	const pid = child.pid;
	if (pid === undefined) {
		return;
	}
	try {
		process.kill(pid, 0);
	} catch {
		return; // ESRCH — gone, as required
	}
	throw new Error(`qemu pid ${pid} is still signalable after the stop ladder`);
}

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

/**
 * Parse the `info usernet` table for the slirp hostfwd row. Probe-verified shape on this
 * host's QEMU 11.1 (one row per hostfwd, whitespace-run separated):
 * `  TCP[HOST_FORWARD]  14  127.0.0.1 43423  10.0.2.15 22  0 0`
 * tokens: proto[state] fd srcAddr srcPort dstAddr dstPort recvq sendq — the host port we
 * dial is srcPort on the row whose guest port is 22.
 */
export function parseUsernetHostPort(table: string): { row: string; port: number } | undefined {
	for (const line of table.split(/\r?\n/)) {
		const tokens = line.trim().split(/\s+/);
		if (tokens[0] !== "TCP[HOST_FORWARD]" || tokens.length < 6) {
			continue;
		}
		const sourceAddress = tokens[2];
		const sourcePort = tokens[3];
		const destinationPort = tokens[5];
		const port = Number(sourcePort);
		if (sourceAddress === "127.0.0.1" && destinationPort === "22" && Number.isInteger(port) && port > 0) {
			return { row: line.trim(), port };
		}
	}
	return undefined;
}

// The one shape every runner uses to reach the guest: ssh with the spike key, ephemeral
// slirp port, strict-host-key off (throwaway VMs), batch mode (no password prompts), and
// the remote command as the LAST argv element — `run` never interpolates a shell string.
export function sshRun(
	user: string,
	port: number,
	keyPath: string,
	command: string,
	options: RunOptions = {},
): Promise<RunResult> {
	return run(
		"ssh",
		[
			"-i",
			keyPath,
			"-p",
			String(port),
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"ConnectTimeout=5",
			"-o",
			"BatchMode=yes",
			`${user}@127.0.0.1`,
			command,
		],
		options,
	);
}

// The 22b gate primitive: a `true` that round-trips the full sshd path.
export async function sshExecTrue(user: string, port: number, keyPath: string): Promise<boolean> {
	const result = await sshRun(user, port, keyPath, "true");
	return result.code === 0;
}
