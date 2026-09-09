// Session dir lifecycle — spec 24's src/vm/session.ts: the ~/.openhammer/vm tree (0700),
// per-session preparation (the golden's qcow2 overlay via qemu-img + the writable OVMF VARS
// copy), and the boot-time stale sweep that reclaims sessions orphaned by a crashed server.
//
// SWEEP SEMANTICS (decided here, load-bearing for spec 27's service):
// - SIGKILL only after /proc verification that the pid is OUR qemu (see isOurQemu) — never
//   a recycled PID. /proc/<pid>/comm truncates at 15 chars, so "qemu-system-x86_64" reads
//   as "qemu-system-x86"; the prefix match plus the cmdline check (when readable) is the
//   evidence, and a mismatch means NOT ours: leave it and report skippedForeign.
// - A KILLED session dir is REMOVED — nothing in it is trusted after a forced kill (the
//   overlay may be torn mid-write). Capture-before-kill (24's capture.ts) is the LIVE
//   teardown path; this sweep is next-boot crash recovery, and by then capture has either
//   already run or the crash was hard enough that nothing in the dir is evidence anyway.
// - A dead pid (ESRCH — no /proc entry) means stale: remove the dir, reclaim the bytes.
// - A dir WITHOUT qemu.pid is LEFT ALONE, with no mtime heuristics: it is either
//   mid-prepare (between mkdir and QEMU writing its pidfile) or not ours to judge. A
//   garbage (non-numeric) pidfile is likewise left alone — unverifiable is not stale.
// - A dir whose pidfile names a LIVE FOREIGN process is KEPT and reported: removing data
//   because a PID got recycled is the one unrecoverable mistake available to a sweeper.
//
// Error model: process layer, not tools. prepareSession rejects (with the qemu-img stderr
// tail on overlay failure — the same ShellResult-to-throw shape as qemu/process.ts); the
// sweep never rejects — it is boot-time best-effort, resilient per session dir, and its
// report is the honest count of what it actually finished.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { OVMF_VARS } from "./qemu/args.ts";
import { QEMU_IMG_BIN } from "./qemu/process.ts";

/** The session-tree root and its subdirs — paths only; creation is on demand (0700). */
export interface VmDirs {
	/** `~/.openhammer/vm/` */
	readonly root: string;
	readonly sessions: string;
	readonly images: string;
	readonly isos: string;
	readonly cidata: string;
	readonly secrets: string;
}

export interface VmDirsDeps {
	/** Override `os.homedir()` (tests point the whole tree at a temp HOME). */
	readonly homeDir?: string;
}

/** Resolve the vm tree — pure path math; nothing is created. */
export function resolveVmDirs(deps: VmDirsDeps = {}): VmDirs {
	const root = join(deps.homeDir ?? homedir(), ".openhammer", "vm");
	return {
		root,
		sessions: join(root, "sessions"),
		images: join(root, "images"),
		isos: join(root, "isos"),
		cidata: join(root, "cidata"),
		secrets: join(root, "secrets"),
	};
}

/**
 * mkdir -p with 0700 — the one permission every vm tree dir gets (root, subdirs,
 * per-session dirs). 0700 survives the common umasks (022/077 both leave it intact).
 */
export async function ensureVmDir(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
}

/** Every path a session owns. The files themselves (meta.json contents, cm.sock) are the service layer's. */
export interface SessionPaths {
	readonly sessionDir: string;
	/** The golden's qcow2 overlay — the session boot's only disk (args.ts wires it). */
	readonly overlayPath: string;
	/** The per-session writable OVMF VARS copy (the install's Boot entries persist here). */
	readonly varsPath: string;
	readonly qmpSockPath: string;
	readonly serialPath: string;
	readonly pidfilePath: string;
	readonly metaPath: string;
	readonly cmSockPath: string;
	readonly knownHostsPath: string;
	/** capture.ts's destination (created here so the tree is complete from the start). */
	readonly debugDir: string;
}

/** The qemu-img runner's result — the spike's `run`/ShellResult shape: code + 4 KiB tails, caller judges. */
export interface QemuImgResult {
	readonly code: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
}

/**
 * The qemu-img seam: arg array in (never a shell string), result out. Injected by tests;
 * spec 27's doctor reuses the default for `qemu-img info` disk-cap checks.
 */
export type RunQemuImg = (args: readonly string[]) => Promise<QemuImgResult>;

export interface PrepareSessionOptions {
	/** The golden qcow2 the overlay backs onto (backing format qcow2, `-F qcow2`). */
	readonly goldenDiskPath: string;
}

export interface PrepareSessionDeps {
	/** Override the HOME the tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Inject the qemu-img runner (tests record argv; default spawns the real binary). */
	readonly runQemuImg?: RunQemuImg;
	/** Override the pristine VARS template copied per session (default: args.ts's OVMF_VARS). */
	readonly varsTemplate?: string;
}

// Stable session ids are minted by spec 27's service; this charset is the guard that keeps
// an id a single safe path segment (no separators, no "..", no leading dot/dash tricks).
const SESSION_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

const OVERLAY_NAME = "overlay.qcow2";
const VARS_NAME = "OVMF_VARS.4m.fd";
const DEBUG_DIR_NAME = "debug";
const PIDFILE_NAME = "qemu.pid";
const QEMU_IMG_TAIL_BYTES = 4096;

/**
 * Prepare `~/.openhammer/vm/sessions/<id>/` (0700, with `debug/` inside): create the
 * golden's overlay (`qemu-img create -f qcow2 -b <golden> -F qcow2 <overlay>` — the
 * overlay's virtual size inherits the golden's, no size argument on purpose) and copy the
 * pristine OVMF VARS template in as the session's writable pflash. Rejects on a bad id, a
 * failed overlay create (embedding the qemu-img stderr tail), or a failed VARS copy.
 */
export async function prepareSession(
	id: string,
	opts: PrepareSessionOptions,
	deps: PrepareSessionDeps = {},
): Promise<SessionPaths> {
	if (!SESSION_ID_PATTERN.test(id)) {
		throw new Error(`session id is not a safe path segment: "${id}" (expected /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)`);
	}
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const sessionDir = join(dirs.sessions, id);
	await ensureVmDir(dirs.sessions);
	await ensureVmDir(sessionDir);
	await ensureVmDir(join(sessionDir, DEBUG_DIR_NAME));

	const overlayPath = join(sessionDir, OVERLAY_NAME);
	const runQemuImgFn = deps.runQemuImg ?? runQemuImgDefault;
	const created = await runQemuImgFn(["create", "-f", "qcow2", "-b", opts.goldenDiskPath, "-F", "qcow2", overlayPath]);
	if (created.code !== 0) {
		throw new Error(
			`qemu-img create overlay failed (exit ${created.code ?? "spawn error"}): ${created.stderrTail.trim()}`,
		);
	}

	const varsPath = join(sessionDir, VARS_NAME);
	await copyFile(deps.varsTemplate ?? OVMF_VARS, varsPath);

	return {
		sessionDir,
		overlayPath,
		varsPath,
		qmpSockPath: join(sessionDir, "qmp.sock"),
		serialPath: join(sessionDir, "serial.log"),
		pidfilePath: join(sessionDir, PIDFILE_NAME),
		metaPath: join(sessionDir, "meta.json"),
		cmSockPath: join(sessionDir, "cm.sock"),
		knownHostsPath: join(sessionDir, "known_hosts"),
		debugDir: join(sessionDir, DEBUG_DIR_NAME),
	};
}

/** The boot-time stale sweep's report. */
export interface SweepReport {
	/** Live, verified-ours QEMUs that got SIGKILLed. */
	readonly killed: number;
	/** Live pids that failed the qemu verification (recycled PIDs) — their dirs were KEPT. */
	readonly skippedForeign: number;
	/** Session dirs removed (stale + killed-and-removed). */
	readonly removedDirs: number;
	/** Bytes reclaimed by those removals. */
	readonly bytesReclaimed: number;
}

/** What /proc says about a pid; `undefined` fields mean unreadable (gone, or hidden). */
export interface ProcIdentity {
	readonly comm?: string;
	readonly cmdline?: string;
}

/** The /proc read seam (default: the real filesystem, sync — /proc reads are cheap). */
export type ReadProc = (pid: number) => ProcIdentity;

/** The kill seam (default: process.kill). */
export type KillPid = (pid: number, signal: "SIGKILL") => void;

export interface SweepDeps {
	/** Override the HOME the tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Inject the /proc identity read (tests script live/dead/foreign pids). */
	readonly readProc?: ReadProc;
	/** Inject the kill (tests record instead of signaling). */
	readonly kill?: KillPid;
}

/** What one session dir amounted to. */
type SweepAction =
	| { readonly kind: "killed-and-removed"; readonly bytes: number }
	| { readonly kind: "removed"; readonly bytes: number }
	| { readonly kind: "skipped-foreign" }
	| { readonly kind: "left" };

const LEFT: SweepAction = { kind: "left" };

/**
 * Is this pid provably OUR qemu? /proc `<pid>/comm` truncates at 15 chars
 * (TASK_COMM_LEN 16 incl. NUL), so "qemu-system-x86_64" shows as "qemu-system-x86" — the
 * prefix match is the primary evidence. When the cmdline is readable it must contain the
 * full binary name, which closes the residual ambiguity of some other binary sharing the
 * 15-char prefix; an unreadable cmdline falls back to the comm prefix alone (the best
 * provable evidence available — killing is gated on what CAN be proven).
 */
export function isOurQemu(identity: ProcIdentity): boolean {
	if (identity.comm === undefined || !identity.comm.startsWith("qemu-system-x86")) {
		return false;
	}
	if (identity.cmdline !== undefined && !identity.cmdline.includes("qemu-system-x86_64")) {
		return false;
	}
	return true;
}

/**
 * The boot-time sweep over `sessions/`: for each session dir, read its pidfile, verify the
 * pid is ours before anything else, then either SIGKILL it and remove the dir (live+ours),
 * remove the dir (dead/stale), or keep it (live+foreign → skippedForeign; no pidfile or a
 * garbage one → left alone, see the module header). Never rejects: a missing sessions root
 * is an empty sweep, and one bad dir stays put for the next boot instead of aborting the rest.
 */
export async function sweepStaleSessions(deps: SweepDeps = {}): Promise<SweepReport> {
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const readProc = deps.readProc ?? readProcDefault;
	const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));

	let killed = 0;
	let skippedForeign = 0;
	let removedDirs = 0;
	let bytesReclaimed = 0;
	const entries = await readdir(dirs.sessions, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue; // stray files in sessions/ are not sessions
		}
		const sessionDir = join(dirs.sessions, entry.name);
		try {
			const action = await sweepOneSession(sessionDir, readProc, kill);
			if (action.kind === "killed-and-removed") {
				killed += 1;
				removedDirs += 1;
				bytesReclaimed += action.bytes;
			} else if (action.kind === "removed") {
				removedDirs += 1;
				bytesReclaimed += action.bytes;
			} else if (action.kind === "skipped-foreign") {
				skippedForeign += 1;
			}
		} catch {
			// One un-sweepable dir (e.g. a removal that failed) must not abort the boot
			// sweep — it stays exactly as it is for the next boot or the operator.
		}
	}
	return { killed, skippedForeign, removedDirs, bytesReclaimed };
}

async function sweepOneSession(sessionDir: string, readProc: ReadProc, kill: KillPid): Promise<SweepAction> {
	const pidText = await readFile(join(sessionDir, PIDFILE_NAME), "utf8").catch(() => undefined);
	if (pidText === undefined) {
		return LEFT; // no pidfile — mid-prepare or not ours to judge (no mtime heuristics)
	}
	const pid = Number(pidText.trim());
	if (!Number.isInteger(pid) || pid <= 0) {
		return LEFT; // garbage pidfile — unverifiable is not stale
	}
	const identity = readProc(pid);
	if (identity.comm === undefined) {
		// No /proc entry — ESRCH: the process is gone, the dir is stale.
		return { kind: "removed", bytes: await removeSessionDir(sessionDir) };
	}
	if (!isOurQemu(identity)) {
		return { kind: "skipped-foreign" };
	}
	try {
		kill(pid, "SIGKILL");
	} catch (error) {
		if (error instanceof Error && error.message.includes("ESRCH")) {
			// Died in the window between the /proc read and the kill — stale after all.
			return { kind: "removed", bytes: await removeSessionDir(sessionDir) };
		}
		throw error; // e.g. EPERM on a name-verified qemu — surface it, don't guess
	}
	// A killed session dir is removed without waiting for the reaper: SIGKILL is
	// uninterruptible, the orphan's parent (pid 1) reaps promptly, and nothing in the dir
	// is trusted after a forced kill anyway.
	return { kind: "killed-and-removed", bytes: await removeSessionDir(sessionDir) };
}

// Size then remove — the reclaim is counted only for removals that actually finished.
async function removeSessionDir(sessionDir: string): Promise<number> {
	const bytes = await dirSize(sessionDir);
	await rm(sessionDir, { recursive: true, force: true });
	return bytes;
}

// Recursive byte size (lstat semantics via dirent: symlinks are not followed, sockets and
// pipes carry no worth-counting bytes). Unreadable entries contribute zero, not an error.
async function dirSize(path: string): Promise<number> {
	let total = 0;
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			total += await dirSize(child);
		} else if (entry.isFile()) {
			total += (await stat(child).catch(() => undefined))?.size ?? 0;
		}
	}
	return total;
}

// The real /proc read: comm first (its absence IS the death signal), cmdline second (its
// absence only narrows the verification to the comm prefix).
function readProcDefault(pid: number): ProcIdentity {
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
		// cmdline unreadable (vanished mid-read, hidden) — comm-only verification
	}
	return { comm, cmdline };
}

// The default qemu-img runner — the spike's proc.ts `run` with the stdin option dropped:
// arg arrays only, last 4 KiB of both pipes kept, spawn errors surface as code null.
const runQemuImgDefault: RunQemuImg = (args: readonly string[]): Promise<QemuImgResult> =>
	new Promise<QemuImgResult>((resolveRun) => {
		const child = spawn(QEMU_IMG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		const keep = (prior: string, chunk: Buffer): string =>
			`${prior}${chunk.toString("utf8")}`.slice(-QEMU_IMG_TAIL_BYTES);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = keep(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = keep(stderr, chunk);
		});
		child.on("error", (error: Error) => {
			resolveRun({ code: null, stdoutTail: stdout, stderrTail: `${stderr}\nspawn error: ${error.message}`.trim() });
		});
		child.on("close", (code) => {
			resolveRun({ code, stdoutTail: stdout, stderrTail: stderr });
		});
	});
