// Unlock runner: `SPIKE_DIR=... npx tsx scripts/vm-spike/unlock.ts [--install-session <path>]
// [--budget-minutes 10] [--chord-gap-ms 60]`
// Spec 22 gate 3 (the encrypted chain's proof): boot the ENCRYPTED installed system through a
// fresh qcow2 OVERLAY over the luks-install session's disk (the matrix discipline — the
// encrypted base never boots directly, so it never mutates; the overlay absorbs every write),
// under the headless recipe, then:
//   (a) wait for the LUKS prompt: EITHER the encrypt hook's text fallback greppable in
//       serial.log, OR — when plymouth owns the prompt and renders it on the VGA scanout where
//       serial cannot see it — serial quiescence after the Limine handoff (the exact bytes are
//       recorded either way; which form appeared is itself a finding),
//   (b) type the passphrase through keys.ts sendText → QMP `send-key`, one chord per key with
//       pacing (a burst overflows QEMU's ~1024-event keyboard queue and drops keys), every
//       exchange recorded in the run log,
//   (c) gate: serial shows the boot CONTINUED (the serial-getty "omarchy-sandbox login:"
//       prompt within the budget) AND the 22b ssh double round-trip confirms,
//   (d) teardown: clean guest poweroff over ssh (`sudo -S systemctl poweroff`, password on
//       stdin) — the overlay discipline — with the stop ladder only as the fallback,
//   (e) run log runs/<stamp>-unlock.log in the established format; the encrypted session's
//       disk + VARS fingerprints are stat-asserted byte-stable before vs after.
// Fallback ladder for a typing failure (spec 22): ONE variation — the same chords through the
// HMP `sendkey` form via `human-monitor-command` — then, if that also fails, the recorded
// decision is the LUKS keyfile in the initramfs (crypttab keyfile + mkinitcpio hooks via
// cidata custom commands at install time). A failure is a finding, not a catastrophe; the
// sandbox default stays unencrypted regardless.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { matrixQemuArgs, QEMU_BIN, QEMU_IMG } from "./args.ts";
import { ensureSshKeypair, GUEST_HOSTNAME, GUEST_USERNAME } from "./cidata.ts";
import { KEY_CHORD_GAP_MS, sendText } from "./keys.ts";
import { run } from "./proc.ts";
import type { QmpClient } from "./qmp.ts";
import {
	assertProcessGone,
	connectQmpWithRetry,
	hasExited,
	type LadderResult,
	parseUsernetHostPort,
	shutdownLadder,
	sleep,
	sshExecTrue,
	sshRun,
	tailText,
	waitForExit,
	waitForFile,
} from "./runtime.ts";
import { openSpikeDirs } from "./scratch.ts";

const DEFAULT_BUDGET_MINUTES = 10;
const POLL_MS = 5_000;
const CONFIRM_GAP_MS = 10_000;
const CONNECT_RETRY_ATTEMPTS = 5;
const SERIAL_TAIL_BYTES = 16_384;
// Serial must be quiet this long after the Limine handoff before the plymouth-rendered prompt
// is ASSUMED (the guest booted, printed its last line, and now waits for input).
const PROMPT_QUIET_MS = 20_000;
// After typing: systemd still has to mount root, start sshd, and spawn the serial getty.
const POST_TYPE_BUDGET_MS = 180_000;
// Grace between the failed first attempt and the ONE variation (a dropped key can leave the
// prompt mid-line; the guest is otherwise idle, so waiting costs nothing).
const RETRY_GRACE_MS = 15_000;
// OVMF's mark that the installed disk's Limine booted (the Boot#### id varies, the label does
// not), and the LUKS prompt texts in likelihood order — the installed mkinitcpio HOOKS drop-in
// is `base udev plymouth keyboard ... block encrypt ...` (busybox encrypt hook + plymouth), so
// the prompt reaches serial only when plymouth is down.
const LIMINE_BOOT_PATTERN = /BdsDxe: starting Boot\d+ "Limine"/;
const LUKS_PROMPT_PATTERNS = [
	"A password is required to access the",
	"Please enter passphrase for",
	"Enter passphrase for",
	"Please unlock disk",
] as const;
const SERIAL_LOGIN_PROMPT = `${GUEST_HOSTNAME} login:`;

interface UnlockFlags {
	readonly installSession: string | undefined;
	readonly budgetMinutes: number;
	readonly chordGapMs: number;
}

function parseFlags(argv: readonly string[]): UnlockFlags {
	let installSession: string | undefined;
	let budgetMinutes = DEFAULT_BUDGET_MINUTES;
	let chordGapMs = KEY_CHORD_GAP_MS;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--install-session") {
			installSession = argv[++i];
		} else if (flag === "--budget-minutes") {
			budgetMinutes = Number(argv[++i]);
		} else if (flag === "--chord-gap-ms") {
			chordGapMs = Number(argv[++i]);
		} else {
			throw new Error(`unlock: unknown argument: ${flag}`);
		}
	}
	if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
		throw new Error(`unlock: --budget-minutes must be a positive number, got ${argv.join(" ")}`);
	}
	if (!Number.isFinite(chordGapMs) || chordGapMs < 0) {
		throw new Error(`unlock: --chord-gap-ms must be a non-negative number, got ${argv.join(" ")}`);
	}
	return { installSession, budgetMinutes, chordGapMs };
}

// --- the encrypted install session (never booted directly) ---

interface LuksSession {
	readonly name: string;
	readonly dir: string;
	readonly disk: string;
	readonly vars: string;
	readonly passwordFile: string;
}

function isLuksSession(dir: string): boolean {
	return (
		statSync(join(dir, "disk.qcow2"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "OVMF_VARS.4m.fd"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "luks-or-sudo-password.txt"), { throwIfNoEntry: false }) !== undefined
	);
}

// Newest `luks-install-*` session holding the full file set (ISO-stamped names sort). The
// `luks-` prefix is what keeps this finder disjoint from matrix.ts's `install-*` golden chain.
function findLuksSession(sessionsDir: string): LuksSession | undefined {
	const names = readdirSync(sessionsDir)
		.filter((name) => name.startsWith("luks-install-"))
		.sort();
	for (let i = names.length - 1; i >= 0; i--) {
		const dir = join(sessionsDir, names[i]);
		if (isLuksSession(dir)) {
			return {
				name: basename(dir),
				dir,
				disk: join(dir, "disk.qcow2"),
				vars: join(dir, "OVMF_VARS.4m.fd"),
				passwordFile: join(dir, "luks-or-sudo-password.txt"),
			};
		}
	}
	return undefined;
}

function luksSessionAt(dir: string): LuksSession {
	return {
		name: basename(dir),
		dir,
		disk: join(dir, "disk.qcow2"),
		vars: join(dir, "OVMF_VARS.4m.fd"),
		passwordFile: join(dir, "luks-or-sudo-password.txt"),
	};
}

interface FileFingerprint {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

function fileFingerprint(path: string): FileFingerprint | undefined {
	const stat = statSync(path, { throwIfNoEntry: false });
	return stat === undefined ? undefined : { path, size: stat.size, mtimeMs: stat.mtimeMs };
}

function fingerprintsEqual(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
	if (a === undefined || b === undefined) {
		return false;
	}
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function describeFingerprint(fingerprint: FileFingerprint | undefined): string {
	return fingerprint === undefined
		? "MISSING"
		: `${fingerprint.path} size=${fingerprint.size} mtimeMs=${fingerprint.mtimeMs}`;
}

// Run-log collector: every measurement lands both in the log and on the console.
interface Recorder {
	readonly lines: string[];
	findings: string[];
	failures: string[];
}

function note(rec: Recorder, tag: string, line: string): void {
	rec.lines.push(`${tag}| ${line}`);
	console.log(`unlock: ${tag}| ${line}`);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
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

	const luksSession: LuksSession | undefined =
		flags.installSession !== undefined
			? isLuksSession(flags.installSession)
				? luksSessionAt(flags.installSession)
				: undefined
			: findLuksSession(dirs.sessions);
	if (luksSession === undefined) {
		throw new Error(
			flags.installSession !== undefined
				? `unlock: --install-session ${flags.installSession} is not a luks session (needs disk.qcow2 + OVMF_VARS.4m.fd + luks-or-sudo-password.txt)`
				: `unlock: no luks-install-* session found under ${dirs.sessions} (run install.ts --encrypt first, or pass --install-session <path>)`,
		);
	}
	const diskBefore = fileFingerprint(luksSession.disk);
	const varsBefore = fileFingerprint(luksSession.vars);
	const password = readFileSync(luksSession.passwordFile, "utf8").trim();
	if (password === "") {
		throw new Error(`unlock: ${luksSession.passwordFile} is empty — no passphrase to type`);
	}
	const keypair = await ensureSshKeypair(dirs.root);

	const startedAt = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `unlock-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	// Overlay boot pattern (the matrix discipline): fresh qcow2 with the encrypted disk as
	// backing file + a COPY of the install session's VARS (it holds the Limine boot entry).
	// The encrypted base stays read-only-through-the-overlay.
	const overlayPath = join(sessionDir, "disk.qcow2");
	const img = await run(QEMU_IMG, ["create", "-f", "qcow2", "-b", luksSession.disk, "-F", "qcow2", overlayPath]);
	if (img.code !== 0) {
		throw new Error(`unlock: qemu-img create overlay exited ${img.code}: ${img.stderrTail.trim()}`);
	}
	copyFileSync(luksSession.vars, join(sessionDir, "OVMF_VARS.4m.fd"));

	const argv = matrixQemuArgs({ name, sessionDir, config: "headless" });
	console.log(`unlock: luks session ${luksSession.dir}`);
	console.log(`unlock: session ${sessionDir}`);
	console.log(`unlock: qemu ${JSON.stringify(argv)}`);

	const rec: Recorder = { lines: [], findings: [], failures: [] };
	note(rec, "overlay", `qemu-img create -f qcow2 -b ${luksSession.disk} -F qcow2 ${overlayPath}`);
	note(rec, "golden", `before: ${describeFingerprint(diskBefore)} / ${describeFingerprint(varsBefore)}`);
	note(rec, "passphrase", `${password.length} chars from ${luksSession.passwordFile} (base64url charset)`);

	const stderrPath = join(sessionDir, "qemu.stderr");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(QEMU_BIN, argv, { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	if (child.pid === undefined) {
		throw new Error("unlock: spawn qemu failed");
	}
	console.log(`unlock: qemu pid ${child.pid}`);

	let qmp: QmpClient | undefined;
	try {
		const socketPath = join(sessionDir, "qmp.sock");
		if (!(await waitForFile(socketPath, 15_000))) {
			if (hasExited(child)) {
				throw new Error(
					`unlock: qemu exited before creating the QMP socket; stderr: ${await tailText(stderrPath, 4096)}`,
				);
			}
			throw new Error(`unlock: no QMP socket at ${socketPath} within 15 s`);
		}
		qmp = await connectQmpWithRetry(socketPath, CONNECT_RETRY_ATTEMPTS);
		const client = qmp;
		console.log(`unlock: qmp greeting ${qmp.greetingLine}`);

		const pidfile = readFileSync(join(sessionDir, "qemu.pid"), "utf8").trim();
		const pidfileNote =
			Number(pidfile) === child.pid
				? `matches pid ${child.pid}`
				: `MISMATCH: pidfile ${pidfile} vs child ${child.pid}`;
		console.log(`unlock: pidfile ${pidfileNote}`);

		// --- (a) wait for the LUKS prompt (text on serial, or plymouth quiescence) + the port
		const serialPath = join(sessionDir, "serial.log");
		let hostPort: number | undefined;
		let usernetRow: string | undefined;
		let limineStartedAt: number | undefined;
		let promptSeen: string | undefined;
		let promptAssumed = false;
		let serialSizeAtPrompt = 0;
		let lastSerialSize = -1;
		let serialQuietSince: number | undefined;
		let gateFailure: string | undefined;
		const deadline = Date.now() + flags.budgetMinutes * 60_000;
		while (
			!stopRequested &&
			Date.now() < deadline &&
			gateFailure === undefined &&
			promptSeen === undefined &&
			!promptAssumed
		) {
			if (hasExited(child)) {
				gateFailure = `qemu exited while waiting for the prompt (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
				break;
			}
			const serialStat = statSync(serialPath, { throwIfNoEntry: false });
			const serialSize = serialStat?.size ?? 0;
			const serialText = serialStat === undefined ? "" : await tailText(serialPath, SERIAL_TAIL_BYTES);
			if (serialText.includes(SERIAL_LOGIN_PROMPT)) {
				// The login prompt WITHOUT unlocking is the not-actually-encrypted failure mode:
				// the credentials file was the load-bearing piece (see cidata.ts) and a missing
				// top-level encryption_password makes the install silently come out plain.
				gateFailure = `serial reached "${SERIAL_LOGIN_PROMPT}" without any passphrase typed — the disk is NOT encrypted`;
				break;
			}
			if (limineStartedAt === undefined && LIMINE_BOOT_PATTERN.test(serialText)) {
				limineStartedAt = Date.now();
				note(
					rec,
					"boot",
					`Limine started after ${((limineStartedAt - startedAt) / 1000).toFixed(1)} s (serial.log ${serialSize} bytes)`,
				);
			}
			if (promptSeen === undefined) {
				const match = LUKS_PROMPT_PATTERNS.find((pattern) => serialText.includes(pattern));
				if (match !== undefined) {
					promptSeen = match;
					serialSizeAtPrompt = serialSize;
					note(
						rec,
						"prompt",
						`TEXT on serial after ${((Date.now() - startedAt) / 1000).toFixed(1)} s: "${match}"`,
					);
					break;
				}
			}
			if (serialSize === lastSerialSize) {
				serialQuietSince ??= Date.now();
			} else {
				lastSerialSize = serialSize;
				serialQuietSince = undefined;
			}
			if (
				limineStartedAt !== undefined &&
				serialQuietSince !== undefined &&
				Date.now() - serialQuietSince >= PROMPT_QUIET_MS
			) {
				promptAssumed = true;
				serialSizeAtPrompt = serialSize;
				note(
					rec,
					"prompt",
					`ASSUMED after ${((Date.now() - startedAt) / 1000).toFixed(1)} s — no prompt text on serial (plymouth renders it on the scanout); serial quiet ${PROMPT_QUIET_MS / 1000} s at ${serialSize} bytes`,
				);
				break;
			}
			if (hostPort === undefined) {
				try {
					const table = await client.humanMonitorCommand("info usernet");
					const found = parseUsernetHostPort(table);
					if (found !== undefined) {
						hostPort = found.port;
						usernetRow = found.row;
						note(rec, "usernet", `${found.row} → host port ${found.port}`);
					}
				} catch {
					// retry next tick
				}
			}
			await sleep(POLL_MS);
		}
		if (stopRequested && gateFailure === undefined && promptSeen === undefined && !promptAssumed) {
			gateFailure = "interrupted by signal";
		}
		if (gateFailure === undefined && promptSeen === undefined && !promptAssumed) {
			gateFailure = `no LUKS prompt within the ${flags.budgetMinutes} min budget (Limine ${limineStartedAt === undefined ? "never started" : `started ${((limineStartedAt - startedAt) / 1000).toFixed(1)} s in`})`;
		}
		if (gateFailure !== undefined) {
			rec.failures.push(gateFailure);
		}
		if (hostPort === undefined && gateFailure === undefined) {
			// The port is only needed past this point; one last direct attempt before failing.
			try {
				const table = await client.humanMonitorCommand("info usernet");
				const found = parseUsernetHostPort(table);
				if (found !== undefined) {
					hostPort = found.port;
					usernetRow = found.row;
					note(rec, "usernet", `${found.row} → host port ${found.port}`);
				}
			} catch {
				// recorded below
			}
		}

		// --- (b)+(c) type the passphrase, then gate on serial continuation + ssh double trip
		let unlocked = false;
		let typingNote = "not attempted";
		let serialAfterUnlock = "";
		let serialReachedLogin = false;
		if (gateFailure === undefined) {
			const port = hostPort;
			if (port === undefined) {
				rec.failures.push("never learned a hostfwd port from info usernet");
			} else {
				const attempt = async (channel: "qmp-send-key" | "hmp-sendkey"): Promise<boolean> => {
					const typed = await sendText(client, password, {
						chordGapMs: flags.chordGapMs,
						channel,
						onExchange: (exchange) => {
							note(rec, "send-key", `${exchange.channel} ${JSON.stringify(exchange.args)}`);
						},
					});
					note(
						rec,
						"send-key",
						`typed ${password.length} chars + ENTER as ${typed.chords.length} chords, ${flags.chordGapMs} ms/chord, via ${channel}`,
					);
					const postTypeDeadline = Date.now() + POST_TYPE_BUDGET_MS;
					while (!stopRequested && Date.now() < postTypeDeadline) {
						if (hasExited(child)) {
							gateFailure = `qemu exited after typing (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
							return false;
						}
						const serialText = await tailText(serialPath, SERIAL_TAIL_BYTES);
						if (serialText.includes(SERIAL_LOGIN_PROMPT)) {
							serialAfterUnlock = serialText;
							serialReachedLogin = true;
							note(
								rec,
								"unlock",
								`serial shows "${SERIAL_LOGIN_PROMPT}" ${((Date.now() - startedAt) / 1000).toFixed(1)} s in — boot continued past the prompt`,
							);
							if (await sshExecTrue(GUEST_USERNAME, port, keypair.privateKeyPath)) {
								note(rec, "ssh", `first answer user=${GUEST_USERNAME} port=${port}`);
								await sleep(CONFIRM_GAP_MS);
								if (await sshExecTrue(GUEST_USERNAME, port, keypair.privateKeyPath)) {
									note(
										rec,
										"ssh",
										`CONFIRMED user=${GUEST_USERNAME} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart) — gate passed`,
									);
									return true;
								}
								rec.failures.push("ssh: candidate lost its confirm round-trip after unlock");
								return false;
							}
							rec.failures.push(`serial unlocked but ssh never answered on port ${port}`);
							return false;
						}
						await sleep(POLL_MS);
					}
					return false;
				};

				unlocked = await attempt("qmp-send-key");
				// The ONE sanctioned variation — only when the typing itself seems to be what
				// failed (serial never reached the login prompt). If the unlock WORKED and ssh
				// is what failed, retyping would only feed the login prompt a stray line.
				if (!unlocked && !serialReachedLogin && gateFailure === undefined && !stopRequested) {
					rec.findings.push("QMP send-key typing did not unlock — trying the ONE variation (HMP sendkey)");
					note(rec, "send-key", `first channel failed; waiting ${RETRY_GRACE_MS / 1000} s before the variation`);
					await sleep(RETRY_GRACE_MS);
					unlocked = await attempt("hmp-sendkey");
				}
				typingNote = unlocked ? "unlocked" : "typing failed on both channels";
			}
		}

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		// --- (d) teardown: clean guest poweroff over ssh (the overlay discipline), ladder as
		// the fallback — only the overlay is at risk from a hard cut, but clean is clean.
		let poweroffNote = "not attempted";
		if (unlocked && hostPort !== undefined) {
			const poweroff = await sshRun(GUEST_USERNAME, hostPort, keypair.privateKeyPath, "sudo -S systemctl poweroff", {
				stdin: `${password}\n`,
			});
			poweroffNote = `ssh sudo systemctl poweroff rc=${poweroff.code} ${poweroff.stderrTail.trim()}`;
			note(rec, "teardown", poweroffNote);
		}
		let ladder: LadderResult;
		if (unlocked && (await waitForExit(child, 180_000))) {
			ladder = {
				path: "guest-poweroff" as const,
				detail: `${poweroffNote}; exitCode=${child.exitCode} signalCode=${child.signalCode}`,
			};
		} else {
			ladder = await shutdownLadder(child, qmp);
		}
		assertProcessGone(child);
		console.log(`unlock: shutdown path ${ladder.path} (${ladder.detail})`);

		const serialStat = statSync(serialPath, { throwIfNoEntry: false });
		const diskAfter = fileFingerprint(luksSession.disk);
		const varsAfter = fileFingerprint(luksSession.vars);
		const goldenOk = fingerprintsEqual(diskBefore, diskAfter) && fingerprintsEqual(varsBefore, varsAfter);
		if (!goldenOk) {
			rec.failures.push(
				"luks install session mutated during the run — the overlay was supposed to absorb every write",
			);
		}
		if (ladder.path === "sigkill") {
			rec.failures.push("qemu only died to SIGKILL");
		}
		if (!unlocked && gateFailure === undefined && rec.failures.length === 0) {
			rec.failures.push(typingNote);
		}

		const serialEvidence = serialAfterUnlock
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line !== "")
			.slice(-20);
		const logLines = [
			`# ${name} (overlay boot of ${luksSession.name})`,
			`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
			`luks session: ${luksSession.dir}`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			`usernet row: ${usernetRow ?? "NEVER PARSED"}`,
			`serial.log: ${serialStat === undefined ? "MISSING" : `${serialStat.size} bytes`}`,
			`prompt: ${promptSeen !== undefined ? `text "${promptSeen}" at byte ${serialSizeAtPrompt}` : promptAssumed ? `assumed (plymouth) at byte ${serialSizeAtPrompt}` : "never reached"}`,
			...rec.lines,
			...serialEvidence.map((line) => `serial-after-unlock| ${clip(line, 200)}`),
			`gate: ${unlocked ? "PASSED (serial login prompt + ssh double round-trip)" : "FAILED"}`,
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`luks session after: ${describeFingerprint(diskAfter)} / ${describeFingerprint(varsAfter)} — ${goldenOk ? "unchanged" : "MUTATED"}`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`findings: ${rec.findings.length === 0 ? "none" : rec.findings.join("; ")}`,
			`failures: ${rec.failures.length === 0 ? "none" : rec.failures.join("; ")}`,
			`fallback decision: ${unlocked ? "not needed — the send-key chain works" : "LUKS keyfile in the initramfs (crypttab keyfile + mkinitcpio hooks configured at install time via cidata custom commands) — see failures for what broke"}`,
		];
		const runLog = join(dirs.runs, `${stamp}-unlock.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`unlock: run log ${runLog}`);

		if (rec.failures.length > 0) {
			console.error(`unlock: GATE FAILED: ${rec.failures.join("; ")}`);
			return stopRequested ? 130 : 1;
		}
		console.log(`unlock: gate passed — wall-clock ${wallClockSeconds.toFixed(1)} s; session kept at ${sessionDir}`);
		return stopRequested ? 130 : 0;
	} finally {
		if (!hasExited(child)) {
			console.error("unlock: error path — running the stop ladder before exit");
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
