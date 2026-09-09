// Install runner: `SPIKE_DIR=... npx tsx scripts/vm-spike/install.ts [--budget-minutes 45]`
// Spec 22 gate 2: build the cidata drive, boot ISO + cidata + blank 40G qcow2 disk-first
// headless, and wait for the unattended install to finish. Progress signals on this ISO
// are disk growth + ssh (serial.log carries OVMF only — a 22a finding). The gate is TWO
// successful `ssh ... true` round-trips 10 s apart: the installer reboots by itself
// mid-flight, and a single answer could be an sshd that dies with the installer.
// On success the installed system is powered down CLEANLY over ssh (guest
// `systemctl poweroff` — a hard QMP quit on the live guest is a power cut that loses
// uncommitted btrfs data; the first golden lost its sshd host keys exactly that way) and
// the installed session dir is left INTACT — the next box boots it via a qcow2 overlay.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DISK_SIZE, installQemuArgs, OVMF_VARS, QEMU_BIN, QEMU_IMG } from "./args.ts";
import { buildCidata } from "./cidata.ts";
import { ensureIso } from "./iso.ts";
import { run } from "./proc.ts";
import type { QmpClient } from "./qmp.ts";
import {
	assertProcessGone,
	connectQmpWithRetry,
	hasExited,
	isRecord,
	type LadderResult,
	parseUsernetHostPort,
	shutdownLadder,
	sleep,
	sshExecTrue,
	sshRun,
	statusState,
	tailText,
	waitForExit,
	waitForFile,
} from "./runtime.ts";
import { ISO_URL, openSpikeDirs } from "./scratch.ts";

const DEFAULT_BUDGET_MINUTES = 45;
const SSH_POLL_MS = 10_000;
const CONFIRM_GAP_MS = 10_000;
const OBSERVE_INTERVAL_MS = 60_000;
const CONNECT_RETRY_ATTEMPTS = 5;
// The configured user is the one authorized_keys is installed for; root/arch are the
// long shots recorded as tried (installer-environment users that could answer first).
const SSH_USER_CANDIDATES = ["sandbox", "root", "arch"];

interface InstallFlags {
	readonly budgetMinutes: number;
}

function parseFlags(argv: readonly string[]): InstallFlags {
	let budgetMinutes = DEFAULT_BUDGET_MINUTES;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--budget-minutes") {
			budgetMinutes = Number(argv[++i]);
		} else {
			throw new Error(`install: unknown argument: ${flag}`);
		}
	}
	if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
		throw new Error(`install: --budget-minutes must be a positive number, got ${argv.join(" ")}`);
	}
	return { budgetMinutes };
}

interface DiskSample {
	readonly virtualSize: number;
	readonly actualSize: number;
}

// -U (force-share): QEMU holds the write lock on disk.qcow2 for the whole run.
function diskSample(diskPath: string): Promise<DiskSample | undefined> {
	return run(QEMU_IMG, ["info", "-U", "--output=json", diskPath]).then((result) => {
		if (result.code !== 0) {
			return undefined;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(result.stdoutTail);
		} catch {
			return undefined;
		}
		if (!isRecord(parsed)) {
			return undefined;
		}
		const virtualSize = parsed["virtual-size"];
		const actualSize = parsed["actual-size"];
		if (typeof virtualSize !== "number" || typeof actualSize !== "number") {
			return undefined;
		}
		return { virtualSize, actualSize };
	});
}

let stopRequested = false;
process.on("SIGINT", () => {
	stopRequested = true;
});
process.on("SIGTERM", () => {
	stopRequested = true;
});

// Append-only arrays stay readonly; the loop-written accumulators (usernetRow, firstDisk,
// lastDisk, lastStatus) are mutable by design — the observe loop updates them in place.
interface ObserveState {
	readonly observations: string[];
	readonly sshEvents: string[];
	usernetRow: string | undefined;
	firstDisk: DiskSample | undefined;
	lastDisk: DiskSample | undefined;
	lastStatus: string;
	sshAttempts: number;
	lastSshExit: string;
}

async function main(): Promise<number> {
	const flags = parseFlags(process.argv.slice(2));
	const dirs = openSpikeDirs();
	const iso = await ensureIso(dirs);
	console.log(`iso: ${iso.action} ${iso.path} (${iso.size} bytes, sha256 ${iso.sha256})`);

	const startedAt = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `install-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	const cidata = await buildCidata({ dirs, name, recoveryDir: sessionDir });
	console.log(`cidata: ${cidata.dir} → ${cidata.isoPath} (${cidata.isoSize} bytes, volid cidata)`);
	console.log(`cidata: recovery password recorded at ${cidata.recoveryPasswordPath} (0600)`);
	console.log(`cidata: authorized key ${cidata.publicKey}`);

	copyFileSync(OVMF_VARS, join(sessionDir, "OVMF_VARS.4m.fd"));
	const diskPath = join(sessionDir, "disk.qcow2");
	const img = await run(QEMU_IMG, ["create", "-f", "qcow2", diskPath, DISK_SIZE]);
	if (img.code !== 0) {
		throw new Error(`install: qemu-img create exited ${img.code}: ${img.stderrTail.trim()}`);
	}

	const argv = installQemuArgs({ name, sessionDir, isoPath: iso.path, cidataIsoPath: cidata.isoPath });
	console.log(`install: session ${sessionDir}`);
	console.log(`install: qemu ${JSON.stringify(argv)}`);

	const stderrPath = join(sessionDir, "qemu.stderr");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(QEMU_BIN, argv, { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	if (child.pid === undefined) {
		throw new Error(`install: spawn ${QEMU_BIN} failed`);
	}
	console.log(`install: qemu pid ${child.pid}`);

	let qmp: QmpClient | undefined;
	let ladder: LadderResult | undefined;
	try {
		const socketPath = join(sessionDir, "qmp.sock");
		if (!(await waitForFile(socketPath, 15_000))) {
			if (hasExited(child)) {
				throw new Error(
					`install: qemu exited before creating the QMP socket; stderr: ${await tailText(stderrPath, 4096)}`,
				);
			}
			throw new Error(`install: no QMP socket at ${socketPath} within 15 s`);
		}
		qmp = await connectQmpWithRetry(socketPath, CONNECT_RETRY_ATTEMPTS);
		const client = qmp;
		console.log(`install: qmp greeting ${qmp.greetingLine}`);
		console.log(`install: qmp_capabilities ${JSON.stringify(qmp.capabilitiesReturn)}`);

		const pidfile = readFileSync(join(sessionDir, "qemu.pid"), "utf8").trim();
		const pidfileNote =
			Number(pidfile) === child.pid
				? `matches pid ${child.pid}`
				: `MISMATCH: pidfile ${pidfile} vs child ${child.pid}`;
		console.log(`install: pidfile ${pidfileNote}`);

		const state: ObserveState = {
			observations: [],
			sshEvents: [],
			lastDisk: undefined,
			firstDisk: undefined,
			lastStatus: "unknown",
			usernetRow: undefined,
			sshAttempts: 0,
			lastSshExit: "not-run",
		};

		let hostPort: number | undefined;
		let candidateUser: string | undefined;
		let gatePassed = false;
		const deadline = Date.now() + flags.budgetMinutes * 60_000;
		let nextObserveAt = Date.now();
		let gateFailure: string | undefined;

		while (!stopRequested && Date.now() < deadline) {
			if (hasExited(child)) {
				gateFailure = `qemu exited mid-install (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
				break;
			}

			if (hostPort === undefined) {
				// Re-query every tick: the row exists from slirp setup, but an early probe can
				// race the monitor's first reply — a parse failure is retryable, not fatal.
				try {
					const table = await client.humanMonitorCommand("info usernet");
					const found = parseUsernetHostPort(table);
					if (found !== undefined) {
						hostPort = found.port;
						state.usernetRow = found.row;
						state.sshEvents.push(`usernet: ${found.row} → host port ${found.port}`);
						console.log(`install: usernet ${found.row} → host port ${found.port}`);
					}
				} catch (error) {
					// leave hostPort unset; next tick retries
					state.lastSshExit = `usernet: ${error instanceof Error ? error.message : String(error)}`;
				}
			}

			if (hostPort !== undefined) {
				state.sshAttempts += SSH_USER_CANDIDATES.length;
				const answered: string[] = [];
				for (const user of SSH_USER_CANDIDATES) {
					if (await sshExecTrue(user, hostPort, cidata.privateKeyPath)) {
						answered.push(user);
					}
				}
				state.lastSshExit = answered.length > 0 ? `ok:${answered.join(",")}` : "refused";
				if (answered.length > 0) {
					const user = answered[0];
					if (user === undefined) {
						throw new Error("install: answered array unexpectedly empty");
					}
					if (candidateUser === undefined) {
						candidateUser = user;
						state.sshEvents.push(`ssh: first answer user=${user} port=${hostPort}`);
						console.log(`install: ssh first answer user=${user} port=${hostPort}`);
					}
					if (user === candidateUser) {
						await sleep(CONFIRM_GAP_MS);
						if (hasExited(child)) {
							gateFailure = `qemu exited during the confirm gap (exitCode=${child.exitCode})`;
							break;
						}
						if (await sshExecTrue(user, hostPort, cidata.privateKeyPath)) {
							gatePassed = true;
							state.sshEvents.push(
								`ssh: CONFIRMED user=${user} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart)`,
							);
							console.log(`install: ssh CONFIRMED user=${user} — gate passed`);
							break;
						}
						candidateUser = undefined; // mid-install restart ate the sshd — keep polling
						state.sshEvents.push("ssh: candidate lost its confirm round-trip; polling continues");
					}
				}
			}

			if (Date.now() >= nextObserveAt) {
				nextObserveAt = Date.now() + OBSERVE_INTERVAL_MS;
				const sample = await diskSample(diskPath);
				if (sample !== undefined) {
					if (state.firstDisk === undefined) {
						state.firstDisk = sample;
					}
					state.lastDisk = sample;
					try {
						state.lastStatus = statusState(await client.execute("query-status"));
					} catch (error) {
						state.lastStatus = `query-status failed: ${error instanceof Error ? error.message : String(error)}`;
					}
				}
				const line =
					`${new Date().toISOString()} disk-actual=${state.lastDisk?.actualSize ?? "?"} ` +
					`(+${state.lastDisk === undefined ? 0 : state.lastDisk.actualSize - (state.firstDisk?.actualSize ?? state.lastDisk.actualSize)}) ` +
					`status=${state.lastStatus} ssh-attempts=${state.sshAttempts} last=${state.lastSshExit}`;
				state.observations.push(line);
				console.log(`install: ${line}`);
				state.sshAttempts = 0;
			}

			if (!gatePassed && !stopRequested) {
				await sleep(SSH_POLL_MS);
			}
		}
		if (stopRequested && gateFailure === undefined && !gatePassed) {
			gateFailure = "interrupted by signal";
		}
		if (!gatePassed && gateFailure === undefined) {
			gateFailure = `no ssh gate within the ${flags.budgetMinutes} min budget`;
		}

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		// Clean shutdown beats the stop ladder here: the installed system is left as the
		// golden image for every later box, and a QMP `quit` on the live guest is a hard
		// power cut — the first golden lost its sshd host keys that way (0-byte key files:
		// btrfs had the metadata committed but not the data; sshd then dies with "no
		// hostkeys available" on every boot, and sshdgenkeys won't regen because its
		// ConditionPathExists=!key only fires on ABSENT files). A guest-initiated
		// `systemctl poweroff` unmounts and flushes before QEMU exits.
		let poweroffNote = "not attempted";
		if (gatePassed && candidateUser !== undefined && hostPort !== undefined) {
			const password = readFileSync(cidata.recoveryPasswordPath, "utf8").trim();
			const poweroff = await sshRun(candidateUser, hostPort, cidata.privateKeyPath, "sudo -S systemctl poweroff", {
				stdin: `${password}\n`,
			});
			poweroffNote = `ssh sudo systemctl poweroff rc=${poweroff.code} ${poweroff.stderrTail.trim()}`;
			console.log(`install: ${poweroffNote}`);
		}
		if (gatePassed && (await waitForExit(child, 180_000))) {
			ladder = {
				path: "guest-poweroff",
				detail: `${poweroffNote}; exitCode=${child.exitCode} signalCode=${child.signalCode}`,
			};
		} else {
			ladder = await shutdownLadder(child, qmp);
		}
		assertProcessGone(child);
		console.log(`install: shutdown path ${ladder.path} (${ladder.detail})`);

		const finalSample = await diskSample(diskPath);

		const failures: string[] = [];
		if (!gatePassed) {
			failures.push(gateFailure ?? "gate failed");
		}
		if (hostPort === undefined) {
			failures.push("never learned a hostfwd port from info usernet");
		}
		if (ladder.path === "sigkill") {
			failures.push("qemu only died to SIGKILL");
		}

		const logLines = [
			`# ${name} (${ISO_URL} pin, ${iso.action})`,
			`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
			`cidata: ${cidata.dir}`,
			`cidata iso: ${cidata.isoPath} (${cidata.isoSize} bytes, volid cidata)`,
			`recovery password: ${cidata.recoveryPasswordPath}`,
			`ssh users tried in order: ${SSH_USER_CANDIDATES.join(", ")}`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			`usernet row: ${state.usernetRow ?? "NEVER PARSED"}`,
			...state.sshEvents.map((line) => `ssh| ${line}`),
			...state.observations.map((line) => `observe| ${line}`),
			`disk final: virtual=${finalSample?.virtualSize ?? "?"} actual=${finalSample?.actualSize ?? "?"}`,
			`gate: ${gatePassed ? `PASSED (user=${candidateUser ?? "?"})` : "FAILED"}`,
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`failures: ${failures.length === 0 ? "none" : failures.join("; ")}`,
		];
		const runLog = join(dirs.runs, `${stamp}-install.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`install: run log ${runLog}`);

		if (failures.length > 0) {
			console.error(`install: GATE FAILED: ${failures.join("; ")}`);
			console.error(
				`install: evidence — last disk ${state.lastDisk?.actualSize ?? "?"} B, ` +
					`last status ${state.lastStatus}, run log ${runLog}, session kept at ${sessionDir}`,
			);
			console.error(
				"install: plan B is the manual GTK install path (documented fallback) — boot with a display and drive the wizard by hand.",
			);
			return stopRequested ? 130 : 1;
		}
		console.log(
			`install: gate passed — wall-clock ${wallClockSeconds.toFixed(1)} s, user ${candidateUser}, ` +
				`disk virtual ${finalSample?.virtualSize} actual ${finalSample?.actualSize}; session left intact at ${sessionDir}`,
		);
		return stopRequested ? 130 : 0;
	} finally {
		if (!hasExited(child)) {
			console.error("install: error path — running the stop ladder before exit");
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
