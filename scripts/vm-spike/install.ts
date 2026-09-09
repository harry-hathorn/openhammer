// Install runner: `SPIKE_DIR=... npx tsx scripts/vm-spike/install.ts [--budget-minutes 45]
// [--encrypt]`
// Spec 22 gate 2: build the cidata drive, boot ISO + cidata + blank 40G qcow2 disk-first
// headless, and wait for the unattended install to finish. Progress signals on this ISO
// are disk growth + ssh (serial.log carries OVMF only — a 22a finding). The gate is TWO
// successful `ssh ... true` round-trips 10 s apart: the installer reboots by itself
// mid-flight, and a single answer could be an sshd that dies with the installer.
// On success the installed system is powered down CLEANLY over ssh (guest
// `systemctl poweroff` — a hard QMP quit on the live guest is a power cut that loses
// uncommitted btrfs data; the first golden lost its sshd host keys exactly that way) and
// the installed session dir is left INTACT — the next box boots it via a qcow2 overlay.
//
// `--encrypt` (spec 22 gate 3, the encrypted variant): the cidata carries the configurator's
// exact disk_encryption block, so the installer formats the root partition as LUKS2. The
// success signal changes because sshd will NEVER answer — every boot of the installed system
// waits at the LUKS prompt. The gate becomes serial evidence: the post-install reboot's
// `BdsDxe: starting Boot#### "Limine"` (the installed disk booted — the only Limine load a
// blank-disk first boot cannot produce) followed by EITHER the text LUKS prompt in serial
// (the encrypt hook's fallback when plymouth is down) OR serial quiescence with the guest
// still running (plymouth renders the prompt on the VGA scanout where serial cannot see it).
// The shutdown then takes the STOP LADDER, not the ssh poweroff: at the LUKS prompt nothing
// is mounted and nothing is writable — the LUKS volume was never opened, the ESP is not
// mounted (Limine read it via EFI block IO), and the installer's own reboot already synced
// its writes — so a QMP quit there is a power cut against an idle disk, not against btrfs.
// The session is named `luks-install-*` (not `install-*`) so matrix.ts's findGoldenSession
// never picks the encrypted disk for the unencrypted desktop gate.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, copyFileSync, mkdirSync, openSync, readFileSync, statSync } from "node:fs";
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
// Encrypted-gate constants: the serial tail to grep, the OVMF mark of the installed disk
// booting Limine (Boot#### id varies with the firmware entry table, the quoted label does
// not), the LUKS prompt texts in likelihood order (the busybox encrypt hook's fallback text
// first — the installed HOOKS drop-in is `base udev plymouth ... encrypt`, so plymouth owns
// the prompt when alive and serial stays silent), and how long serial must be quiet for the
// prompt to count as STABLE (the gate needs "the guest reached the prompt", not "the prompt
// scrolled by").
const SERIAL_TAIL_BYTES = 16_384;
const LIMINE_BOOT_PATTERN = /BdsDxe: starting Boot\d+ "Limine"/;
const LUKS_PROMPT_PATTERNS = [
	"A password is required to access the",
	"Please enter passphrase for",
	"Enter passphrase for",
	"Please unlock disk",
] as const;
const SERIAL_QUIET_MS = 20_000;
const INSTALL_MIN_DISK_GROWTH = 1024 * 1024 * 1024; // 1 GiB — an install happened, not a boot loop

interface InstallFlags {
	readonly budgetMinutes: number;
	readonly encrypt: boolean;
}

function parseFlags(argv: readonly string[]): InstallFlags {
	let budgetMinutes = DEFAULT_BUDGET_MINUTES;
	let encrypt = false;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--budget-minutes") {
			budgetMinutes = Number(argv[++i]);
		} else if (flag === "--encrypt") {
			encrypt = true;
		} else {
			throw new Error(`install: unknown argument: ${flag}`);
		}
	}
	if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
		throw new Error(`install: --budget-minutes must be a positive number, got ${argv.join(" ")}`);
	}
	return { budgetMinutes, encrypt };
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
	readonly serialEvents: string[];
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
	// The `luks-` prefix is load-bearing: matrix.ts's findGoldenSession matches
	// `install-*` to pick the UNENCRYPTED golden for the desktop gate — the encrypted disk
	// must stay invisible to it (its ssh gate can never pass behind the LUKS prompt).
	const name = flags.encrypt ? `luks-install-${stamp}` : `install-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	const cidata = await buildCidata({ dirs, name, recoveryDir: sessionDir, encrypt: flags.encrypt });
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
			serialEvents: [],
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
		// Encrypted-gate accumulators: the Limine boot mark, the matched prompt text (if the
		// text fallback is on serial), and the serial-quiescence tracker (last size + since
		// when it has been unchanged).
		let limineStartedAt: number | undefined;
		let promptSeen: string | undefined;
		let lastSerialSize = -1;
		let serialQuietSince: number | undefined;

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

			if (flags.encrypt) {
				// --- encrypted gate: serial evidence, no ssh (sshd sits behind the LUKS prompt)
				const serialPath = join(sessionDir, "serial.log");
				const serialStat = statSync(serialPath, { throwIfNoEntry: false });
				const serialSize = serialStat?.size ?? 0;
				const serialText = serialStat === undefined ? "" : await tailText(serialPath, SERIAL_TAIL_BYTES);
				if (limineStartedAt === undefined && LIMINE_BOOT_PATTERN.test(serialText)) {
					limineStartedAt = Date.now();
					state.serialEvents.push(
						`limine: installed disk booted (BdsDxe Limine start) after ${((limineStartedAt - startedAt) / 1000).toFixed(1)} s`,
					);
					console.log(`install: limine boot mark after ${((limineStartedAt - startedAt) / 1000).toFixed(1)} s`);
				}
				if (promptSeen === undefined) {
					const match = LUKS_PROMPT_PATTERNS.find((pattern) => serialText.includes(pattern));
					if (match !== undefined) {
						promptSeen = match;
						state.serialEvents.push(`luks: text prompt in serial: "${match}"`);
						console.log(`install: luks prompt text seen: "${match}"`);
					}
				}
				if (serialSize === lastSerialSize) {
					serialQuietSince ??= Date.now();
				} else {
					lastSerialSize = serialSize;
					serialQuietSince = undefined;
				}
				const diskGrew =
					state.lastDisk !== undefined &&
					state.firstDisk !== undefined &&
					state.lastDisk.actualSize - state.firstDisk.actualSize >= INSTALL_MIN_DISK_GROWTH;
				const quietMs = serialQuietSince === undefined ? 0 : Date.now() - serialQuietSince;
				if (limineStartedAt !== undefined && diskGrew && quietMs >= SERIAL_QUIET_MS) {
					// Either prompt form must be STABLE before the gate passes: serial stops
					// growing exactly when the guest waits for input. When no text is on
					// serial at all, plymouth owns the prompt (VGA scanout, invisible to
					// serial) — Limine booted the installed disk, the disk holds an install,
					// and serial has been quiet past the settle budget: the guest sits at the
					// prompt.
					if (promptSeen !== undefined) {
						// The text prompt must ALSO be stable before we call the gate: it stops
						// growing once the guest waits for input.
						gatePassed = true;
						state.serialEvents.push(
							`luks: prompt stable (${SERIAL_QUIET_MS / 1000} s serial quiet at ${serialSize} bytes)`,
						);
					} else {
						gatePassed = true;
						state.serialEvents.push(
							`luks: prompt ASSUMED (no text on serial — plymouth renders it on the scanout; ${SERIAL_QUIET_MS / 1000} s quiet at ${serialSize} bytes)`,
						);
					}
					console.log("install: luks prompt reached — encrypted gate passed");
					break;
				}
			} else if (hostPort !== undefined) {
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
			gateFailure = flags.encrypt
				? `no LUKS-prompt gate within the ${flags.budgetMinutes} min budget (limine boot mark ${limineStartedAt === undefined ? "never seen" : "seen"}, prompt text ${promptSeen === undefined ? "never seen" : `seen: "${promptSeen}"`})`
				: `no ssh gate within the ${flags.budgetMinutes} min budget`;
		}

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		// Clean shutdown beats the stop ladder for the UNENCRYPTED gate: the installed system
		// is left as the golden image for every later box, and a QMP `quit` on the live guest
		// is a hard power cut — the first golden lost its sshd host keys that way (0-byte key
		// files: btrfs had the metadata committed but not the data; sshd then dies with "no
		// hostkeys available" on every boot, and sshdgenkeys won't regen because its
		// ConditionPathExists=!key only fires on ABSENT files). A guest-initiated
		// `systemctl poweroff` unmounts and flushes before QEMU exits.
		// The ENCRYPTED gate inverts this: sshd is unreachable (the system waits at the LUKS
		// prompt), and the stop ladder IS the clean shutdown there — at the prompt the LUKS
		// volume was never opened, nothing is mounted, and nothing in the guest has written
		// since the installer's own reboot synced. A QMP quit lands on an idle disk.
		let poweroffNote = "not attempted (encrypted gate — stop ladder is the clean path)";
		if (!flags.encrypt && gatePassed && candidateUser !== undefined && hostPort !== undefined) {
			const password = readFileSync(cidata.recoveryPasswordPath, "utf8").trim();
			const poweroff = await sshRun(candidateUser, hostPort, cidata.privateKeyPath, "sudo -S systemctl poweroff", {
				stdin: `${password}\n`,
			});
			poweroffNote = `ssh sudo systemctl poweroff rc=${poweroff.code} ${poweroff.stderrTail.trim()}`;
			console.log(`install: ${poweroffNote}`);
		}
		if (!flags.encrypt && gatePassed && (await waitForExit(child, 180_000))) {
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
			`encrypt: ${flags.encrypt ? "yes (disk_encryption luks block + encryption_password credentials + user_encrypt_installation.txt=true)" : "no"}`,
			`ssh users tried in order: ${flags.encrypt ? "none — sshd waits behind the LUKS prompt" : SSH_USER_CANDIDATES.join(", ")}`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			`usernet row: ${state.usernetRow ?? "NEVER PARSED"}`,
			...state.sshEvents.map((line) => `ssh| ${line}`),
			...state.serialEvents.map((line) => `serial| ${line}`),
			...state.observations.map((line) => `observe| ${line}`),
			`disk final: virtual=${finalSample?.virtualSize ?? "?"} actual=${finalSample?.actualSize ?? "?"}`,
			`gate: ${
				gatePassed
					? flags.encrypt
						? `PASSED (luks prompt; text=${promptSeen === undefined ? "not on serial (plymouth)" : `"${promptSeen}"`})`
						: `PASSED (user=${candidateUser ?? "?"})`
					: "FAILED"
			}`,
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`failures: ${failures.length === 0 ? "none" : failures.join("; ")}`,
		];
		const runLog = join(dirs.runs, flags.encrypt ? `${stamp}-install-encrypt.log` : `${stamp}-install.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`install: run log ${runLog}`);

		if (failures.length > 0) {
			console.error(`install: GATE FAILED: ${failures.join("; ")}`);
			console.error(
				`install: evidence — last disk ${state.lastDisk?.actualSize ?? "?"} B, ` +
					`last status ${state.lastStatus}, run log ${runLog}, session kept at ${sessionDir}`,
			);
			console.error(
				flags.encrypt
					? "install: encrypted plan B is the LUKS keyfile in the initramfs (cidata custom commands: crypttab keyfile + mkinitcpio FILES) — record the failure precisely before falling back."
					: "install: plan B is the manual GTK install path (documented fallback) — boot with a display and drive the wizard by hand.",
			);
			return stopRequested ? 130 : 1;
		}
		console.log(
			flags.encrypt
				? `install: encrypted gate passed — wall-clock ${wallClockSeconds.toFixed(1)} s, prompt text ${promptSeen === undefined ? "not on serial (plymouth owns it)" : `"${promptSeen}"`}, ` +
						`disk virtual ${finalSample?.virtualSize} actual ${finalSample?.actualSize}; session left intact at ${sessionDir} — boot it with unlock.ts`
				: `install: gate passed — wall-clock ${wallClockSeconds.toFixed(1)} s, user ${candidateUser}, ` +
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
