// Boot runner: `npx tsx scripts/vm-spike/boot.ts --config gl|headless [--hold-seconds 90]`
// Boots the pinned live ISO under one display config, asserts QMP liveness for the hold
// window, then shuts QEMU down with the stop ladder and appends a run log under <SPIKE_DIR>/runs/.
import { type ChildProcess, spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { DISK_SIZE, type DisplayConfig, isDisplayConfig, OVMF_VARS, QEMU_BIN, QEMU_IMG, qemuArgs } from "./args.ts";
import { ensureIso } from "./iso.ts";
import { run } from "./proc.ts";
import { connectQmp, type QmpClient } from "./qmp.ts";
import { ISO_URL, openSpikeDirs } from "./scratch.ts";

const SAMPLE_INTERVAL_MS = 10_000;
const LADDER_STEP_MS = 5_000;
const SERIAL_TAIL_BYTES = 8192;

interface BootFlags {
	readonly config: DisplayConfig;
	readonly holdSeconds: number;
}

function parseFlags(argv: readonly string[]): BootFlags {
	let config: string | undefined;
	let holdSeconds = 90;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--config") {
			config = argv[++i];
		} else if (flag === "--hold-seconds") {
			holdSeconds = Number(argv[++i]);
		} else {
			throw new Error(`boot: unknown argument: ${flag}`);
		}
	}
	if (config === undefined || !isDisplayConfig(config)) {
		throw new Error("boot: --config <gl|headless> is required");
	}
	if (!Number.isFinite(holdSeconds) || holdSeconds <= 0) {
		throw new Error(`boot: --hold-seconds must be a positive number, got ${argv.join(" ")}`);
	}
	return { config, holdSeconds };
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

async function waitForFile(path: string, timeoutMs: number): Promise<boolean> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function statusState(returned: unknown): string {
	if (isRecord(returned) && typeof returned.status === "string") {
		return returned.status;
	}
	return `unexpected return: ${JSON.stringify(returned)}`;
}

// The socket file can appear a beat before QEMU finishes listening — retry the connect.
async function connectQmpWithRetry(socketPath: string, attempts: number): Promise<QmpClient> {
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

function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
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

type LadderPath = "quit" | "sigterm" | "sigkill" | "already-exited";

interface LadderResult {
	readonly path: LadderPath;
	readonly detail: string;
}

// The stop ladder (ported from Oligarchy's process.ts shape): QMP quit → wait ≤5 s →
// SIGTERM → wait 5 s → SIGKILL → wait. The quit reply routinely races the socket teardown,
// so only the observed exit decides the path.
async function shutdownLadder(child: ChildProcess, qmp: QmpClient | undefined): Promise<LadderResult> {
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
function assertProcessGone(child: ChildProcess): void {
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

async function tailText(path: string, bytes: number): Promise<string> {
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

let stopRequested = false;
process.on("SIGINT", () => {
	stopRequested = true;
});
process.on("SIGTERM", () => {
	stopRequested = true;
});

async function main(): Promise<number> {
	const flags = parseFlags(process.argv.slice(2));
	const dirs = openSpikeDirs();
	const iso = await ensureIso(dirs);
	console.log(`iso: ${iso.action} ${iso.path} (${iso.size} bytes, sha256 ${iso.sha256})`);

	const startedAt = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `${flags.config}-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	copyFileSync(OVMF_VARS, join(sessionDir, "OVMF_VARS.4m.fd"));
	const diskPath = join(sessionDir, "disk.qcow2");
	const img = await run(QEMU_IMG, ["create", "-f", "qcow2", diskPath, DISK_SIZE]);
	if (img.code !== 0) {
		throw new Error(`boot: qemu-img create exited ${img.code}: ${img.stderrTail.trim()}`);
	}

	const argv = qemuArgs({ name, sessionDir, isoPath: iso.path, config: flags.config });
	console.log(`boot: session ${sessionDir}`);
	console.log(`boot: qemu ${JSON.stringify(argv)}`);

	const stderrPath = join(sessionDir, "qemu.stderr");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(QEMU_BIN, argv, { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	if (child.pid === undefined) {
		throw new Error(`boot: spawn ${QEMU_BIN} failed`);
	}
	console.log(`boot: qemu pid ${child.pid}`);

	let qmp: QmpClient | undefined;
	let ladder: LadderResult | undefined;
	try {
		const socketPath = join(sessionDir, "qmp.sock");
		if (!(await waitForFile(socketPath, 15_000))) {
			if (hasExited(child)) {
				throw new Error(
					`boot: qemu exited before creating the QMP socket; stderr: ${await tailText(stderrPath, 4096)}`,
				);
			}
			throw new Error(`boot: no QMP socket at ${socketPath} within 15 s`);
		}
		qmp = await connectQmpWithRetry(socketPath, 5);
		const client = qmp;
		console.log(`boot: qmp greeting ${qmp.greetingLine}`);
		console.log(`boot: qmp_capabilities ${JSON.stringify(qmp.capabilitiesReturn)}`);

		const pidfile = readFileSync(join(sessionDir, "qemu.pid"), "utf8").trim();
		const pidfileNote =
			Number(pidfile) === child.pid
				? `matches pid ${child.pid}`
				: `MISMATCH: pidfile ${pidfile} vs child ${child.pid}`;
		console.log(`boot: pidfile ${pidfileNote}`);

		const samples: string[] = [];
		let sawRunning = false;
		let holdProblem: string | undefined;
		const sample = async (): Promise<void> => {
			const state = statusState(await client.execute("query-status"));
			samples.push(`${new Date().toISOString()} query-status → ${state}`);
			console.log(`hold: ${samples[samples.length - 1]}`);
			if (state === "running") {
				sawRunning = true;
			}
		};

		await sample();
		const deadline = Date.now() + flags.holdSeconds * 1000;
		while (!stopRequested && Date.now() < deadline) {
			await sleep(Math.max(1, Math.min(SAMPLE_INTERVAL_MS, deadline - Date.now())));
			if (hasExited(child)) {
				holdProblem = `qemu exited during hold (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
				break;
			}
			try {
				await sample();
			} catch (error) {
				holdProblem = error instanceof Error ? error.message : String(error);
				break;
			}
		}
		if (stopRequested && holdProblem === undefined) {
			holdProblem = "interrupted by signal";
		}

		ladder = await shutdownLadder(child, qmp);
		assertProcessGone(child);
		console.log(`boot: shutdown path ${ladder.path} (${ladder.detail})`);

		const serialPath = join(sessionDir, "serial.log");
		const serialStat = statSync(serialPath, { throwIfNoEntry: false });
		const serialBytes = serialStat?.size ?? 0;
		const serialText = serialStat === undefined ? "" : await tailText(serialPath, SERIAL_TAIL_BYTES);
		const serialLines = serialText
			.split(/\r?\n/)
			.filter((line) => line !== "")
			.slice(-5);

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		const failures: string[] = [];
		if (holdProblem !== undefined) {
			failures.push(holdProblem);
		}
		if (!sawRunning) {
			failures.push("no query-status returned running");
		}
		if (serialStat === undefined) {
			failures.push("serial.log missing");
		}
		if (ladder.path === "sigkill") {
			failures.push("qemu only died to SIGKILL");
		}

		const logLines = [
			`# ${name} (${ISO_URL} pin, ${iso.action})`,
			`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			...samples.map((sampleLine) => `query-status: ${sampleLine}`),
			`serial.log: ${serialStat === undefined ? "MISSING" : `${serialBytes} bytes`}`,
			...serialLines.map((line) => `serial| ${line}`),
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`failures: ${failures.length === 0 ? "none" : failures.join("; ")}`,
		];
		const runLog = join(dirs.runs, `${stamp}-${flags.config}.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`boot: run log ${runLog}`);

		if (failures.length > 0) {
			console.error(`boot: GATE FAILED for ${flags.config}: ${failures.join("; ")}`);
			return stopRequested ? 130 : 1;
		}
		console.log(`boot: gate passed for ${flags.config} (serial.log ${serialBytes} bytes)`);
		return stopRequested ? 130 : 0;
	} finally {
		if (!hasExited(child)) {
			console.error("boot: error path — running the stop ladder before exit");
			await shutdownLadder(child, qmp);
			assertProcessGone(child);
		}
	}
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
