// Matrix runner: `SPIKE_DIR=... npx tsx scripts/vm-spike/matrix.ts --config gl|headless
// [--hold-seconds 180] [--install-session <path>]`
// Spec 22 gate 1 (desktop half) + gate 6. Boots the INSTALLED system under ONE display
// config through a fresh qcow2 OVERLAY over the golden install disk — the product's
// session model: the installed base is never booted directly, so it never mutates (the
// overlay absorbs every write; the install session's VARS are copied, never moved).
// Readiness is the serial login prompt (console=ttyS0 is baked) AND the 22b ssh double
// round-trip; then the gate's measurements, all recorded raw:
//   (a) Hyprland over ssh (pgrep, loginctl sessions, wayland sockets) — and when nothing
//       starts a session, a recorded autologin provisioning attempt (sddm.conf.d when a
//       greeter owns the tty; getty autologin + profile exec otherwise),
//   (b) QMP screendump fidelity: PNG at ~30 s and ~120 s after ready (+ post-provision),
//   (c) grim PNG size (gate 6) vs the 512,000-byte MAX_RESPONSE_BYTES backstop — grim is
//       installed over ssh (sudo, password from the install session) when absent.
// Run log in the 22b format lands in <SPIKE_DIR>/runs/<stamp>-matrix-<config>.log; the
// golden session's disk + VARS are stat-asserted byte-identical before vs after.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
} from "node:fs";
import { basename, join } from "node:path";
import {
	type DisplayConfig,
	isDisplayConfig,
	MATRIX_DISPLAY_DEVICE_ID,
	matrixQemuArgs,
	QEMU_BIN,
	QEMU_IMG,
} from "./args.ts";
import { ensureSshKeypair, GUEST_HOSTNAME, GUEST_USERNAME } from "./cidata.ts";
import { run } from "./proc.ts";
import type { QmpClient } from "./qmp.ts";
import {
	assertProcessGone,
	connectQmpWithRetry,
	hasExited,
	parseUsernetHostPort,
	shutdownLadder,
	sleep,
	sshExecTrue,
	sshRun,
	tailText,
	waitForFile,
} from "./runtime.ts";
import { openSpikeDirs } from "./scratch.ts";

const DEFAULT_HOLD_SECONDS = 180;
const READY_BUDGET_MS = 300_000;
const READY_POLL_MS = 5_000;
const CONFIRM_GAP_MS = 10_000;
const CONNECT_RETRY_ATTEMPTS = 5;
const SERIAL_TAIL_BYTES = 16_384;
const SCREENDUMP_WAIT_MS = 20_000;
const AUTOLOGIN_SETTLE_MS = 30_000;
const AUTOLOGIN_POLL_MS = 5_000;
const AUTOLOGIN_POLL_BUDGET_MS = 60_000;
// src/config.ts DEFAULT_MAX_RESPONSE_BYTES — mirrored here because the spike never
// imports src/ (scripts are excluded from the package); keep the two in lockstep.
const MAX_RESPONSE_BYTES = 512_000;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SERIAL_LOGIN_PROMPT = `${GUEST_HOSTNAME} login:`;
// 22b established sandbox answers; the other installer-environment users are irrelevant
// on an installed system.
const SSH_USER_CANDIDATES = [GUEST_USERNAME];

interface MatrixFlags {
	readonly config: DisplayConfig;
	readonly holdSeconds: number;
	readonly installSession: string | undefined;
}

function parseFlags(argv: readonly string[]): MatrixFlags {
	let config: string | undefined;
	let holdSeconds = DEFAULT_HOLD_SECONDS;
	let installSession: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--config") {
			config = argv[++i];
		} else if (flag === "--hold-seconds") {
			holdSeconds = Number(argv[++i]);
		} else if (flag === "--install-session") {
			installSession = argv[++i];
		} else {
			throw new Error(`matrix: unknown argument: ${flag}`);
		}
	}
	if (config === undefined || !isDisplayConfig(config)) {
		throw new Error("matrix: --config <gl|headless> is required");
	}
	if (!Number.isFinite(holdSeconds) || holdSeconds <= 0) {
		throw new Error(`matrix: --hold-seconds must be a positive number, got ${argv.join(" ")}`);
	}
	return { config, holdSeconds, installSession };
}

async function sleepUntil(targetMs: number): Promise<void> {
	const remaining = targetMs - Date.now();
	if (remaining > 0) {
		await sleep(remaining);
	}
}

// Collapse a multi-line raw output into one log line (raw content survives in the log,
// one line per command — never let a guest newline split a tagged record).
function oneLine(text: string, max: number): string {
	const collapsed = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("; ");
	return clip(collapsed, max);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Run-log collector: every measurement lands both in the log and on the console.
interface Recorder {
	readonly lines: string[];
	findings: string[];
	failures: string[];
}

function note(rec: Recorder, tag: string, line: string): void {
	rec.lines.push(`${tag}| ${line}`);
	console.log(`matrix: ${tag}| ${line}`);
}

interface Capture {
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
}

async function capture(port: number, keyPath: string, command: string): Promise<Capture> {
	const result = await sshRun(GUEST_USERNAME, port, keyPath, command);
	return { code: result.code, out: result.stdoutTail.trim(), err: result.stderrTail.trim() };
}

// sudo over ssh: the password rides stdin (`-S`), never argv; `-p ''` keeps the prompt
// out of the captured output.
async function sudoCapture(port: number, keyPath: string, password: string, command: string): Promise<Capture> {
	const result = await sshRun(GUEST_USERNAME, port, keyPath, `sudo -S -p '' ${command}`, { stdin: `${password}\n` });
	return { code: result.code, out: result.stdoutTail.trim(), err: result.stderrTail.trim() };
}

// --- golden install session (the only installed system — never booted directly) ---

interface GoldenSession {
	readonly name: string;
	readonly dir: string;
	readonly disk: string;
	readonly vars: string;
	readonly passwordFile: string;
}

function isGoldenSession(dir: string): boolean {
	return (
		statSync(join(dir, "disk.qcow2"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "OVMF_VARS.4m.fd"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "luks-or-sudo-password.txt"), { throwIfNoEntry: false }) !== undefined
	);
}

// Newest `install-*` session holding the full golden set (ISO-stamped names sort).
function findGoldenSession(sessionsDir: string): GoldenSession | undefined {
	const names = readdirSync(sessionsDir)
		.filter((name) => name.startsWith("install-"))
		.sort();
	for (let i = names.length - 1; i >= 0; i--) {
		const dir = join(sessionsDir, names[i]);
		if (isGoldenSession(dir)) {
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

function goldenSessionAt(dir: string): GoldenSession {
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

// --- PNG evidence inspection (magic + IHDR dims — no decode, 24 bytes) ---

interface PngInfo {
	readonly exists: boolean;
	readonly size: number;
	readonly magicOk: boolean;
	readonly width: number | undefined;
	readonly height: number | undefined;
}

function pngInspect(path: string): PngInfo {
	const stat = statSync(path, { throwIfNoEntry: false });
	if (stat === undefined) {
		return { exists: false, size: 0, magicOk: false, width: undefined, height: undefined };
	}
	let magicOk = false;
	let width: number | undefined;
	let height: number | undefined;
	try {
		const fd = openSync(path, "r");
		try {
			const header = Buffer.alloc(24);
			const read = readSync(fd, header, 0, 24, 0);
			if (read >= 8) {
				magicOk = header.subarray(0, 8).equals(PNG_MAGIC);
			}
			if (magicOk && read >= 24) {
				width = header.readUInt32BE(16); // IHDR starts at byte 8: len+type then BE32 dims
				height = header.readUInt32BE(20);
			}
		} finally {
			closeSync(fd);
		}
	} catch {
		magicOk = false;
	}
	return { exists: true, size: stat.size, magicOk, width, height };
}

function pngDescribe(info: PngInfo): string {
	if (!info.exists) {
		return "no file";
	}
	const dims = info.width !== undefined && info.height !== undefined ? `, ${info.width}x${info.height}` : "";
	return `${info.size} bytes${info.magicOk ? `, PNG magic ok${dims}` : ", NOT A VALID PNG"}`;
}

// screendump completes asynchronously (SCREENDUMP_DONE event — dropped by the QMP client),
// so the file is polled: exists, non-empty, header intact. Under egl-headless the default
// console pick errors "no surface" (matrix-gl finding) — naming the display device's id is
// the fallback; which form produced the file is recorded.
async function qmpScreendump(qmp: QmpClient, path: string, rec: Recorder): Promise<PngInfo> {
	const attempts: { label: string; args: Record<string, unknown> }[] = [
		{ label: "default console", args: { filename: path, format: "png" } },
		{
			label: `device ${MATRIX_DISPLAY_DEVICE_ID}`,
			args: { filename: path, format: "png", device: MATRIX_DISPLAY_DEVICE_ID },
		},
	];
	let lastError = "";
	for (const attempt of attempts) {
		try {
			await qmp.execute("screendump", attempt.args);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			note(rec, "screendump", `form "${attempt.label}" errored: ${lastError}`);
			continue;
		}
		const deadline = Date.now() + SCREENDUMP_WAIT_MS;
		for (;;) {
			const info = pngInspect(path);
			if (info.exists && info.size > 0) {
				if (attempt.label !== attempts[0]?.label) {
					note(rec, "screendump", `file produced via form "${attempt.label}"`);
				}
				return info;
			}
			if (Date.now() >= deadline) {
				lastError = `no file within ${SCREENDUMP_WAIT_MS / 1000} s (form "${attempt.label}")`;
				break;
			}
			await sleep(500);
		}
	}
	// A screendump that cannot run is the config's measured outcome, not an infra
	// failure — gl/egl-headless consoles never get a 2D surface, so the QMP readback
	// errors "no surface" no matter which console is addressed. Record it as a finding
	// and let the gate summary carry it; the run still completes for comparison.
	rec.findings.push(`screendump unusable on this config: ${lastError}`);
	return pngInspect(path);
}

// --- host facts (gate 1's host-side row) ---

// `-device <name>,help` prints an options list to stdout for a known device and
// "Device '<name>' not found" on stderr for an unknown one (exit code is 0 either way —
// probe-verified). Grepping the full `-device help` catalog instead loses: it is ~20 KB
// and the 4 KB tail `run` keeps cuts the catalog mid-list (a matrix-gl finding).
async function probeDevice(device: string): Promise<string> {
	const result = await run(QEMU_BIN, ["-device", `${device},help`]);
	const stderr = result.stderrTail.trim();
	const stdout = result.stdoutTail.trim();
	const known = stderr === "" && stdout !== "";
	return `${device}: ${known ? `available (${stdout.split(/\r?\n/)[0] ?? ""})` : `UNAVAILABLE (${oneLine(stderr || stdout, 120)})`}`;
}

async function collectHostFacts(): Promise<string[]> {
	const facts: string[] = [];
	for (const device of ["virtio-vga", "virtio-vga-gl", "virtio-vga-rutabaga"]) {
		facts.push(await probeDevice(device));
	}
	const pkg = await run("pacman", ["-Q", "qemu-hw-display-virtio-vga-gl"]);
	facts.push(
		pkg.code === 0
			? `qemu-hw-display-virtio-vga-gl: installed (${pkg.stdoutTail.trim()})`
			: `qemu-hw-display-virtio-vga-gl: NOT installed (${oneLine(pkg.stderrTail, 120)})`,
	);
	return facts;
}

// --- measurement (a): Hyprland over ssh ---

interface HyprlandState {
	readonly running: boolean;
	readonly rawLines: string[];
	readonly waylandSockets: string[];
}

async function measureHyprland(port: number, keyPath: string, rec: Recorder): Promise<HyprlandState> {
	const rawLines: string[] = [];
	// The pgrep must be USER-scoped: Omarchy's SDDM greeter itself runs a Hyprland
	// compositor (as user sddm, --config /usr/share/sddm/hyprland.lua), which a bare
	// `pgrep -x Hyprland` happily matches — the gate asks for the USER's desktop session.
	const userScoped = await capture(port, keyPath, `pgrep -u ${GUEST_USERNAME} -x Hyprland`);
	rawLines.push(`pgrep -u ${GUEST_USERNAME} -x Hyprland: rc=${userScoped.code} ${clip(userScoped.out, 200)}`);
	const exact = await capture(port, keyPath, "pgrep -ax Hyprland");
	rawLines.push(`pgrep -ax Hyprland (any user): rc=${exact.code} ${clip(exact.out, 200)}`);
	const fuzzy = await capture(port, keyPath, "pgrep -af hyprland");
	rawLines.push(`pgrep -af hyprland: rc=${fuzzy.code} ${clip(fuzzy.out, 300)}`);
	const sessions = await capture(port, keyPath, "loginctl list-sessions --no-legend");
	rawLines.push(`loginctl list-sessions --no-legend: rc=${sessions.code} ${oneLine(sessions.out, 300)}`);
	const socketLs = await capture(port, keyPath, "ls /run/user/1000/wayland-*");
	const waylandSockets =
		socketLs.code === 0
			? socketLs.out
					.split(/\r?\n/)
					.map((line) => line.trim().split("/").pop() ?? "")
					.filter((base) => base.startsWith("wayland-"))
			: [];
	rawLines.push(
		`ls /run/user/1000/wayland-*: rc=${socketLs.code} ${oneLine(socketLs.code === 0 ? socketLs.out : socketLs.err, 200)}`,
	);
	for (const line of sessions.out.split(/\r?\n/)) {
		const id = line.trim().split(/\s+/)[0];
		if (line.trim() === "" || id === undefined) {
			continue;
		}
		const shown = await capture(port, keyPath, `loginctl show-session ${id} -p Type -p State -p Class -p Active`);
		rawLines.push(`loginctl show-session ${id}: rc=${shown.code} ${oneLine(shown.out, 200)}`);
	}
	const running = userScoped.code === 0 && userScoped.out !== "";
	for (const line of rawLines) {
		note(rec, "hyprland", line);
	}
	return { running, rawLines, waylandSockets };
}

// --- what owns the tty when nothing starts a session ---

async function inspectGreeter(port: number, keyPath: string, rec: Recorder): Promise<string | undefined> {
	const status = await capture(port, keyPath, "systemctl status display-manager --no-pager -l");
	note(
		rec,
		"hyprland",
		`systemctl status display-manager: rc=${status.code} ${oneLine(status.out || status.err, 400)}`,
	);
	const enabled = await capture(port, keyPath, "systemctl list-unit-files --state=enabled --no-legend");
	const greeterUnits = enabled.out
		.split(/\r?\n/)
		.filter((line) => /(sddm|gdm|greetd|lightdm|lxdm|entrance|\bly\b)/i.test(line));
	note(
		rec,
		"hyprland",
		`enabled greeter-ish units: ${greeterUnits.length > 0 ? oneLine(greeterUnits.join("; "), 400) : "none"}`,
	);
	const binaries = await capture(
		port,
		keyPath,
		'for b in sddm greetd ly lightdm gdm; do command -v "$b" || true; done',
	);
	note(rec, "hyprland", `greeter binaries on PATH: ${oneLine(binaries.out, 300) || "none"}`);
	const desktop = await capture(port, keyPath, "command -v Hyprland; ls /usr/share/wayland-sessions/ 2>/dev/null");
	note(rec, "hyprland", `Hyprland binary + wayland-sessions: ${oneLine(desktop.out, 300) || "none"}`);
	for (const greeter of ["sddm", "greetd", "ly", "lightdm", "gdm"]) {
		if (binaries.out.includes(`/${greeter}`)) {
			return greeter;
		}
	}
	return undefined;
}

// --- provisioning route A: sddm autologin (the product's candidate provisioning step) ---

async function provisionSddmAutologin(port: number, keyPath: string, password: string, rec: Recorder): Promise<void> {
	const sessions = await capture(port, keyPath, "ls /usr/share/wayland-sessions/");
	const desktops = sessions.out
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.endsWith(".desktop"));
	const preferred = desktops.find((name) => /^hyprland\.desktop$/i.test(name)) ?? desktops[0];
	const sessionName = preferred !== undefined ? preferred.replace(/\.desktop$/i, "") : "hyprland";
	const conf = `[Autologin]\nUser=${GUEST_USERNAME}\nSession=${sessionName}\n`;
	note(rec, "provision", `sddm route: /etc/sddm.conf.d/99-openhammer-autologin.conf = ${JSON.stringify(conf)}`);
	const put = await sshRun(GUEST_USERNAME, port, keyPath, "cat > /tmp/openhammer-sddm-autologin.conf", {
		stdin: conf,
	});
	note(rec, "provision", `cat > /tmp/openhammer-sddm-autologin.conf: rc=${put.code} ${oneLine(put.stderrTail, 150)}`);
	const install = await sudoCapture(
		port,
		keyPath,
		password,
		"install -D -m 644 /tmp/openhammer-sddm-autologin.conf /etc/sddm.conf.d/99-openhammer-autologin.conf",
	);
	note(rec, "provision", `sudo install conf: rc=${install.code} ${oneLine(install.out || install.err, 200)}`);
	// sddm gates passwordless autologin on `autologin` group membership (Arch wiki).
	const group = await sudoCapture(
		port,
		keyPath,
		password,
		`sh -c 'groupadd -f autologin && usermod -aG autologin ${GUEST_USERNAME}'`,
	);
	note(rec, "provision", `sudo autologin group: rc=${group.code} ${oneLine(group.out || group.err, 200)}`);
	const restart = await sudoCapture(port, keyPath, password, "systemctl restart sddm.service");
	note(
		rec,
		"provision",
		`sudo systemctl restart sddm.service: rc=${restart.code} ${oneLine(restart.out || restart.err, 200)}`,
	);
	if (restart.code !== 0) {
		rec.findings.push("sddm autologin provisioning: restart failed");
	}
}

// --- provisioning route B: no greeter — getty autologin + profile exec of Hyprland ---

const GETTY_DROP_IN = `[Service]\nExecStart=\nExecStart=-/usr/bin/agetty --autologin ${GUEST_USERNAME} --noclear %I $TERM\n`;

const HYPRLAND_PROFILE_GUARD = [
	"# openhammer-autologin: start Hyprland on tty1 logins (vm-spike matrix)",
	'if [ "$(tty)" = "/dev/tty1" ] && [ -z "$WAYLAND_DISPLAY" ] && command -v Hyprland >/dev/null 2>&1; then',
	"\texec Hyprland",
	"fi",
].join("\n");

async function provisionGettyAutologin(port: number, keyPath: string, password: string, rec: Recorder): Promise<void> {
	note(
		rec,
		"provision",
		`getty route: /etc/systemd/system/getty@tty1.service.d/90-openhammer-autologin.conf = ${JSON.stringify(GETTY_DROP_IN)}`,
	);
	const disable = await sudoCapture(port, keyPath, password, "systemctl disable --now display-manager");
	note(
		rec,
		"provision",
		`sudo systemctl disable --now display-manager: rc=${disable.code} ${oneLine(disable.out || disable.err, 200)}`,
	);
	const put = await sshRun(GUEST_USERNAME, port, keyPath, "cat > /tmp/openhammer-getty-autologin.conf", {
		stdin: GETTY_DROP_IN,
	});
	note(rec, "provision", `cat > /tmp/openhammer-getty-autologin.conf: rc=${put.code} ${oneLine(put.stderrTail, 150)}`);
	const install = await sudoCapture(
		port,
		keyPath,
		password,
		"install -D -m 644 /tmp/openhammer-getty-autologin.conf /etc/systemd/system/getty@tty1.service.d/90-openhammer-autologin.conf",
	);
	note(rec, "provision", `sudo install drop-in: rc=${install.code} ${oneLine(install.out || install.err, 200)}`);
	const reload = await sudoCapture(port, keyPath, password, "systemctl daemon-reload");
	note(rec, "provision", `sudo systemctl daemon-reload: rc=${reload.code}`);
	const present = await capture(port, keyPath, "grep -q openhammer-autologin ~/.zprofile");
	if (present.code !== 0) {
		const append = await sshRun(GUEST_USERNAME, port, keyPath, "cat >> ~/.zprofile", {
			stdin: `${HYPRLAND_PROFILE_GUARD}\n`,
		});
		note(
			rec,
			"provision",
			`append Hyprland guard to ~/.zprofile: rc=${append.code} guard=${JSON.stringify(HYPRLAND_PROFILE_GUARD)}`,
		);
	} else {
		note(rec, "provision", "~/.zprofile already carries the openhammer-autologin guard");
	}
	const restart = await sudoCapture(port, keyPath, password, "systemctl restart getty@tty1.service");
	note(
		rec,
		"provision",
		`sudo systemctl restart getty@tty1.service: rc=${restart.code} ${oneLine(restart.out || restart.err, 200)}`,
	);
	if (restart.code !== 0) {
		rec.findings.push("getty autologin provisioning: restart failed");
	}
}

// --- measurement (c): grim availability, capture, size vs the response backstop ---

interface GrimResult {
	readonly size: number;
	readonly form: string;
	readonly info: PngInfo;
}

async function measureGrim(
	port: number,
	keyPath: string,
	password: string,
	sessionDir: string,
	waylandSockets: readonly string[],
	rec: Recorder,
): Promise<GrimResult | undefined> {
	const have = await capture(port, keyPath, "command -v grim");
	if (have.code !== 0 || have.out === "") {
		note(rec, "grim", "command -v grim: absent — installing with sudo pacman -S --noconfirm grim");
		let install = await sudoCapture(port, keyPath, password, "pacman -S --noconfirm grim");
		if (install.code !== 0) {
			note(
				rec,
				"grim",
				`pacman -S rc=${install.code} ${oneLine(install.out || install.err, 300)} — retrying with -Sy`,
			);
			install = await sudoCapture(port, keyPath, password, "pacman -Sy --noconfirm grim");
		}
		const check = await capture(port, keyPath, "command -v grim");
		if (check.code !== 0 || check.out === "") {
			rec.findings.push(`grim install failed (last rc=${install.code})`);
			note(rec, "grim", `install FAILED: rc=${install.code} ${oneLine(install.out || install.err, 300)}`);
			return undefined;
		}
		note(rec, "grim", `installed: ${check.out}`);
	} else {
		note(rec, "grim", `command -v grim: ${have.out}`);
	}

	// A bare ssh shell has no session env; the retry pins the compositor's runtime dir +
	// discovered socket. Record which form worked — that's the product's ssh recipe.
	const forms = [
		"grim /tmp/oh-shot.png",
		...waylandSockets.map(
			(socket) => `XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=${socket} grim /tmp/oh-shot.png`,
		),
	];
	if (waylandSockets.length === 0) {
		forms.push("XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-1 grim /tmp/oh-shot.png");
	}
	for (const form of forms) {
		const attempt = await sshRun(GUEST_USERNAME, port, keyPath, form);
		if (attempt.code !== 0) {
			note(
				rec,
				"grim",
				`capture rc=${attempt.code} via: ${form} — ${oneLine(attempt.stderrTail || attempt.stdoutTail, 250)}`,
			);
			continue;
		}
		const stat = await capture(port, keyPath, "stat -c %s /tmp/oh-shot.png");
		const size = Number(stat.out);
		if (!Number.isInteger(size) || size <= 0) {
			note(
				rec,
				"grim",
				`capture rc=0 via: ${form} but stat failed: rc=${stat.code} ${oneLine(stat.out || stat.err, 150)}`,
			);
			continue;
		}
		const localPath = join(sessionDir, "grim-shot.png");
		const pulled = await run("scp", [
			"-i",
			keyPath,
			"-P",
			String(port),
			"-o",
			"StrictHostKeyChecking=no",
			"-o",
			"UserKnownHostsFile=/dev/null",
			"-o",
			"ConnectTimeout=10",
			`${GUEST_USERNAME}@127.0.0.1:/tmp/oh-shot.png`,
			localPath,
		]);
		const info = pngInspect(localPath);
		const percent = Math.round((size / MAX_RESPONSE_BYTES) * 100);
		note(rec, "grim", `capture OK via: ${form}`);
		note(
			rec,
			"grim",
			`/tmp/oh-shot.png: ${size} bytes (${percent}% of the ${MAX_RESPONSE_BYTES}-byte MAX_RESPONSE_BYTES backstop); pulled to ${localPath} (${pulled.code === 0 ? pngDescribe(info) : `scp rc=${pulled.code} ${oneLine(pulled.stderrTail, 150)}`})`,
		);
		return { size, form, info };
	}
	rec.findings.push("grim capture failed in every form tried");
	return undefined;
}

// --- poll for Hyprland after a provisioning attempt (bounded) ---

async function waitHyprland(port: number, keyPath: string, budgetMs: number): Promise<boolean> {
	const deadline = Date.now() + budgetMs;
	for (;;) {
		const exact = await capture(port, keyPath, `pgrep -u ${GUEST_USERNAME} -x Hyprland`);
		if (exact.code === 0 && exact.out !== "") {
			return true;
		}
		if (Date.now() >= deadline) {
			return false;
		}
		await sleep(AUTOLOGIN_POLL_MS);
	}
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

	const goldenSession: GoldenSession | undefined =
		flags.installSession !== undefined
			? isGoldenSession(flags.installSession)
				? goldenSessionAt(flags.installSession)
				: undefined
			: findGoldenSession(dirs.sessions);
	if (goldenSession === undefined) {
		throw new Error(
			flags.installSession !== undefined
				? `matrix: --install-session ${flags.installSession} is not a golden session (needs disk.qcow2 + OVMF_VARS.4m.fd + luks-or-sudo-password.txt)`
				: `matrix: no install session found under ${dirs.sessions} (pass --install-session <path>)`,
		);
	}
	const diskBefore = fileFingerprint(goldenSession.disk);
	const varsBefore = fileFingerprint(goldenSession.vars);
	const password = readFileSync(goldenSession.passwordFile, "utf8").trim();
	const keypair = await ensureSshKeypair(dirs.root);

	const startedAt = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `matrix-${flags.config}-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	// Overlay boot pattern: fresh qcow2 with the golden disk as backing file + a COPY of
	// the install session's VARS (it holds the Boot0004 "Limine" boot entry). The golden
	// stays read-only-through-the-overlay; every write lands in this session's overlay.
	const overlayPath = join(sessionDir, "disk.qcow2");
	const img = await run(QEMU_IMG, ["create", "-f", "qcow2", "-b", goldenSession.disk, "-F", "qcow2", overlayPath]);
	if (img.code !== 0) {
		throw new Error(`matrix: qemu-img create overlay exited ${img.code}: ${img.stderrTail.trim()}`);
	}
	copyFileSync(goldenSession.vars, join(sessionDir, "OVMF_VARS.4m.fd"));

	const argv = matrixQemuArgs({ name, sessionDir, config: flags.config });
	console.log(`matrix: golden ${goldenSession.dir}`);
	console.log(`matrix: session ${sessionDir}`);
	console.log(`matrix: qemu ${JSON.stringify(argv)}`);

	const rec: Recorder = { lines: [], findings: [], failures: [] };
	note(rec, "overlay", `qemu-img create -f qcow2 -b ${goldenSession.disk} -F qcow2 ${overlayPath}`);
	note(rec, "golden", `before: ${describeFingerprint(diskBefore)} / ${describeFingerprint(varsBefore)}`);
	for (const fact of await collectHostFacts()) {
		note(rec, "host-facts", fact);
	}

	const stderrPath = join(sessionDir, "qemu.stderr");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(QEMU_BIN, argv, { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	if (child.pid === undefined) {
		throw new Error("matrix: spawn qemu failed");
	}
	console.log(`matrix: qemu pid ${child.pid}`);

	let qmp: QmpClient | undefined;
	try {
		const socketPath = join(sessionDir, "qmp.sock");
		if (!(await waitForFile(socketPath, 15_000))) {
			if (hasExited(child)) {
				throw new Error(
					`matrix: qemu exited before creating the QMP socket; stderr: ${await tailText(stderrPath, 4096)}`,
				);
			}
			throw new Error(`matrix: no QMP socket at ${socketPath} within 15 s`);
		}
		qmp = await connectQmpWithRetry(socketPath, CONNECT_RETRY_ATTEMPTS);
		const client = qmp;
		console.log(`matrix: qmp greeting ${qmp.greetingLine}`);

		const pidfile = readFileSync(join(sessionDir, "qemu.pid"), "utf8").trim();
		const pidfileNote =
			Number(pidfile) === child.pid
				? `matches pid ${child.pid}`
				: `MISMATCH: pidfile ${pidfile} vs child ${child.pid}`;
		console.log(`matrix: pidfile ${pidfileNote}`);

		// --- readiness: serial login prompt + usernet port + the 22b ssh double round-trip
		const serialPath = join(sessionDir, "serial.log");
		let serialSeenAt: number | undefined;
		let serialBytesAtSeen = 0;
		let hostPort: number | undefined;
		let usernetRow: string | undefined;
		let readyAt: number | undefined;
		let gateFailure: string | undefined;
		let candidateConfirmed = false;
		const deadline = Date.now() + READY_BUDGET_MS;
		while (!stopRequested && Date.now() < deadline && readyAt === undefined && gateFailure === undefined) {
			if (hasExited(child)) {
				gateFailure = `qemu exited during readiness (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
				break;
			}
			if (serialSeenAt === undefined) {
				const tail = await tailText(serialPath, SERIAL_TAIL_BYTES);
				if (tail.includes(SERIAL_LOGIN_PROMPT)) {
					serialSeenAt = Date.now();
					serialBytesAtSeen = statSync(serialPath, { throwIfNoEntry: false })?.size ?? 0;
					note(
						rec,
						"ready",
						`serial login prompt after ${((serialSeenAt - startedAt) / 1000).toFixed(1)} s (serial.log ${serialBytesAtSeen} bytes)`,
					);
				}
			}
			if (hostPort === undefined) {
				try {
					const table = await client.humanMonitorCommand("info usernet");
					const found = parseUsernetHostPort(table);
					if (found !== undefined) {
						hostPort = found.port;
						usernetRow = found.row;
						note(rec, "ready", `usernet: ${found.row} → host port ${found.port}`);
					}
				} catch {
					// retry next tick
				}
			}
			if (serialSeenAt !== undefined && hostPort !== undefined && !candidateConfirmed) {
				for (const user of SSH_USER_CANDIDATES) {
					if (await sshExecTrue(user, hostPort, keypair.privateKeyPath)) {
						note(rec, "ready", `ssh: first answer user=${user} port=${hostPort}`);
						await sleep(CONFIRM_GAP_MS);
						if (hasExited(child)) {
							gateFailure = `qemu exited during the confirm gap (exitCode=${child.exitCode})`;
							break;
						}
						if (await sshExecTrue(user, hostPort, keypair.privateKeyPath)) {
							candidateConfirmed = true;
							readyAt = Date.now();
							note(
								rec,
								"ready",
								`ssh: CONFIRMED user=${user} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart) after ${((readyAt - startedAt) / 1000).toFixed(1)} s`,
							);
						}
						break;
					}
				}
			}
			if (readyAt === undefined && gateFailure === undefined) {
				await sleep(READY_POLL_MS);
			}
		}
		if (stopRequested && readyAt === undefined && gateFailure === undefined) {
			gateFailure = "interrupted by signal";
		}
		if (readyAt === undefined && gateFailure === undefined) {
			gateFailure = `not ready within the ${READY_BUDGET_MS / 60_000} min budget (serial prompt ${serialSeenAt === undefined ? "never seen" : "seen"}, port ${hostPort ?? "never learned"})`;
		}
		if (gateFailure !== undefined) {
			rec.failures.push(gateFailure);
		}

		// --- the gate's measurements
		let hyprlandRunning = false;
		let grimResult: GrimResult | undefined;
		const screendumps: string[] = [];
		if (readyAt !== undefined) {
			const port = hostPort;
			if (port === undefined) {
				throw new Error("matrix: ready without a host port — impossible state");
			}
			const state = await measureHyprland(port, keypair.privateKeyPath, rec);
			hyprlandRunning = state.running;
			if (!hyprlandRunning) {
				rec.findings.push("Hyprland not running at first measurement");
				await inspectGreeter(port, keypair.privateKeyPath, rec);
			}

			// screendump #1 at ~30 s after ready
			await sleepUntil(readyAt + 30_000);
			const shot1 = await qmpScreendump(client, join(sessionDir, "shot-1.png"), rec);
			screendumps.push(`shot-1.png @+30 s: ${pngDescribe(shot1)}`);

			grimResult = await measureGrim(port, keypair.privateKeyPath, password, sessionDir, state.waylandSockets, rec);

			// screendump #2 at ~120 s after ready
			await sleepUntil(readyAt + 120_000);
			const shot2 = await qmpScreendump(client, join(sessionDir, "shot-2.png"), rec);
			screendumps.push(`shot-2.png @+120 s: ${pngDescribe(shot2)}`);

			// autologin provisioning when nothing started a session — then re-measure
			if (!hyprlandRunning && !stopRequested) {
				const greeter = await inspectGreeter(port, keypair.privateKeyPath, rec);
				if (greeter === "sddm") {
					await provisionSddmAutologin(port, keypair.privateKeyPath, password, rec);
				} else {
					note(
						rec,
						"provision",
						greeter === undefined
							? "no greeter binary found — getty-autologin route"
							: `greeter ${greeter} present (non-sddm recipe not implemented) — getty-autologin route`,
					);
					await provisionGettyAutologin(port, keypair.privateKeyPath, password, rec);
				}
				note(
					rec,
					"provision",
					`settling ${AUTOLOGIN_SETTLE_MS / 1000} s + polling up to ${AUTOLOGIN_POLL_BUDGET_MS / 1000} s for Hyprland`,
				);
				await sleep(AUTOLOGIN_SETTLE_MS);
				hyprlandRunning = await waitHyprland(port, keypair.privateKeyPath, AUTOLOGIN_POLL_BUDGET_MS);
				const after = await measureHyprland(port, keypair.privateKeyPath, rec);
				note(rec, "hyprland", `after provisioning: ${hyprlandRunning ? "STARTED" : "still not started"}`);
				if (hyprlandRunning) {
					const shot3 = await qmpScreendump(client, join(sessionDir, "shot-3.png"), rec);
					screendumps.push(`shot-3.png post-provision: ${pngDescribe(shot3)}`);
					if (grimResult === undefined) {
						grimResult = await measureGrim(
							port,
							keypair.privateKeyPath,
							password,
							sessionDir,
							after.waylandSockets,
							rec,
						);
					}
				}
			}
			for (const line of screendumps) {
				note(rec, "screendump", line);
			}

			// hold floor: keep the desktop up (settle, wayland animations) before teardown
			await sleepUntil(readyAt + flags.holdSeconds * 1000);
		}
		note(rec, "gate", `hyprland=${hyprlandRunning ? "STARTED" : "NOT-STARTED"}`);
		note(
			rec,
			"gate",
			`screendumps=${screendumps.length > 0 ? screendumps.length : "none"}; ${oneLine(screendumps.join(" ; "), 400)}`,
		);
		note(
			rec,
			"gate",
			`grim=${
				grimResult !== undefined
					? `${grimResult.size} bytes via ${grimResult.form} (${Math.round((grimResult.size / MAX_RESPONSE_BYTES) * 100)}% of the ${MAX_RESPONSE_BYTES}-byte backstop)`
					: "FAILED"
			}`,
		);

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		const ladder = await shutdownLadder(child, qmp);
		assertProcessGone(child);
		console.log(`matrix: shutdown path ${ladder.path} (${ladder.detail})`);

		const serialStat = statSync(serialPath, { throwIfNoEntry: false });
		const diskAfter = fileFingerprint(goldenSession.disk);
		const varsAfter = fileFingerprint(goldenSession.vars);
		const goldenOk = fingerprintsEqual(diskBefore, diskAfter) && fingerprintsEqual(varsBefore, varsAfter);
		if (!goldenOk) {
			rec.failures.push(
				"golden install session mutated during the run — the overlay was supposed to absorb every write",
			);
		}

		if (ladder.path === "sigkill") {
			rec.failures.push("qemu only died to SIGKILL");
		}

		const logLines = [
			`# ${name} (overlay boot of ${goldenSession.name})`,
			`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
			`golden: ${goldenSession.dir}`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			`usernet row: ${usernetRow ?? "NEVER PARSED"}`,
			`serial.log: ${serialStat === undefined ? "MISSING" : `${serialStat.size} bytes`}`,
			...rec.lines,
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`golden after: ${describeFingerprint(diskAfter)} / ${describeFingerprint(varsAfter)} — ${goldenOk ? "unchanged" : "MUTATED"}`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`findings: ${rec.findings.length === 0 ? "none" : rec.findings.join("; ")}`,
			`failures: ${rec.failures.length === 0 ? "none" : rec.failures.join("; ")}`,
		];
		const runLog = join(dirs.runs, `${stamp}-matrix-${flags.config}.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`matrix: run log ${runLog}`);

		if (rec.failures.length > 0) {
			console.error(`matrix: GATE FAILED for ${flags.config}: ${rec.failures.join("; ")}`);
			return stopRequested ? 130 : 1;
		}
		console.log(`matrix: measurements complete for ${flags.config} (session kept at ${sessionDir})`);
		return stopRequested ? 130 : 0;
	} finally {
		if (!hasExited(child)) {
			console.error("matrix: error path — running the stop ladder before exit");
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
