/**
 * The `openhammer vm install` runner (spec 26c): build the credential-free golden Omarchy
 * image with ZERO human input — pinned ISO + cidata + blank 40G qcow2, disk-first headless
 * boot, ssh readiness gate, clean poweroff. Promoted from scripts/vm-spike/install.ts, the
 * runner that built both real goldens (22-measured gates 2/3); the PRODUCT differs from the
 * spike in exactly the ways recorded below.
 *
 * THE GATE (the spike's proven semantics, kept verbatim): TWO successful `ssh … true`
 * round-trips 10 s apart over the hostfwd port. The installer REBOOTS ITSELF mid-flight
 * (disk-first boot order hands the installed Limine ESP the next boot), and a single ssh
 * answer can be the installer environment's own sshd dying with the installer — one answer
 * proves nothing, two answers 10 s apart prove the INSTALLED system's sshd. The spike's
 * user CANDIDATE list (`sandbox`, `root`, `arch`) is GONE in the product: guest-config
 * (26a) names the exact user the cidata creates, and 22b measured that user answering —
 * the product KNOWS its user; polling phantom users would only add noise to the run log.
 *
 * SERIAL IS NOT THE GATE (22-measured finding 6): the installed system's serial carries
 * the login prompt (~20 s in), and the LIVE ISO's serial carries OVMF/BdsDxe only — but
 * ssh is the readiness signal (the spike's matrix gates leaned on serial; its install gate
 * was ssh-only, and that is correct here too). The serial log is still kept as EVIDENCE:
 * every failure names its path.
 *
 * THE CLEAN-POWEROFF RULE (finding 2 — the corrupt-golden lesson): the installed system is
 * powered down via guest `sudo -S systemctl poweroff` (the recovery password on stdin),
 * waited out ≤180 s. A QMP `quit` on a live guest with btrfs mounted rw is a POWER CUT —
 * the first golden lost its sshd host keys exactly that way (0-byte key files: btrfs had
 * the metadata committed but not the data; sshd then dies "no hostkeys available" on every
 * boot, and sshdgenkeys won't regen because its ConditionPathExists=!key only fires on
 * ABSENT files). The stop ladder (24d) runs ONLY as the recorded fallback; a ladder that
 * ends in SIGKILL is a FAILURE — that disk cannot be trusted as a golden.
 *
 * THE RUN LOG lives at `<session>/install.log` (NOT the spike's shared `runs/` dir): the
 * product's session dir is self-contained — the VmDirs tree has no `runs/`, and an install
 * attempt's evidence belongs beside its disk, its serial log, and its recovery password.
 *
 * SINGLE-FLIGHT (spec 26/28, the install-side guard — the full VmService lock is spec 27's):
 * `install` refuses when any qemu.pid under `<sessions>/` names a live OUR-qemu process
 * (session.ts's isOurQemu verification — never a recycled PID). The refusal is BUILT here
 * ({@link activeSessionRefusal}) and shared with manage.ts's reset/gc — one message, so the
 * CLI stderr and the dashboard's inline flash can never drift — and it names the ESCAPE
 * (spec 28 matrix rows 4/5: a lasting stop is mode `off` + restart; the dashboard's
 * Sandbox → Stop sandbox tears down now).
 *
 * REBUILD WARNING (spec 28, matrix row 5's second half): when a golden already exists on
 * disk, THIS run is a rebuild — legitimate (spec 26's upgrade posture), so it proceeds,
 * but only after ONE pre-flight WARNING line: rebuilding invalidates retained overlays
 * (the recovery path), and `openhammer vm reset` is the clean-slate alternative. The probe
 * ({@link newestGoldenId}) is golden EXISTENCE — the doctor's dir-level notion —
 * deliberately NOT the dashboard Install-row's bootability probe
 * (`goldenManifestExists`): a corrupt-manifest golden is exactly the tree `vm list` tells
 * the operator to rebuild, and the warning's subject is displacing a prior golden, not
 * bootability (preflight check 5 stays the boot path's business).
 *
 * Error model: process layer, not a tool. Expected failures THROW with actionable evidence
 * (disk-growth samples, status, serial + run log paths, stderr tail); the CLI boundary maps
 * them to exit 1. The encrypted variant (the spike's `--encrypt` serial-evidence gate) is
 * deliberately NOT here: the product default is the unencrypted golden (resolved open
 * question 11) and the encrypted chain arrives with spec 24's unlock work.
 */
import { copyFileSync, type Dirent, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CaptureResult, captureOnTeardown } from "../capture.ts";
import { OVMF_VARS, qemuBootArgs } from "../qemu/args.ts";
import {
	QEMU_IMG_BIN,
	type QemuHandle,
	type StartQemuOptions,
	type StopOutcome,
	type StopQemuOptions,
	startQemu as startQemuReal,
	stopQemu as stopQemuReal,
} from "../qemu/process.ts";
import type { QmpClient } from "../qmp/client.ts";
import {
	ensureVmDir,
	isOurQemu,
	type ProcIdentity,
	type ReadProc,
	type RunQemuImg,
	resolveVmDirs,
	type VmDirs,
} from "../session.ts";
import { discoverSshPort as discoverSshPortReal } from "../usernet.ts";
import {
	type BinRunResult,
	buildCidata as buildCidataReal,
	type CidataBuild,
	type CidataInput,
	DISK_BYTES,
} from "./cidata.ts";
import { loadGuestConfig } from "./guest-config.ts";
import { ensureIso as ensureIsoReal, ISO_SHA256, ISO_URL, type IsoState, runBinDefault } from "./iso.ts";

// ---- tunables (the spike's constants, promoted) ----

/**
 * The boot budget, minutes. 45 is deliberately generous: the measured reality is ~128–161 s
 * wall-clock (22-measured gate 2), but this bounds the WHOLE poll (port discovery + ssh
 * confirm + reboot window) on a cold cache or a loaded host, not the happy path.
 */
export const DEFAULT_BUDGET_MINUTES = 45;

/** The readiness poll cadence (the spike's SSH_POLL_MS). */
export const SSH_POLL_MS = 10_000;

/** The two-round-trips gate's confirm gap (the spike's CONFIRM_GAP_MS — see the module header). */
export const CONFIRM_GAP_MS = 10_000;

/** Observability sampling cadence: disk actual-size + query-status every 60 s (the spike's). */
export const OBSERVE_INTERVAL_MS = 60_000;

/** How long the guest gets to actually exit after `systemctl poweroff` (the spike's 180 s). */
export const POWEROFF_WAIT_MS = 180_000;

/** The poweroff exit-wait poll cadence (the spike used a single setTimeout race; a poll is clock-injectable). */
export const POWEROFF_POLL_MS = 1_000;

// ---- the external seams ----

/** One disk observability sample (the spike's DiskSample — qemu-img info's two numbers). */
export interface DiskSample {
	readonly virtualSize: number;
	readonly actualSize: number;
}

/** The qemu-img info -U --output=json sampler (the spike's diskSample, promoted). */
export type DiskInfo = (diskPath: string) => Promise<DiskSample | undefined>;

/**
 * The install-time ssh exec: the spike's runtime.ts sshRun shape. This is deliberately NOT
 * 25a's pinned SshTarget transport — during install there IS no host key to pin: the live
 * ISO's installer sshd and the installed system's sshd have DIFFERENT freshly-generated
 * keys across the self-reboot (that identity change is exactly why the gate needs two round
 * trips), so any pin captured mid-install would be wrong minutes later. The pin begins at
 * provision time (the next box captures the installed system's key into the golden
 * manifest). Until then: StrictHostKeyChecking=no + UserKnownHostsFile=/dev/null +
 * BatchMode + `-F /dev/null` (the one deliberate addition over the spike's argv — no user
 * or system ssh config contributes anything; the 25a argument) on loopback only.
 */
export type InstallSshExec = (
	user: string,
	port: number,
	keyPath: string,
	command: string,
	options?: { readonly stdin?: string },
) => Promise<BinRunResult>;

/** A session whose pidfile names a live, verified-ours QEMU — the single-flight guard's hit. */
export interface ActiveSession {
	readonly sessionDir: string;
	readonly pid: number;
}

/** The pid-scan seam (default: {@link scanActiveVmSessions} over the resolved tree). */
export type ScanActiveSessions = () => Promise<ActiveSession[]>;

/** What `capture` writes — opaque to this module (evidence, not control flow). */
export type InstallCapture = (
	paths: { readonly serialPath: string; readonly debugDir: string },
	handle: Pick<QemuHandle, "stderrTail">,
) => Promise<CaptureResult>;

/**
 * Injection seams for EVERYTHING external (the box contract: defaults = the real ones). The
 * readiness loop is fully deterministic under fakes: `sleep` advances nothing on its own,
 * `now` is the clock, and tests drive both.
 */
export interface InstallDeps {
	/** Override the HOME the vm tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the ISO ensure (default: iso.ts over the resolved dirs, log threaded). */
	readonly ensureIso?: (dirs: VmDirs) => Promise<IsoState>;
	/** Override the cidata build (default: 26b's real generator + the loaded guest config). */
	readonly buildCidata?: (input: CidataInput) => Promise<CidataBuild>;
	/** Override the QEMU spawn+connect (default: 24d's startQemu). */
	readonly startQemu?: (argv: readonly string[], opts: StartQemuOptions) => Promise<QemuHandle>;
	/** Override the stop ladder (default: 24d's stopQemu). */
	readonly stopQemu?: (handle: QemuHandle, opts?: StopQemuOptions) => Promise<StopOutcome>;
	/** Override the hostfwd port discovery (default: 25d's discoverSshPort, own retries). */
	readonly discoverSshPort?: (qmp: Pick<QmpClient, "humanMonitorCommand">) => Promise<number>;
	/** Override the install ssh exec (default: the spike's argv via runBinDefault). */
	readonly sshExec?: InstallSshExec;
	/** Override the disk sampler (default: qemu-img info -U --output=json). */
	readonly diskInfo?: DiskInfo;
	/** Override the teardown debug capture (default: capture.ts's captureOnTeardown). */
	readonly capture?: InstallCapture;
	/** Override every sleep (tests: no-op or clock-advancing). Default: real setTimeout. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Override the clock (tests script the budget). Default: Date.now. */
	readonly now?: () => number;
	/** The progress line sink (the CLI passes its stdout). Default: console.log. */
	readonly log?: (line: string) => void;
	/** Override the single-flight pid scan (tests script a hit or a miss). */
	readonly scanActiveSessions?: ScanActiveSessions;
	/**
	 * Override the rebuild warning's golden-existence probe (spec 28, matrix row 5;
	 * default: {@link newestGoldenId} over the resolved tree). Tests script a hit (the
	 * WARNING line fires, the run proceeds) or a miss (a fresh build, no warning).
	 */
	readonly newestGoldenId?: () => string | null;
	/** Override the pristine OVMF VARS template copied into the session (default: args.ts's). */
	readonly varsTemplate?: string;
	/** Override the qemu-img runner (default: runBinDefault over QEMU_IMG_BIN). */
	readonly runQemuImg?: RunQemuImg;
}

export interface InstallOptions {
	/** The boot budget in minutes (default {@link DEFAULT_BUDGET_MINUTES}; must be finite > 0). */
	readonly budgetMinutes?: number;
	/** The session name (default `build-<stamp>`; a single safe path segment). */
	readonly sessionName?: string;
}

/** How the installed system was powered down — the result records which path won. */
export type InstallShutdownPath = "guest-poweroff" | StopOutcome["path"];

export interface InstallResult {
	/** The self-contained install session dir (disk, serial log, recovery password, install.log). */
	readonly sessionDir: string;
	readonly wallClockSeconds: number;
	/** Final qemu-img numbers; 0 means unmeasured (qemu-img info failed — noted in the run log). */
	readonly diskVirtualBytes: number;
	readonly diskActualBytes: number;
	readonly shutdownPath: InstallShutdownPath;
}

// The session id guard (session.ts's SESSION_ID_PATTERN posture — the name is a path segment
// joined unsanitized, and the cidata generator enforces the same shape on its side).
const INSTALL_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const RECOVERY_FILE = "luks-or-sudo-password.txt";
const DISK_FILE = "disk.qcow2";
const STDERR_FILE = "qemu.stderr";
const LOG_FILE = "install.log";
const VARS_FILE = "OVMF_VARS.4m.fd";
const DEBUG_DIR = "debug";
const PID_FILE = "qemu.pid";

// The golden-dir shape (manage.ts/sections.ts/preflight.ts's restated names — the scan
// below is the rebuild probe's own restate; see its comment for why it cannot import).
const GOLDEN_PREFIX = "golden-";
const MANIFEST_FILE = "manifest.json";

const sleepDefault = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** The default {@link InstallDeps.diskInfo} — the spike's diskSample, verbatim: -U force-shares past QEMU's write lock, undefined on any failure. */
const diskInfoDefault: DiskInfo = async (diskPath) => {
	const result = await runBinDefault(QEMU_IMG_BIN, ["info", "-U", "--output=json", diskPath]);
	if (result.code !== 0) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(result.stdoutTail);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) {
		return undefined;
	}
	const virtualSize = (parsed as Record<string, unknown>)["virtual-size"];
	const actualSize = (parsed as Record<string, unknown>)["actual-size"];
	if (typeof virtualSize !== "number" || typeof actualSize !== "number") {
		return undefined;
	}
	return { virtualSize, actualSize };
};

/** The default {@link InstallDeps.sshExec}: ssh over the spike's install argv (see {@link InstallSshExec}). */
const sshExecDefault: InstallSshExec = (user, port, keyPath, command, options) =>
	runBinDefault(
		"ssh",
		[
			"-F",
			"/dev/null",
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

// The /proc reader for the single-flight scan — session.ts's readProcDefault posture,
// restated here because session.ts keeps its own private (the sweep's); consolidate when
// spec 27's service extracts a shared process-identity module.
const readProcDefault: ReadProc = (pid) => {
	let comm: string | undefined;
	try {
		comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
	} catch {
		return {}; // ENOENT — the process is gone
	}
	let cmdline: string | undefined;
	try {
		cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
	} catch {
		// cmdline unreadable — comm-only verification
	}
	return { comm, cmdline };
};

/**
 * Scan every `qemu.pid` under `<sessions>/` for LIVE OUR-qemu processes: read each pidfile, verify the
 * pid through /proc (`isOurQemu` — comm prefix + cmdline; never trust a recycled PID), and
 * report every hit. Unreadable/garbage pidfiles and dead pids are misses, not errors — the
 * sweep (session.ts) OWNS reclamation; this only answers "is anything running now".
 */
export async function scanActiveVmSessions(
	dirs: VmDirs,
	deps: { readonly readProc?: ReadProc } = {},
): Promise<ActiveSession[]> {
	const readProc = deps.readProc ?? readProcDefault;
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(dirs.sessions, { withFileTypes: true });
	} catch {
		return []; // no sessions root — nothing can be active
	}
	const active: ActiveSession[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue; // stray files in sessions/ are not sessions
		}
		const sessionDir = join(dirs.sessions, entry.name);
		let pidText: string | undefined;
		try {
			pidText = readFileSync(join(sessionDir, PID_FILE), "utf8");
		} catch {
			continue; // no pidfile — mid-prepare or not ours to judge (the sweep's posture)
		}
		const pid = Number(pidText.trim());
		if (!Number.isInteger(pid) || pid <= 0) {
			continue; // garbage pidfile — unverifiable is not active
		}
		const identity: ProcIdentity = readProc(pid);
		if (identity.comm !== undefined && isOurQemu(identity)) {
			active.push({ sessionDir, pid });
		}
	}
	return active;
}

/**
 * The single-flight refusal, SHARED by every vm-tree command that must not run under a
 * live session — install (here), reset/gc (manage.ts imports this builder) — so the CLI
 * stderr line and the dashboard's inline flash render the SAME text. The message names
 * the escape, not just the evidence (spec 28, matrix rows 4/5): a lasting stop is mode
 * `off` + restart, and the dashboard's Sandbox → Stop sandbox tears down now.
 */
export function activeSessionRefusal(command: string, active: ActiveSession): Error {
	return new Error(
		`vm ${command}: a VM session is active — stop the session first: mode off + restart, ` +
			`or Sandbox → Stop sandbox — ${active.sessionDir} holds qemu pid ${active.pid}`,
	);
}

// sections.ts's goldenOrderKey, verbatim in shape (the readProcDefault restatement
// precedent): the manifest's builtAt (digits only, so ISO stamps and bare ids compare)
// orders goldens, falling back to the id's trailing `-YYYYMMDD-HHMMSS` stamp. Restated
// here — together with the whole scan below — because the twin
// (config/sections.ts's goldenManifestExists) reads manifests through snapshot.ts's
// readManifest, and snapshot.ts imports THIS module's scanActiveVmSessions: any static
// edge from here toward that layer would be the repo's first circular import
// (AGENTS.md). Consolidate into a shared golden-scan module if snapshot.ts's scan
// import ever moves.
function goldenOrderKey(id: string, builtAt: string | undefined): string {
	if (builtAt !== undefined) {
		return builtAt.replace(/\D/g, "");
	}
	const stamp = /(\d{8}-\d{6})$/.exec(id);
	return stamp === null ? "" : (stamp[1] ?? "").replaceAll("-", "");
}

/**
 * The newest `images/golden-<id>/` dir's id, or `null` when the tree holds none — the
 * rebuild warning's probe (spec 28, matrix row 5). Golden EXISTENCE (doctor's dir-level
 * `vm-golden` notion: a `golden-*` dir under images/), deliberately NOT sections.ts's
 * `goldenManifestExists` bootability probe — see the module header's REBUILD WARNING
 * paragraph. The manifest is read only for its `builtAt` (the sort key; an absent or
 * unreadable one orders by the id stamp instead, sections.ts's fallback) — manifest
 * VALIDITY stays the boot path's business (preflight check 5). Synchronous local
 * probes only; an absent images root is simply `null`.
 */
export function newestGoldenId(homeDir?: string): string | null {
	const imagesDir = resolveVmDirs({ homeDir }).images;
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(imagesDir, { withFileTypes: true });
	} catch {
		return null; // no images root — no goldens, no rebuild
	}
	const goldens: { readonly id: string; readonly key: string }[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(GOLDEN_PREFIX)) continue; // strays are not goldens
		let builtAt: string | undefined;
		try {
			const parsed: unknown = JSON.parse(readFileSync(join(imagesDir, entry.name, MANIFEST_FILE), "utf8"));
			if (typeof parsed === "object" && parsed !== null && "builtAt" in parsed) {
				const value = (parsed as Record<string, unknown>).builtAt;
				if (typeof value === "string") builtAt = value;
			}
		} catch {
			// absent/corrupt manifest — the id's stamp orders instead (the twin's fallback)
		}
		goldens.push({ id: entry.name, key: goldenOrderKey(entry.name, builtAt) });
	}
	goldens.sort((a, b) => {
		if (a.key !== b.key) {
			return a.key < b.key ? 1 : -1;
		}
		return a.id < b.id ? 1 : -1;
	});
	return goldens[0]?.id ?? null;
}

/** The spike's statusState — pull the `status` string out of a query-status return. */
function statusState(returned: unknown): string {
	if (typeof returned === "object" && returned !== null && "status" in returned) {
		const record = returned as { status?: unknown };
		if (typeof record.status === "string") {
			return record.status;
		}
	}
	return `unexpected return: ${JSON.stringify(returned)}`;
}

/**
 * `openhammer vm install` (spec 26c) — the full unattended golden build. See the module
 * header for the gate, the poweroff rule, and the single-flight guard. On failure the
 * session dir is KEPT (disk + serial log + install.log are the diagnosis) and the throw
 * carries the actionable evidence; on success the session dir holds the powered-off
 * installed disk the provision/snapshot boxes consume.
 */
export async function runInstall(deps: InstallDeps = {}, options: InstallOptions = {}): Promise<InstallResult> {
	const budgetMinutes = options.budgetMinutes ?? DEFAULT_BUDGET_MINUTES;
	if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
		throw new Error(`vm install: budgetMinutes must be a positive number (got ${options.budgetMinutes})`);
	}
	const name = options.sessionName ?? `build-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`;
	if (!INSTALL_NAME_PATTERN.test(name)) {
		throw new Error(
			`vm install: session name is not a safe path segment: "${name}" (expected /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)`,
		);
	}

	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const log = deps.log ?? ((line: string) => console.log(line));
	const sleep = deps.sleep ?? sleepDefault;
	const now = deps.now ?? Date.now;

	// Single-flight: a live session and a concurrent install would fight over KVM, the port
	// space, and the sessions tree. Spec 27's VmService owns the real lock; this is the
	// install-side refusal (the shared builder — manage.ts's reset/gc refuse with the
	// same line).
	const scan = deps.scanActiveSessions ?? (() => scanActiveVmSessions(dirs));
	const active = await scan();
	const first = active[0];
	if (first !== undefined) {
		throw activeSessionRefusal("install", first);
	}

	// The rebuild warning (spec 28, matrix row 5): a golden on disk makes THIS run a
	// rebuild — legitimate (the upgrade posture), so it proceeds — but the operator is
	// told the cost first, BEFORE any side effect (the iso/cidata work below): retained
	// overlays are invalidated, and `vm reset` is the clean-slate alternative. One line,
	// never a block.
	const goldenProbe = deps.newestGoldenId ?? (() => newestGoldenId(deps.homeDir));
	const existingGolden = goldenProbe();
	if (existingGolden !== null) {
		log(
			`install: WARNING: a golden already exists (${existingGolden}) — rebuilding invalidates ` +
				"retained overlays (recovery path); consider `openhammer vm reset` first",
		);
	}

	const ensureIsoFn = deps.ensureIso ?? ((d: VmDirs) => ensureIsoReal(d, { log: (line) => log(`iso: ${line}`) }));
	const iso = await ensureIsoFn(dirs);
	log(`iso: ${iso.action} ${iso.path} (${iso.size} bytes, sha256 ${iso.sha256})`);

	const startedAt = now();
	const sessionDir = join(dirs.sessions, name);
	await ensureVmDir(dirs.sessions);
	await ensureVmDir(sessionDir);
	await ensureVmDir(join(sessionDir, DEBUG_DIR));
	const serialPath = join(sessionDir, "serial.log");
	const stderrPath = join(sessionDir, STDERR_FILE);
	const debugDir = join(sessionDir, DEBUG_DIR);
	const diskPath = join(sessionDir, DISK_FILE);
	const recoveryPath = join(sessionDir, RECOVERY_FILE);

	const config = loadGuestConfig(dirs);
	const buildCidataFn = deps.buildCidata ?? ((input: CidataInput) => buildCidataReal(input));
	const cidata = await buildCidataFn({ config, dirs, name, recoveryPath });
	log(`cidata: ${cidata.dir} → ${cidata.isoPath} (${cidata.isoSize} bytes, volid cidata)`);
	log(`cidata: recovery password recorded at ${cidata.recoveryPasswordPath} (0600)`);

	copyFileSync(deps.varsTemplate ?? OVMF_VARS, join(sessionDir, VARS_FILE));
	// The blank disk: the numeric DISK_BYTES constant (qemu-img takes raw byte counts) —
	// literal lockstep with cidata.ts's partition geometry, which is computed for EXACTLY
	// this size ("40G" would parse to the same bytes, but the number cannot drift).
	const runQemuImgFn = deps.runQemuImg ?? ((args: readonly string[]) => runBinDefault(QEMU_IMG_BIN, args));
	const created = await runQemuImgFn(["create", "-f", "qcow2", diskPath, String(DISK_BYTES)]);
	if (created.code !== 0) {
		throw new Error(
			`vm install: qemu-img create exited ${created.code ?? "spawn error"}: ${created.stderrTail.trim()}`,
		);
	}

	const argv = qemuBootArgs({
		name,
		sessionDir,
		disks: { targetDiskPath: diskPath, isoPath: iso.path, cidataIsoPath: cidata.isoPath },
	});
	log(`install: session ${sessionDir}`);
	log(`install: qemu ${JSON.stringify(argv)}`);

	const startQemuFn = deps.startQemu ?? ((a: readonly string[], o: StartQemuOptions) => startQemuReal(a, o));
	const handle = await startQemuFn(argv, { sessionDir, stderrPath });
	log(`install: qemu pid ${handle.pid}`);

	// ---- the readiness loop (the spike's observe loop, promoted; user candidates dropped) ----

	const sshEvents: string[] = [];
	const observations: string[] = [];
	let firstDisk: DiskSample | undefined;
	let lastDisk: DiskSample | undefined;
	let lastStatus = "unknown";
	let hostPort: number | undefined;
	let gatePassed = false;
	let gateFailure: string | undefined;
	let lastSshNote = "not-run";
	const deadline = startedAt + budgetMinutes * 60_000;
	let nextObserveAt = startedAt;

	while (now() < deadline) {
		const exit = handle.exitInfo();
		if (exit !== undefined) {
			gateFailure = `qemu exited mid-install (exitCode=${exit.code} signalCode=${exit.signal})`;
			break;
		}

		if (hostPort === undefined) {
			// discoverSshPort retries internally; a full miss here is retryable on the next
			// tick (an early probe can race the monitor) and bounded by the budget.
			try {
				const discoverFn =
					deps.discoverSshPort ?? ((qmp: Pick<QmpClient, "humanMonitorCommand">) => discoverSshPortReal(qmp));
				hostPort = await discoverFn(handle.qmp);
				sshEvents.push(`usernet: host port ${hostPort}`);
				log(`install: usernet host port ${hostPort}`);
			} catch (error) {
				lastSshNote = `usernet: ${error instanceof Error ? error.message : String(error)}`;
			}
		}

		if (hostPort !== undefined && !gatePassed) {
			const user = config.username; // the ONE poll target — guest-config names the user
			const probe = await sshExecCall(deps, user, hostPort, cidata.privateKeyPath, "true");
			if (probe.code === 0) {
				sshEvents.push(`ssh: first answer user=${user} port=${hostPort}`);
				log(`install: ssh first answer user=${user} port=${hostPort}`);
				await sleep(CONFIRM_GAP_MS);
				const gapExit = handle.exitInfo();
				if (gapExit !== undefined) {
					gateFailure = `qemu exited during the confirm gap (exitCode=${gapExit.code})`;
					break;
				}
				const confirm = await sshExecCall(deps, user, hostPort, cidata.privateKeyPath, "true");
				if (confirm.code === 0) {
					gatePassed = true;
					sshEvents.push(`ssh: CONFIRMED user=${user} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart)`);
					log(`install: ssh CONFIRMED user=${user} — gate passed`);
					break;
				}
				sshEvents.push("ssh: candidate lost its confirm round-trip; polling continues");
			} else {
				lastSshNote = `ssh exit ${probe.code}`;
			}
		}

		if (now() >= nextObserveAt) {
			nextObserveAt = now() + OBSERVE_INTERVAL_MS;
			const diskInfoFn = deps.diskInfo ?? diskInfoDefault;
			const sample = await diskInfoFn(diskPath);
			if (sample !== undefined) {
				if (firstDisk === undefined) {
					firstDisk = sample;
				}
				lastDisk = sample;
				try {
					lastStatus = statusState(await handle.qmp.execute("query-status"));
				} catch (error) {
					lastStatus = `query-status failed: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			const grew = lastDisk === undefined ? 0 : lastDisk.actualSize - (firstDisk?.actualSize ?? lastDisk.actualSize);
			const line =
				`${new Date(now()).toISOString()} disk-actual=${lastDisk?.actualSize ?? "?"} (+${grew}) ` +
				`status=${lastStatus} last=${lastSshNote}`;
			observations.push(line);
			log(`install: ${line}`);
		}

		await sleep(SSH_POLL_MS);
	}
	if (!gatePassed && gateFailure === undefined) {
		gateFailure = `no ssh gate within the ${budgetMinutes} min budget`;
	}

	// ---- shutdown (clean poweroff first — the module header's rule) ----

	const wallClockSeconds = (now() - startedAt) / 1000;
	let poweroffNote = "not attempted";
	if (gatePassed && hostPort !== undefined) {
		const password = readFileSync(cidata.recoveryPasswordPath, "utf8").trim();
		const poweroff = await sshExecCall(
			deps,
			config.username,
			hostPort,
			cidata.privateKeyPath,
			"sudo -S systemctl poweroff",
			{
				stdin: `${password}\n`,
			},
		);
		// rc is recorded, not trusted: poweroff DROPS the connection mid-command (ssh exits
		// 255) — the exit-wait below is the truth.
		poweroffNote = `ssh sudo systemctl poweroff rc=${poweroff.code} ${poweroff.stderrTail.trim()}`;
		log(`install: ${poweroffNote}`);
	}

	let shutdownPath: InstallShutdownPath;
	if (gatePassed && (await waitQemuExit(handle, now, sleep))) {
		shutdownPath = "guest-poweroff";
	} else {
		// Non-clean: capture the evidence BEFORE any kill (capture.ts's contract), then the
		// ladder — the recorded fallback. This arm covers gate failures AND a poweroff that
		// never landed (the result records the ladder path either way). A capture that fails
		// is logged and swallowed: evidence is best-effort, but the ladder is MANDATORY — a
		// capture error must never leave a live QEMU behind (capture.ts's own posture).
		const captureFn = deps.capture ?? ((paths, h) => captureOnTeardown(paths, h));
		try {
			await captureFn({ serialPath, debugDir }, handle);
		} catch (error) {
			log(
				`install: debug capture failed (continuing to the stop ladder): ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const stopQemuFn = deps.stopQemu ?? ((h: QemuHandle, o?: StopQemuOptions) => stopQemuReal(h, o));
		const ladder = await stopQemuFn(handle);
		shutdownPath = ladder.path;
	}
	log(`install: shutdown path ${shutdownPath}`);

	const finalSample = await (deps.diskInfo ?? diskInfoDefault)(diskPath);
	const diskVirtualBytes = finalSample?.virtualSize ?? lastDisk?.virtualSize ?? 0;
	const diskActualBytes = finalSample?.actualSize ?? lastDisk?.actualSize ?? 0;

	const failures: string[] = [];
	if (!gatePassed) {
		failures.push(gateFailure ?? "gate failed");
	}
	if (hostPort === undefined) {
		failures.push("never learned a hostfwd port from info usernet");
	}
	if (shutdownPath === "sigkill") {
		failures.push("qemu only died to SIGKILL — the disk cannot be trusted as a golden (rerun vm install)");
	}

	const growthNote =
		lastDisk === undefined
			? "no disk samples"
			: `disk grew ${lastDisk.actualSize - (firstDisk?.actualSize ?? lastDisk.actualSize)} B ` +
				`(first ${firstDisk?.actualSize ?? "?"} → last ${lastDisk.actualSize})`;
	const logLines = [
		`# ${name} (${ISO_URL} pin, sha256 ${ISO_SHA256}, ${iso.action})`,
		`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
		`guest user: ${config.username} (the only poll target — guest-config names it; the spike's root/arch candidates are gone)`,
		`cidata: ${cidata.dir}`,
		`cidata iso: ${cidata.isoPath} (${cidata.isoSize} bytes, volid cidata)`,
		`recovery password: ${cidata.recoveryPasswordPath}`,
		`argv: ${JSON.stringify(argv)}`,
		`qmp greeting: ${handle.qmp.greetingLine}`,
		`qmp_capabilities: ${JSON.stringify(handle.qmp.capabilitiesReturn)}`,
		...sshEvents.map((line) => `ssh| ${line}`),
		...observations.map((line) => `observe| ${line}`),
		`disk final: virtual=${finalSample?.virtualSize ?? "unmeasured"} actual=${finalSample?.actualSize ?? "unmeasured"}`,
		`gate: ${gatePassed ? `PASSED (user=${config.username})` : "FAILED"}`,
		`poweroff: ${poweroffNote}`,
		`shutdown: ${shutdownPath}`,
		`qemu.stderr tail: ${(await handle.stderrTail()).trim()}`,
		`failures: ${failures.length === 0 ? "none" : failures.join("; ")}`,
	];
	const runLogPath = join(sessionDir, LOG_FILE);
	writeFileSync(runLogPath, `${logLines.join("\n")}\n`);
	log(`install: run log ${runLogPath}`);

	if (failures.length > 0) {
		throw new Error(
			`vm install: ${failures.join("; ")} — evidence: ${growthNote}, last status ${lastStatus}, ` +
				`serial log ${serialPath}, run log ${runLogPath}, session kept at ${sessionDir}, ` +
				`qemu stderr: ${(await handle.stderrTail()).trim()}; ` +
				"plan B is the manual GTK install path — boot with a display and drive the wizard by hand",
		);
	}
	log(
		`install: gate passed — wall-clock ${wallClockSeconds.toFixed(1)} s, user ${config.username}, ` +
			`disk virtual ${diskVirtualBytes} actual ${diskActualBytes}; session left intact at ${sessionDir}`,
	);
	return { sessionDir, wallClockSeconds, diskVirtualBytes, diskActualBytes, shutdownPath };
}

// The ssh seam resolved once per call (the deps object is readonly; a local const keeps the
// call sites short without re-resolving the default per loop tick).
async function sshExecCall(
	deps: InstallDeps,
	user: string,
	port: number,
	keyPath: string,
	command: string,
	options?: { readonly stdin?: string },
): Promise<BinRunResult> {
	const sshExec = deps.sshExec ?? sshExecDefault;
	return sshExec(user, port, keyPath, command, options);
}

// Bounded exit wait on the injected clock: poll exitInfo until it exists or the budget is
// gone. (The spike raced a single setTimeout against the exit promise; a poll composes with
// the injectable now/sleep so the 180 s budget is testable with zero wall clock.)
async function waitQemuExit(
	handle: QemuHandle,
	now: () => number,
	sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
	const deadline = now() + POWEROFF_WAIT_MS;
	while (handle.exitInfo() === undefined) {
		if (now() >= deadline) {
			return false;
		}
		await sleep(POWEROFF_POLL_MS);
	}
	return true;
}
