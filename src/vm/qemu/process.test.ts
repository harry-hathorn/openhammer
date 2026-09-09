import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { connectQmp } from "../qmp/client.ts";
import type { ConnectFn, QmpDuplex } from "../qmp/socket.ts";
import {
	assertProcessGone,
	CONNECT_ATTEMPTS,
	LADDER_STEP_MS,
	missingBinaryHint,
	QEMU_BIN,
	type QemuChild,
	type QemuExit,
	type QemuHandle,
	SOCKET_WAIT_MS,
	startQemu,
	stopQemu,
	tailText,
} from "./process.ts";

const GREETING =
	'{"QMP": {"version": {"qemu": {"micro": 0, "minor": 2, "major": 9}, "package": ""}, "capabilities": ["qmp_capabilities"]}}';

const ARGV = ["-name", "openhammer-vm-t1", "-machine", "q35"];

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A pid that is guaranteed reaped-dead: spawnSync waits for exit AND reaps before returning. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	expect(result.status).toBe(0);
	expect(result.pid).toBeGreaterThan(0);
	return result.pid;
}

/** A recording QMP duplex (24b's client.test.ts shape) that also scripts the QEMU side. */
interface FakeQmpSocket extends QmpDuplex {
	readonly written: string[];
	emitData(text: string): void;
	emitClose(): void;
	emitError(message: string): void;
}

/** How the scripted peer answers `quit`: reply-then-close, close-only (reply lost), or nothing. */
type QuitMode = "reply" | "close" | "hang";

/**
 * A QEMU stand-in on the QMP wire: every written command is answered (`qmp_capabilities`
 * with `{}`, anything else with an echo) except `quit`, whose behavior is the QuitMode.
 */
function scriptedPeer(options: { quitMode?: QuitMode; onQuit?: () => void } = {}): FakeQmpSocket {
	const quitMode = options.quitMode ?? "reply";
	const written: string[] = [];
	const dataListeners: Array<(chunk: Buffer) => void> = [];
	const closeListeners: Array<() => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	const socket: FakeQmpSocket = {
		// The single-cast implementor of the overloaded `on`: TS cannot correlate the `event`
		// union with the matching listener union, so each branch narrows by hand.
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
			const message = JSON.parse(chunk) as { execute: string; id: number };
			if (message.execute === "quit") {
				options.onQuit?.();
				if (quitMode !== "hang") {
					queueMicrotask(() => {
						if (quitMode === "reply") {
							for (const listener of dataListeners) {
								listener(Buffer.from(`{"return": {}, "id": ${message.id}}\n`, "utf8"));
							}
						}
						for (const listener of closeListeners) {
							listener();
						}
					});
				}
				return true;
			}
			const returned = message.execute === "qmp_capabilities" ? {} : { echo: message.execute };
			queueMicrotask(() => {
				for (const listener of dataListeners) {
					listener(Buffer.from(`{"return": ${JSON.stringify(returned)}, "id": ${message.id}}\n`, "utf8"));
				}
			});
			return true;
		},
		end(): void {
			// The process tests never exercise the graceful-end path; recorded shape only.
		},
		destroy(): void {
			// Same — teardown is the client's concern, asserted via isDestroyed-free fakes.
		},
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
	return socket;
}

/** The connect seam handing startQemu a scripted QEMU; `failFirst` sockets refuse (ECONNREFUSED). */
function scriptedConnect(options: { failFirst?: number } = {}): { connect: ConnectFn; peers: FakeQmpSocket[] } {
	const peers: FakeQmpSocket[] = [];
	let calls = 0;
	const failFirst = options.failFirst ?? 0;
	return {
		peers,
		connect: (): FakeQmpSocket => {
			calls += 1;
			if (calls <= failFirst) {
				const refused = scriptedPeer();
				peers.push(refused);
				queueMicrotask(() => refused.emitError(`connect ECONNREFUSED (attempt ${calls})`));
				return refused;
			}
			const peer = scriptedPeer();
			peers.push(peer);
			queueMicrotask(() => peer.emitData(`${GREETING}\n`));
			return peer;
		},
	};
}

/** A QEMU child stand-in: records kills, exits on the configured signals (default: both rungs). */
interface FakeQemuChild extends QemuChild {
	readonly signals: string[];
	readonly exited: Promise<QemuExit>;
	exitInfo(): QemuExit | undefined;
	emitExit(code: number | null, signal: string | null): void;
}

function fakeQemuChild(options: { pid?: number; diesOn?: readonly string[] } = {}): FakeQemuChild {
	const diesOn = options.diesOn ?? ["SIGTERM", "SIGKILL"];
	const signals: string[] = [];
	const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	let recorded: QemuExit | undefined;
	let settle: (exit: QemuExit) => void = () => {};
	const exited = new Promise<QemuExit>((resolve) => {
		settle = resolve;
	});
	const child: FakeQemuChild = {
		pid: options.pid,
		get exitCode(): number | null {
			return recorded?.code ?? null;
		},
		get signalCode(): string | null {
			return recorded?.signal ?? null;
		},
		on(event: "exit" | "error", listener: (...args: never[]) => void): unknown {
			if (event === "exit") {
				exitListeners.push(listener as (code: number | null, signal: string | null) => void);
			} else {
				errorListeners.push(listener as (error: Error) => void);
			}
			return undefined;
		},
		kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
			const name = typeof signal === "string" ? signal : `signal-${signal}`;
			signals.push(name);
			if (diesOn.includes(name)) {
				child.emitExit(null, name);
			}
			return true;
		},
		signals,
		exited,
		exitInfo: (): QemuExit | undefined => recorded,
		emitExit(code: number | null, signal: string | null): void {
			const info: QemuExit = { code, signal };
			recorded = info;
			for (const listener of exitListeners) {
				listener(code, signal);
			}
			settle(info);
		},
	};
	return child;
}

/** A full handle around a fake child + a real QmpClient on a scripted peer — the stop-ladder fixture. */
async function stopFixture(options: {
	quitMode?: QuitMode;
	onQuit?: () => void;
	child?: FakeQemuChild;
}): Promise<{ handle: QemuHandle; child: FakeQemuChild; peer: FakeQmpSocket }> {
	const child = options.child ?? fakeQemuChild({ pid: deadPid() });
	const peer = scriptedPeer({ quitMode: options.quitMode, onQuit: options.onQuit });
	const qmp = await connectQmp("/run/qmp.sock", {
		connect: () => {
			queueMicrotask(() => peer.emitData(`${GREETING}\n`));
			return peer;
		},
		handshakeMs: 250,
		commandTimeoutMs: 40,
	});
	const handle: QemuHandle = {
		pid: child.pid ?? deadPid(),
		qmp,
		exited: child.exited,
		exitInfo: (): QemuExit | undefined => child.exitInfo(),
		kill: (signal?: NodeJS.Signals | number): boolean => child.kill(signal),
		stderrTail: async () => "",
	};
	return { handle, child, peer };
}

describe("startQemu", () => {
	it("spawns QEMU_BIN with the argv and stderr wiring, waits out the socket, and connects", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const stderrPath = join(dir, "qemu.stderr");
		writeFileSync(stderrPath, `${"x".repeat(6000)}THE-STDERR-TAIL`);
		const child = fakeQemuChild({ pid: 424242 });
		const spawnCalls: Array<{ bin: string; args: string[]; stderrPath: string }> = [];
		let polls = 0;
		const { connect, peers } = scriptedConnect();
		const handle = await startQemu(
			ARGV,
			{ sessionDir: dir, stderrPath },
			{
				spawn: (bin, args, stderrFile): QemuChild => {
					spawnCalls.push({ bin, args: [...args], stderrPath: stderrFile });
					return child;
				},
				connect,
				sleep: async () => {},
				fileExists: () => {
					polls += 1;
					return polls >= 3;
				},
			},
		);
		expect(spawnCalls).toEqual([{ bin: QEMU_BIN, args: ARGV, stderrPath }]);
		expect(polls).toBe(3); // the socket appeared on the third poll, not instantly
		expect(handle.pid).toBe(424242);
		expect(handle.qmp.greetingLine).toBe(GREETING);
		expect(handle.qmp.capabilitiesReturn).toEqual({});
		// The client is live through the handle: ids continue past the handshake's 1.
		const status = handle.qmp.execute("query-status");
		await tick();
		expect(peers[0]?.written.at(-1)).toContain('"query-status"');
		expect(await status).toEqual({ echo: "query-status" });
		// exited resolves once with the recorded evidence; exitInfo reports it too.
		let resolved: QemuExit | undefined;
		void handle.exited.then((exit) => {
			resolved = exit;
		});
		child.emitExit(0, null);
		await tick();
		expect(resolved).toEqual({ code: 0, signal: null });
		expect(handle.exitInfo()).toEqual({ code: 0, signal: null });
		// The stderr ring buffer: the file keeps everything, the tail keeps 4 KiB.
		const tail = await handle.stderrTail();
		expect(tail.length).toBe(4096);
		expect(tail.endsWith("THE-STDERR-TAIL")).toBe(true);
	});

	it("rejects with the stderr tail when the child exits before the socket appears (boot.ts race)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const stderrPath = join(dir, "qemu.stderr");
		writeFileSync(stderrPath, "qemu: -machine bogus-machine: invalid machine type");
		const child = fakeQemuChild({ pid: 424243 });
		child.emitExit(1, null); // dead before any listener could attach — the fields carry it
		const pending = startQemu(
			ARGV,
			{ sessionDir: dir, stderrPath, socketWaitMs: 5_000 },
			{
				spawn: () => child,
				connect: scriptedConnect().connect,
				sleep: async () => {},
				fileExists: () => false,
			},
		);
		await expect(pending).rejects.toThrow(
			"qemu: exited before the QMP socket appeared (exitCode=1 signalCode=null); stderr: qemu: -machine bogus-machine: invalid machine type",
		);
		expect(child.signals).toEqual([]); // already dead — no teardown rungs needed
	});

	it("rejects on the socket budget and does not leak the still-live child (SIGTERM ladder tail)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const stderrPath = join(dir, "qemu.stderr");
		const child = fakeQemuChild({ pid: 424243 }); // default: dies on SIGTERM
		const pending = startQemu(
			ARGV,
			{ sessionDir: dir, stderrPath, socketWaitMs: 30 },
			{ spawn: () => child, connect: scriptedConnect().connect, sleep: async () => {}, fileExists: () => false },
		);
		await expect(pending).rejects.toThrow(`qemu: no QMP socket at ${join(dir, "qmp.sock")} within 30 ms`);
		expect(child.signals).toEqual(["SIGTERM"]);
	});

	it("retries the connect across the socket-exists-but-not-listening-yet race", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const child = fakeQemuChild({ pid: 424243 });
		const { connect, peers } = scriptedConnect({ failFirst: 2 });
		const handle = await startQemu(
			ARGV,
			{ sessionDir: dir, stderrPath: join(dir, "qemu.stderr") },
			{
				spawn: () => child,
				connect,
				sleep: async () => {},
				fileExists: () => true,
			},
		);
		expect(peers.length).toBe(3); // two refused, third greeted
		expect(handle.qmp.greetingLine).toBe(GREETING);
	});

	it("rejects (and tears the child down) when every connect attempt fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const child = fakeQemuChild({ pid: 424243 });
		const pending = startQemu(
			ARGV,
			{ sessionDir: dir, stderrPath: join(dir, "qemu.stderr") },
			{
				spawn: () => child,
				connect: scriptedConnect({ failFirst: CONNECT_ATTEMPTS + 5 }).connect,
				sleep: async () => {},
				fileExists: () => true,
			},
		);
		await expect(pending).rejects.toThrow(
			`qemu: QMP connect failed after ${CONNECT_ATTEMPTS} attempts: qmp: handshake failed: socket error: connect ECONNREFUSED (attempt 5)`,
		);
		expect(child.signals).toEqual(["SIGTERM"]);
	});

	it("rejects immediately when spawn yields no pid (the ENOENT shape), with the install hint", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const child = fakeQemuChild({ pid: undefined });
		await expect(
			startQemu(ARGV, { sessionDir: dir, stderrPath: join(dir, "qemu.stderr") }, { spawn: () => child }),
		).rejects.toThrow(`qemu: spawn ${QEMU_BIN} failed (no pid) — ${missingBinaryHint(QEMU_BIN)}`);
	});
});

describe("stopQemu — the ladder", () => {
	it("quit path: the reply arrives, QEMU exits, no signal rungs fire", async () => {
		const child = fakeQemuChild({ pid: deadPid() });
		const { handle, peer } = await stopFixture({
			quitMode: "reply",
			onQuit: () => child.emitExit(0, null),
			child,
		});
		const outcome = await stopQemu(handle, { stepMs: 100 });
		expect(outcome).toEqual({ path: "quit", detail: "quit sent; exitCode=0 signalCode=null" });
		expect(child.signals).toEqual([]);
		expect(peer.written.some((frame) => frame.includes('"quit"'))).toBe(true);
	});

	it("quit reply lost to the socket close is tolerated — the observed exit still decides", async () => {
		const child = fakeQemuChild({ pid: deadPid() });
		const { handle } = await stopFixture({
			quitMode: "close",
			onQuit: () => child.emitExit(0, null),
			child,
		});
		const outcome = await stopQemu(handle, { stepMs: 100 });
		expect(outcome.path).toBe("quit");
		expect(outcome.detail).toContain("reply lost to close, expected: qmp: closed (socket closed)");
		expect(child.signals).toEqual([]);
	});

	it("already-exited: short-circuits with the evidence, no quit and no signals", async () => {
		const child = fakeQemuChild({ pid: deadPid() });
		const { handle, peer } = await stopFixture({ child });
		child.emitExit(137, "SIGKILL");
		const outcome = await stopQemu(handle, { stepMs: 100 });
		expect(outcome).toEqual({ path: "already-exited", detail: "exitCode=137 signalCode=SIGKILL" });
		expect(child.signals).toEqual([]);
		expect(peer.written.some((frame) => frame.includes('"quit"'))).toBe(false);
	});

	it("quit fails (wedged guest) → SIGTERM ends it", async () => {
		const child = fakeQemuChild({ pid: deadPid(), diesOn: ["SIGTERM", "SIGKILL"] });
		const { handle } = await stopFixture({ quitMode: "hang", child });
		const outcome = await stopQemu(handle, { stepMs: 100 });
		expect(outcome).toEqual({ path: "sigterm", detail: "exitCode=null signalCode=SIGTERM" });
		expect(child.signals).toEqual(["SIGTERM"]);
	});

	it("SIGTERM fails → SIGKILL ends it", async () => {
		const child = fakeQemuChild({ pid: deadPid(), diesOn: ["SIGKILL"] });
		const { handle } = await stopFixture({ quitMode: "hang", child });
		const outcome = await stopQemu(handle, { stepMs: 100 });
		expect(outcome).toEqual({ path: "sigkill", detail: "exitCode=null signalCode=SIGKILL" });
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});

	it("a pid that survives even SIGKILL throws", async () => {
		const child = fakeQemuChild({ pid: 424242, diesOn: [] });
		const { handle } = await stopFixture({ quitMode: "hang", child });
		await expect(stopQemu(handle, { stepMs: 15 })).rejects.toThrow("qemu pid 424242 survived SIGKILL");
		expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
	});
});

describe("assertProcessGone", () => {
	it("throws for a still-signalable pid (ours — signal 0 only probes)", () => {
		expect(() => assertProcessGone(process.pid)).toThrow(
			`qemu pid ${process.pid} is still signalable after the stop ladder`,
		);
	});

	it("passes for a reaped-dead pid (ESRCH)", () => {
		expect(() => assertProcessGone(deadPid())).not.toThrow();
	});
});

describe("binary presence + budgets", () => {
	it("missingBinaryHint names the binary and the one Arch install line", () => {
		expect(missingBinaryHint(QEMU_BIN)).toBe(
			`${QEMU_BIN} is not on PATH — install the VM stack (Arch: sudo pacman -S qemu-desktop qemu-img edk2)`,
		);
	});

	it("publishes the production budgets (the spike's numbers)", () => {
		expect(SOCKET_WAIT_MS).toBe(15_000);
		expect(CONNECT_ATTEMPTS).toBe(5);
		expect(LADDER_STEP_MS).toBe(5_000);
	});

	// qemuAvailable()/qemuImgAvailable() are deliberately untested here: they run the real
	// binary's --version, so their result depends on the host (the cloudflared precedent —
	// src/tunnel tests likewise never spawn the real binary).
});

describe("tailText", () => {
	it("returns the last N bytes of a file, and empty for missing/empty files", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-qemu-"));
		const path = join(dir, "growing.log");
		writeFileSync(path, `${"a".repeat(100)}THE-END`);
		expect(await tailText(path, 7)).toBe("THE-END");
		expect(await tailText(path, 1_000)).toBe(`${"a".repeat(100)}THE-END`);
		expect(await tailText(join(dir, "absent.log"), 10)).toBe("");
	});
});
