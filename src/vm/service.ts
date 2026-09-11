// The VM session service — spec 27's readiness state machine (`src/vm/service.ts`): the
// boot lifecycle a VM-mode server runs eagerly-async, the boot-scoped gate tool calls hit
// (`ensureReady`), the one-shot death relaunch, the idle reaper, and the persist-policy
// overlay semantics. Every state decision lands in ONE place here; the layers below stay
// what 24/25/26 made them (qemu process lifecycle, ssh transport, golden promotion).
//
// THE STATE MACHINE (`VmState`):
//
//   off ──start()──▶ booting ──readiness──▶ ready ──stop()/reaper──▶ stopped
//                        │                    ││
//                        │ phase failure      ││ QEMU child exits (detected at the NEXT
//                        ▼                    ││ ensureReady — "death mid-session")
//                      failed ◀───────────────┘│
//                        ▲   second death       ├─ first death ──▶ booting (ONE relaunch;
//                        └──────────────────────┘   further deaths → failed, serial log named)
//
// - `start()` resolves when the boot SETTLES (ready or failed) and never rejects — the
//   eager-async posture (spec 27: "QEMU spawn kicked off async WITHOUT blocking listen()")
//   is the caller doing `void service.start()`; failures surface through state +
//   `ensureReady`, not a thrown boot. An explicit `start()` from stopped/failed is an
//   operator restart and re-arms the one-shot relaunch allowance.
// - ANY boot-phase failure: capture the evidence (capture.ts), then the clean teardown
//   ladder below, then `state = failed` with the actionable error naming the serial log.
//
// CLEAN POWEROFF — QMP `system_powerdown`, NOT provision's ssh poweroff (the decision
// note): spec 26's provision pass shut the build guest down via `ssh sudo -S systemctl
// poweroff` because it HELD the recovery password (the session's
// `luks-or-sudo-password.txt`). An overlay session of a golden has no credentials BY
// DESIGN — the unencrypted manifest carries no passphrase at all (26e), and secrets are
// never baked into the golden (26a's iron rule). `system_powerdown` is the ACPI power
// button: guest-initiated, credential-free, and exactly as clean as the ssh path (the
// guest's own systemd runs the shutdown) — the 22-measured finding-2 rule ("clean guest
// poweroff before any stop ladder when disks are mounted") is honored without a password.
// The stop ladder (qemu/process.ts) remains the fallback when the powerdown budget
// (≤180 s) expires or the guest is wedged.
//
// PERSIST RULES (`persist`, "auto" → mode vm ? retain : agent → discard — spec 27/29):
// - retain: the session id is STABLE (`config.sessionId`, else one minted
//   `<mode>-<stamp>-<hex>` id kept for the service's life). A retained session dir is
//   REUSED, never re-prepared — re-running prepareSession would `qemu-img create` over
//   the overlay and destroy the retained state. Reuse is the dashboard-restart recovery
//   path (spec 27's edge case); an overlay without its VARS half is refused, not
//   destroyed. Retain teardown KEEPS the dir.
// - discard (agent mode's dies-with-the-overlay semantics, spec 29): a FRESH session id
//   per boot (start() AND each relaunch), and teardown removes the session dir.
//
// DEATH MID-SESSION (strictly one-shot, pinned by test): the next `ensureReady()` after
// the QEMU child exited while ready captures the corpse, then either (first death) kicks
// ONE bounded async relaunch — fresh overlay unless retain — with the CALL getting the
// booting-err, or (any later death) sets `failed` with the serial log named. The relaunch
// is a full `runBoot()` under the same `bootTimeoutMs` budget, so "bounded" is the boot
// budget itself.
//
// DISK-CAP HOOK: `qemu-img info` actual-size vs `diskCapGb` at boot and teardown — a
// WARNING log line only, never fatal (low-disk is degradation over a session's lifetime;
// doctor owns loudness — the preflight disk-check posture).
//
// BOOT SWEEP (24d wired for 27k's next-boot reaper): runBoot's FIRST act is session.ts's
// sweepStaleSessions — the crash recovery that SIGKILLs orphaned QEMUs and reclaims the
// stale dirs of a killed server's sessions BEFORE this boot touches the tree. Retain's
// reuse dirs ride in as the preserve set (sweepPreserve): swept (the orphan inside still
// dies) but never removed, so the recovery path prepareOrReuse is about to take survives.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { chmod, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ResolvedVmConfig } from "../config.ts";
import { createVmBackendFromQmp, type VmBackend, type VmBackendPendingSpec } from "./backend.ts";
import { type CaptureResult, captureOnTeardown } from "./capture.ts";
import type { ReadManifest } from "./preflight.ts";
import { runBinDefault } from "./provision/iso.ts";
import { GOLDEN_DISK_FILE, type Manifest, readManifest } from "./provision/snapshot.ts";
import { qemuBootArgs } from "./qemu/args.ts";
import { sendText } from "./qemu/keys.ts";
import {
	LADDER_STEP_MS,
	QEMU_IMG_BIN,
	type QemuHandle,
	type StartQemuOptions,
	type StopOutcome,
	type StopPath,
	type StopQemuOptions,
	startQemu,
	stopQemu,
	tailText,
} from "./qemu/process.ts";
import { prepareSession, type RunQemuImg, resolveVmDirs, type SessionPaths, sweepStaleSessions } from "./session.ts";
import { type SshTarget, sshExec } from "./ssh.ts";
import { discoverSshPort } from "./usernet.ts";

// ---- the state machine's public shapes ----

/** The session lifecycle (spec 27's readiness machine). */
export type VmState = "off" | "booting" | "ready" | "stopped" | "failed";

/** Where a boot currently is — the status line's "boot progress" (spec 27h). */
export type VmBootPhase = "prepare" | "spawn" | "unlock" | "ssh" | "extras" | "none";

/**
 * The boot-scoped gate's answer: the cached backend handle on ok, or the ONE actionable
 * line on miss (the booting-err with elapsed/total while booting; the failed/stopped
 * error otherwise). The `ok: true` arm is what 27f's ToolContext wiring consumes.
 */
export type EnsureReadyResult =
	| {
			readonly ok: true;
			readonly backend: VmBackend;
			readonly sessionId: string;
			readonly sshPort: number;
			readonly serialLogPath: string;
	  }
	| { readonly ok: false; readonly message: string };

/** How a stop ended: the ACPI powerdown, the ladder's rung, or nothing to stop. */
export type VmStopPath = "powerdown" | "none" | StopPath;

export interface VmStopOutcome {
	readonly path: VmStopPath;
	/** True when the persist policy removed the session dir (discard teardown). */
	readonly overlayRemoved: boolean;
}

/** One observed state change — the subscribe hook's payload (the 27h status line). */
export interface VmTransition {
	readonly from: VmState;
	readonly to: VmState;
	readonly at: number;
	readonly sessionId: string | null;
	/** Why (the failure message, "relaunch", …) when there is a useful one. */
	readonly reason?: string;
}

/** The status snapshot (the `vm-state` NDJSON line's source, spec 27h). */
export interface VmStatus {
	readonly state: VmState;
	readonly phase: VmBootPhase;
	readonly sessionId: string | null;
	readonly sshPort: number | null;
	readonly bootStartedAt: number | null;
	readonly bootTimeoutMs: number;
	readonly readyAt: number | null;
	readonly error: string | null;
	readonly relaunchUsed: boolean;
}

// ---- tunables (every budget injectable so the trio never waits a wall clock) ----

/** Every readiness poll's cadence: the serial prompt grep and the sshd probe alike. */
const POLL_INTERVAL_MS = 500;

/**
 * How long phase 1 waits for the LUKS prompt before proceeding anyway (the grace): LUKS
 * re-prompts every boot, so an unlocked-and-booting disk is impossible — the grace only
 * covers prompt-SHAPE drift (a hook set that words the prompt differently), after which
 * phase 2's double round-trip is the honest judge. The finding is logged either way.
 */
export const UNLOCK_GRACE_MS = 60_000;

/** 22-measured "boot readiness": the ssh double round-trip, 10 s apart. */
export const SSH_DOUBLE_ROUND_TRIP_MS = 10_000;

/** 22-measured finding 2's poweroff budget: ≤180 s for the ACPI shutdown before the ladder. */
export const POWEROFF_WAIT_MS = 180_000;

/** The serial-grep window: the prompt is greppable at serial byte 551; 64 KiB is generous. */
const SERIAL_TAIL_BYTES = 64 * 1024;

/** One GiB — both sides of the disk-cap comparison. */
const GIB = 1024 ** 3;

/** The remedy preflight names for every golden failure — its line, quoted (27c owns the original). */
const GOLDEN_REMEDY = "run: openhammer vm install && openhammer vm provision && openhammer vm snapshot";

const MANIFEST_FILE = "manifest.json";
const GOLDEN_PREFIX = "golden-";

// The session dir's file names — session.ts's layout, restated (this box adds files only;
// the day session.ts exports its paths helper, this table collapses into it).
const SESSION_OVERLAY_NAME = "overlay.qcow2";
const SESSION_VARS_NAME = "OVMF_VARS.4m.fd";
const SESSION_QMP_NAME = "qmp.sock";
const SESSION_SERIAL_NAME = "serial.log";
const SESSION_PID_NAME = "qemu.pid";
const SESSION_META_NAME = "meta.json";
const SESSION_CM_NAME = "cm.sock";
const SESSION_KNOWN_HOSTS_NAME = "known_hosts";
const SESSION_DEBUG_NAME = "debug";
const SESSION_STDERR_NAME = "qemu.stderr";

/** Every wall-clock knob the machine takes (defaults: the 22-measured constants). */
export interface VmServiceTuning {
	/** Readiness poll cadence (default 500 ms). */
	readonly pollIntervalMs?: number;
	/** Phase-1 prompt grace (default {@link UNLOCK_GRACE_MS}). */
	readonly unlockGraceMs?: number;
	/** The ssh double round-trip gap (default {@link SSH_DOUBLE_ROUND_TRIP_MS}). */
	readonly doubleRoundTripMs?: number;
	/** The ACPI powerdown wait before the ladder (default {@link POWEROFF_WAIT_MS}). */
	readonly powerdownWaitMs?: number;
	/** The ladder's per-rung wait (default LADDER_STEP_MS). */
	readonly ladderStepMs?: number;
	/** The serial-grep window (default 64 KiB). */
	readonly serialTailBytes?: number;
}

/**
 * Spec 29's mode-A extras hook — a NO-OP PARAMETER here by design (this box ships mode B
 * only): between phase 2 and `ready`, the service awaits it with the session context;
 * undefined (the default) skips the phase entirely. A throw follows the normal boot
 * failure path (capture + ladder + failed) — in agent mode the extras ARE the point.
 */
export type AfterReadyHook = (context: VmSessionContext) => Promise<void>;

/** What the afterReady hook (spec 29) receives about the freshly-ready session. */
export interface VmSessionContext {
	readonly sessionId: string;
	readonly backend: VmBackend;
	readonly manifest: Manifest;
	readonly serialLogPath: string;
}

/**
 * Injection seams for EVERYTHING external (the box contract: defaults are the real
 * implementations, so the hermetic trio drives the whole machine on scripted fakes and
 * replay fixtures — no KVM, no QEMU, no ssh).
 */
export interface VmServiceDeps {
	/** Override the HOME the vm tree roots at (tests: a fake path; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the golden-manifest reader (default: snapshot.ts's readManifest). */
	readonly readManifest?: ReadManifest;
	/** Override the `images/` golden-dir scan (default: readdirSync, `golden-*` dirs only). */
	readonly listGoldenNames?: (imagesDir: string) => readonly string[];
	/** Override the session preparation (default: session.ts's prepareSession). */
	readonly prepareSession?: typeof prepareSession;
	/** Override the boot-time stale sweep (default: session.ts's sweepStaleSessions). */
	readonly sweepStaleSessions?: typeof sweepStaleSessions;
	/** Override the QEMU spawn+connect (default: qemu/process.ts's startQemu). */
	readonly startQemu?: (argv: readonly string[], opts: StartQemuOptions) => Promise<QemuHandle>;
	/** Override the stop ladder (default: qemu/process.ts's stopQemu). */
	readonly stopQemu?: (handle: QemuHandle, opts?: StopQemuOptions) => Promise<StopOutcome>;
	/** Override the hostfwd port discovery (default: usernet.ts's discoverSshPort). */
	readonly discoverSshPort?: (qmp: Pick<QemuHandle["qmp"], "humanMonitorCommand">) => Promise<number>;
	/** Override the readiness ssh probe (default: ssh.ts's sshExec). */
	readonly sshExec?: typeof sshExec;
	/** Override the LUKS typist (default: qemu/keys.ts's sendText). */
	readonly sendText?: typeof sendText;
	/** Override the backend factory (default: backend.ts's createVmBackendFromQmp). */
	readonly createBackend?: typeof createVmBackendFromQmp;
	/** Override the teardown evidence capture (default: capture.ts's captureOnTeardown). */
	readonly capture?: (sessionPaths: SessionPaths, handle?: QemuHandle) => Promise<CaptureResult>;
	/** Override every sleep (tests: a clock advance). Default: real setTimeout. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Override the clock (tests: the same advance). Default: Date.now. */
	readonly now?: () => number;
	/** Override the serial/stderr tail read (default: qemu/process.ts's tailText). */
	readonly tailText?: (path: string, bytes: number) => Promise<string>;
	/** The log line sink. Default: console.log. */
	readonly log?: (line: string) => void;
	/** Override the file size probe (default: statSync with throwIfNoEntry → size/undefined). */
	readonly statSize?: (path: string) => number | undefined;
	/** Override the golden known_hosts read (default: readFileSync utf8; throws to fail the boot). */
	readonly readFileText?: (path: string) => string;
	/** Override the session pin write, 0600 (default: fs/promises writeFile + chmod). */
	readonly writeFileText?: (path: string, text: string) => Promise<void>;
	/** Override the discard teardown removal (default: fs/promises rm recursive force). */
	readonly removeDir?: (path: string) => Promise<void>;
	/** Override the qemu-img runner (default: session.ts's real spawn; the disk-cap hook). */
	readonly runQemuImg?: RunQemuImg;
	/** Spec 29's mode-A extras hook — not implemented here (see {@link AfterReadyHook}). */
	readonly afterReady?: AfterReadyHook;
}

// ---- the pure derivations (each a contract later boxes or tests parse) ----

/**
 * The minted session id: `<mode>-<UTC stamp>-<2 random bytes hex>` — a safe path segment
 * (session.ts's SESSION_ID_PATTERN) whose random tail keeps two same-second boots from
 * colliding on one dir. Retain policy keeps ONE of these for the service's life.
 */
export function mintSessionId(mode: "vm" | "agent", at: number): string {
	const d = new Date(at);
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const stamp =
		`${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
		`T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
	return `${mode}-${stamp}-${randomBytes(2).toString("hex")}`;
}

/** Resolve `persist: "auto"` per mode (spec 27): vm retains (the workspace posture), agent discards (dies with the overlay, spec 29). */
export function resolvePersistPolicy(persist: ResolvedVmConfig["persist"], mode: "vm" | "agent"): "retain" | "discard" {
	if (persist === "retain") return "retain";
	if (persist === "discard") return "discard";
	return mode === "vm" ? "retain" : "discard";
}

/**
 * Re-key a golden's known_hosts pin under THIS session's port. ssh-keyscan writes entries
 * as `[127.0.0.1]:<port>` (OpenSSH's non-default-port form), and every session draws a
 * fresh ephemeral hostfwd port — so the golden's pin line must be rewritten under the
 * current port or StrictHostKeyChecking=yes can never match it. The KEY MATERIAL (fields
 * after the host field) is carried over verbatim: an orphan VM landing on the reused port
 * presents a different key and still fails the pin (the safe direction, ssh.ts's header).
 * Returns "" when the source has no usable key lines (comments/blanks only).
 */
export function repinKnownHosts(text: string, port: number): string {
	const lines: string[] = [];
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const tokens = trimmed.split(/\s+/);
		if (tokens.length < 3) continue; // no keytype+key — not a pin line
		lines.push(`[127.0.0.1]:${port} ${tokens.slice(1).join(" ")}`);
	}
	return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** `qemu-img info --output=json`'s `actual-size`, or undefined when the JSON has no usable one. */
export function actualSizeOf(stdout: string): number | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const size = (parsed as Record<string, unknown>)["actual-size"];
	return typeof size === "number" && Number.isInteger(size) && size >= 0 ? size : undefined;
}

/** Narrow an unknown throw/catch value to its message string (the repo's messageOf). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The golden facts one boot needs, all derived from the golden dir + its manifest. */
interface GoldenFacts {
	readonly dir: string;
	readonly manifest: Manifest;
	readonly diskPath: string;
	readonly varsPath: string;
	readonly knownHostsPath: string;
}

function goldenFacts(dir: string, manifest: Manifest): GoldenFacts {
	return {
		dir,
		manifest,
		diskPath: join(dir, GOLDEN_DISK_FILE),
		varsPath: join(dir, SESSION_VARS_NAME),
		knownHostsPath: join(dir, SESSION_KNOWN_HOSTS_NAME),
	};
}

/**
 * The VM session service. Construct with the resolved VM config (a VM mode — `off` throws,
 * the zero-VM-code pin: an off boot constructs none of this); every external effect is a
 * seam on {@link VmServiceDeps}.
 */
export class VmService {
	private readonly config: ResolvedVmConfig;
	private readonly deps: VmServiceDeps;
	private readonly tuning: Required<VmServiceTuning>;

	private currentState: VmState = "off";
	private transitionListeners: Array<(transition: VmTransition) => void> = [];
	private bootSettled: Promise<void> | null = null;
	/** Bumped by stop(): boots in flight compare it and abandon quietly (stop owns teardown). */
	private epoch = 0;

	private sessionId: string | null = null;
	private mintedSessionId: string | null = null;
	private paths: SessionPaths | null = null;
	private handle: QemuHandle | null = null;
	private backend: VmBackend | null = null;
	private sshPort: number | null = null;
	private bootStartedAt: number | null = null;
	private readyAt: number | null = null;
	private phase: VmBootPhase = "none";
	private lastError: string | null = null;
	private relaunchUsed = false;
	private pinnedPort: number | null = null;
	private reaperTimer: NodeJS.Timeout | null = null;

	constructor(config: ResolvedVmConfig, deps: VmServiceDeps = {}, tuning: VmServiceTuning = {}) {
		if (config.mode === "off") {
			throw new Error("VmService requires a VM mode (vm or agent) — an off boot runs zero VM code");
		}
		this.config = config;
		this.deps = deps;
		this.tuning = {
			pollIntervalMs: tuning.pollIntervalMs ?? POLL_INTERVAL_MS,
			unlockGraceMs: tuning.unlockGraceMs ?? UNLOCK_GRACE_MS,
			doubleRoundTripMs: tuning.doubleRoundTripMs ?? SSH_DOUBLE_ROUND_TRIP_MS,
			powerdownWaitMs: tuning.powerdownWaitMs ?? POWEROFF_WAIT_MS,
			ladderStepMs: tuning.ladderStepMs ?? LADDER_STEP_MS,
			serialTailBytes: tuning.serialTailBytes ?? SERIAL_TAIL_BYTES,
		};
	}

	/** The current lifecycle state. */
	get state(): VmState {
		return this.currentState;
	}

	/** The status snapshot — the source of the `vm-state` observability line (27h). */
	status(): VmStatus {
		return {
			state: this.currentState,
			phase: this.phase,
			sessionId: this.sessionId,
			sshPort: this.sshPort,
			bootStartedAt: this.bootStartedAt,
			bootTimeoutMs: this.config.bootTimeoutMs,
			readyAt: this.readyAt,
			error: this.lastError,
			relaunchUsed: this.relaunchUsed,
		};
	}

	/**
	 * Subscribe to state transitions (a simple callback list — the 27h status line's
	 * consumer). Returns the unsubscribe.
	 */
	onTransition(listener: (transition: VmTransition) => void): () => void {
		this.transitionListeners.push(listener);
		return () => {
			this.transitionListeners = this.transitionListeners.filter((entry) => entry !== listener);
		};
	}

	/**
	 * Boot the sandbox. Resolves when the boot SETTLES (ready or failed) — never rejects
	 * (failures land in state/`ensureReady`; the eager-async caller writes `void start()`).
	 * Idempotent while a boot is in flight or already ready. An explicit start from
	 * stopped/failed is an operator restart: it re-arms the one-shot relaunch allowance.
	 */
	async start(): Promise<void> {
		if (this.currentState === "booting") {
			await this.bootSettled;
			return;
		}
		if (this.currentState === "ready") return;
		this.relaunchUsed = false;
		const boot = this.runBoot();
		this.bootSettled = boot;
		await boot;
	}

	/**
	 * The boot-scoped gate every tool call hits. ready → the cached backend handle;
	 * booting → the booting-err ("sandbox booting, Xs of Ys — retry"); failed/stopped/off
	 * → the actionable error. `bootBlockMs > 0` swaps the immediate booting-err for a
	 * bounded per-call block (the operator's human-waits posture, spec 27's edge case):
	 * the call sleeps up to `bootBlockMs` for the boot to settle, then answers honestly.
	 *
	 * Death mid-session is detected HERE (the next tool call): a ready session whose QEMU
	 * child exited triggers the strictly-one-shot relaunch — see the module header.
	 */
	async ensureReady(): Promise<EnsureReadyResult> {
		if (this.currentState === "ready") {
			if (this.handle?.exitInfo() !== undefined) {
				return this.onDeathDetected();
			}
			this.resetIdleTimer(); // tool activity resets the reaper
			const backend = this.backend;
			if (backend === null || this.sessionId === null || this.sshPort === null || this.paths === null) {
				return { ok: false, message: "sandbox reports ready without a session — restart the server" };
			}
			return {
				ok: true,
				backend,
				sessionId: this.sessionId,
				sshPort: this.sshPort,
				serialLogPath: this.paths.serialPath,
			};
		}
		if (this.currentState === "booting") {
			if (this.config.bootBlockMs > 0) {
				const settled = this.bootSettled;
				if (settled !== null) {
					await Promise.race([settled, this.sleep(this.config.bootBlockMs)]);
				}
				if (this.currentState !== "booting") return this.ensureReady();
			}
			return { ok: false, message: this.bootingMessage() };
		}
		if (this.currentState === "stopped") {
			return {
				ok: false,
				message: "sandbox stopped — no VM session is running (restart from the dashboard or reboot the server)",
			};
		}
		if (this.currentState === "failed") {
			return { ok: false, message: this.lastError ?? "sandbox boot failed — see the VM serial log" };
		}
		return { ok: false, message: "sandbox not started — start() was never called" };
	}

	/**
	 * Stop the session: close the backend's ssh mux, press the ACPI power button
	 * (QMP `system_powerdown` — the credential-free clean poweroff, see the module header),
	 * wait ≤180 s for the exit, and only then capture + run the stop ladder. Teardown
	 * follows the persist policy (discard removes the session dir; retain keeps it) after
	 * the disk-cap hook measures the overlay one last time. Idempotent and safe from any
	 * state; a boot in flight is abandoned quietly (the epoch guard).
	 */
	async stop(): Promise<VmStopOutcome> {
		this.epoch += 1; // any in-flight boot abandons quietly — this call owns the teardown
		this.clearIdleTimer();
		const handle = this.handle;
		const paths = this.paths;
		const backend = this.backend;
		this.backend = null;
		if (backend !== null) {
			await backend.close().catch((error: unknown) => {
				this.log(`vm: backend mux close failed (continuing teardown): ${messageOf(error)}`);
			});
		}
		if (handle === null || paths === null) {
			this.transition("stopped");
			return { path: "none", overlayRemoved: false };
		}
		let path: VmStopPath = "already-exited";
		if (handle.exitInfo() === undefined) {
			this.log(`vm: stop: system_powerdown (ACPI) — waiting up to ${this.tuning.powerdownWaitMs} ms`);
			try {
				await handle.qmp.execute("system_powerdown");
			} catch (error) {
				this.log(`vm: system_powerdown unusable (${messageOf(error)}) — the stop ladder takes over`);
			}
			if (!(await this.waitQemuExit(handle, this.tuning.powerdownWaitMs))) {
				// The power went non-clean: evidence BEFORE the force, per capture.ts's contract.
				await this.captureEvidence("stop: powerdown budget expired — ladder fallback");
				path = (await this.stopQemu(handle, { stepMs: this.tuning.ladderStepMs })).path;
			} else {
				path = "powerdown";
			}
		}
		const overlayRemoved = await this.teardownSessionArtifacts(paths);
		this.transition("stopped");
		return { path, overlayRemoved };
	}

	// ---- the boot ----

	/** One full boot attempt. Never rejects; every outcome lands in state + lastError. */
	private async runBoot(): Promise<void> {
		const epoch = this.epoch;
		this.transition("booting");
		this.bootStartedAt = this.now();
		this.readyAt = null;
		this.sshPort = null;
		this.pinnedPort = null; // a fresh session dir must always get its pin written
		this.phase = "prepare";
		let paths: SessionPaths | null = null;
		let handle: QemuHandle | null = null;
		try {
			// The boot sweep is the FIRST act (24d/27k): reap the crashed server's orphans
			// and reclaim its stale dirs before this boot resolves a golden or a session.
			const sweep = await (this.deps.sweepStaleSessions ?? sweepStaleSessions)(
				{ homeDir: this.deps.homeDir },
				{ preserve: this.sweepPreserve() },
			);
			const preserved = sweep.preserved ?? 0;
			if (sweep.killed > 0 || sweep.removedDirs > 0 || preserved > 0) {
				this.log(
					`vm: boot: sweep killed ${sweep.killed} orphan(s), removed ${sweep.removedDirs} stale dir(s), ` +
						`preserved ${preserved} retained`,
				);
			}
			const golden = this.locateGolden();
			const sessionId = this.resolveSessionId();
			paths = await this.prepareOrReuse(sessionId, golden);
			this.sessionId = sessionId;
			this.paths = paths;
			this.throwIfAbandoned(epoch);
			await this.checkDiskCap(paths.overlayPath, "boot");

			this.phase = "spawn";
			const argv = qemuBootArgs({
				name: sessionId,
				sessionDir: paths.sessionDir,
				disks: { overlayPath: paths.overlayPath },
				memoryMb: this.config.memoryMb,
				cpus: this.config.cpus,
				display: this.config.display,
				qemuSockPath: paths.qmpSockPath,
				serialPath: paths.serialPath,
				pidfilePath: paths.pidfilePath,
			});
			handle = await (this.deps.startQemu ?? startQemuDefault)(argv, {
				sessionDir: paths.sessionDir,
				stderrPath: join(paths.sessionDir, SESSION_STDERR_NAME),
				qmpSockPath: paths.qmpSockPath,
			});
			this.handle = handle;
			this.throwIfAbandoned(epoch);

			if (golden.manifest.encrypt) {
				this.phase = "unlock";
				await this.unlockEncryptedDisk(handle, paths, golden.manifest);
			}
			this.phase = "ssh";
			const port = await this.awaitSshConfirmation(handle, paths, golden);
			this.sshPort = port;
			this.throwIfAbandoned(epoch);

			this.phase = "extras";
			const backend = await (this.deps.createBackend ?? createVmBackendFromQmp)(
				this.backendSpecFor(paths, golden.manifest),
				handle.qmp,
			);
			const afterReady = this.deps.afterReady;
			if (afterReady !== undefined) {
				await afterReady({
					sessionId,
					backend,
					manifest: golden.manifest,
					serialLogPath: paths.serialPath,
				});
			}
			// The last stop() race window: an operator stop that landed while the final
			// awaits were in flight must not resurrect a torn-down session as ready.
			this.throwIfAbandoned(epoch);
			this.backend = backend;
			this.readyAt = this.now();
			this.phase = "none";
			this.transition("ready");
			this.armIdleTimer();
		} catch (error) {
			if (epoch !== this.epoch) {
				// stop() won the race and owns the teardown; abandon without a verdict.
				if (handle !== null) {
					await this.stopQemu(handle, { stepMs: this.tuning.ladderStepMs }).catch(() => {
						// stop() already laddered; this is the belt-and-braces tail
					});
				}
				return;
			}
			const message = messageOf(error);
			await this.teardownAfterFailure(handle, paths);
			this.lastError =
				paths === null
					? `sandbox boot failed: ${message}`
					: `sandbox boot failed: ${message} — see the VM serial log: ${paths.serialPath}`;
			if (this.currentState === "booting") this.transition("failed", this.lastError);
		}
	}

	/** The newest valid golden, or preflight's actionable line as a throw (the no-fallback rule). */
	private locateGolden(): GoldenFacts {
		const read = this.deps.readManifest ?? readManifest;
		if (this.config.image !== null) {
			const dir = this.config.image;
			const manifest = read(join(dir, MANIFEST_FILE));
			if (manifest === null) {
				throw new Error(`no valid golden image (corrupt manifest: ${basename(dir)}) — ${GOLDEN_REMEDY}`);
			}
			return goldenFacts(dir, manifest);
		}
		const names = (this.deps.listGoldenNames ?? listGoldenNamesDefault)(this.dirs.images);
		let best: { id: string; manifest: Manifest | null } | null = null;
		let bestKey = "";
		for (const id of names) {
			const manifest = read(join(this.dirs.images, id, MANIFEST_FILE));
			const key = goldenOrderKey(id, manifest);
			if (best === null || key > bestKey || (key === bestKey && id > best.id)) {
				best = { id, manifest };
				bestKey = key;
			}
		}
		if (best === null) {
			throw new Error(`no valid golden image — ${GOLDEN_REMEDY}`);
		}
		if (best.manifest === null) {
			throw new Error(`no valid golden image (corrupt manifest: ${best.id}) — ${GOLDEN_REMEDY}`);
		}
		return goldenFacts(join(this.dirs.images, best.id), best.manifest);
	}

	/** The session id per the persist policy: retain keeps one stable id, discard mints per boot. */
	private resolveSessionId(): string {
		if (this.config.sessionId !== null && this.persistPolicy() === "retain") {
			return this.config.sessionId;
		}
		if (this.persistPolicy() === "retain") {
			this.mintedSessionId ??= mintSessionId(this.mode(), this.now());
			return this.mintedSessionId;
		}
		return this.config.sessionId ?? mintSessionId(this.mode(), this.now());
	}

	/**
	 * The boot sweep's preserve set — session dirs the sweep must never REMOVE. A pinned
	 * retain session (MCP_VM_SESSION_ID) is preserved by name; so is the service's own
	 * current session under retain: its dir is the recovery path the relaunch/restart
	 * reuses (prepareOrReuse), and a kill -9'd qemu leaves its pidfile behind — without
	 * this, the sweep would read that dead pid and destroy the retained overlay+VARS in
	 * the very boot that intends to reuse them. The orphan inside a preserved dir still
	 * dies; only the removal is suppressed. A fresh unpinned boot (and every discard
	 * boot) preserves nothing — the sweep is free to reclaim all orphans.
	 */
	private sweepPreserve(): ReadonlySet<string> {
		if (this.persistPolicy() !== "retain") return new Set<string>();
		const id = this.config.sessionId ?? this.sessionId;
		return id === null ? new Set<string>() : new Set([id]);
	}

	/**
	 * Prepare the session dir — or REUSE it: a retained session whose overlay already
	 * exists is the recovery path, and re-running prepareSession would `qemu-img create`
	 * over the overlay (destroying the retained state). Reuse requires the VARS half too;
	 * an overlay without it is refused, never destroyed.
	 */
	private async prepareOrReuse(sessionId: string, golden: GoldenFacts): Promise<SessionPaths> {
		const sessionDir = join(this.dirs.sessions, sessionId);
		const statSize = this.deps.statSize ?? statSizeDefault;
		const overlayPath = join(sessionDir, SESSION_OVERLAY_NAME);
		if (statSize(overlayPath) !== undefined) {
			if (statSize(join(sessionDir, SESSION_VARS_NAME)) === undefined) {
				throw new Error(
					`retained session ${sessionId} is incomplete (overlay present, OVMF_VARS missing) — ` +
						`recover or remove ${sessionDir} manually`,
				);
			}
			this.log(`vm: reusing retained session ${sessionDir} (the recovery path — its overlay state survives)`);
			return sessionPathsFor(sessionDir);
		}
		const prepare = this.deps.prepareSession ?? prepareSession;
		return prepare(
			sessionId,
			{ goldenDiskPath: golden.diskPath },
			{ homeDir: this.deps.homeDir, varsTemplate: golden.varsPath },
		);
	}

	/**
	 * Phase 1 (encrypted goldens only): grep the serial tail for the manifest's
	 * unlockPrompt, then type the passphrase over QMP send-key (the 22-measured gate-3
	 * chain). The grace path logs a finding and continues — LUKS re-prompts every boot,
	 * so this covers prompt-shape drift only; phase 2 judges the boot.
	 */
	private async unlockEncryptedDisk(handle: QemuHandle, paths: SessionPaths, manifest: Manifest): Promise<void> {
		const prompt = manifest.unlockPrompt;
		const passphrase = manifest.luksPassphrase;
		if (prompt === undefined || passphrase === undefined) {
			throw new Error(
				"encrypted manifest is missing unlockPrompt/luksPassphrase (normalizeManifest invariant violated)",
			);
		}
		const readTail = this.deps.tailText ?? tailText;
		const deadline = Math.min(this.now() + this.tuning.unlockGraceMs, this.bootDeadline());
		let seen = false;
		for (;;) {
			const tail = await readTail(paths.serialPath, this.tuning.serialTailBytes).catch(() => "");
			if (tail.includes(prompt)) {
				seen = true;
				break;
			}
			this.assertQemuAlive(handle, "while waiting for the LUKS unlock prompt");
			if (this.now() >= deadline) break;
			await this.sleep(this.tuning.pollIntervalMs);
		}
		if (!seen) {
			this.log(
				`vm: finding: encrypted golden did not print the unlock prompt within ` +
					`${Math.floor(this.tuning.unlockGraceMs / 1000)}s (prompt-shape drift?) — continuing to sshd ` +
					"confirmation; LUKS re-prompts every boot, so this is not an already-unlocked disk",
			);
			return;
		}
		await (this.deps.sendText ?? sendText)(handle.qmp, passphrase);
	}

	/**
	 * Phase 2: discover the hostfwd port, pin the golden's host key under it, and confirm
	 * the ssh double round-trip (`exec true`, 10 s apart — the 22-measured readiness that
	 * distinguishes a live installed sshd from a boot-time echo). Bounded by the boot
	 * budget; a QEMU death mid-poll fails fast.
	 */
	private async awaitSshConfirmation(handle: QemuHandle, paths: SessionPaths, golden: GoldenFacts): Promise<number> {
		const deadline = this.bootDeadline();
		const discover = this.deps.discoverSshPort ?? discoverSshPort;
		const exec = this.deps.sshExec ?? sshExec;
		let lastNote = "no attempt recorded";
		for (;;) {
			this.assertQemuAlive(handle, "while waiting for guest sshd");
			let port: number | undefined;
			try {
				port = await discover(handle.qmp);
			} catch (error) {
				lastNote = messageOf(error);
			}
			if (port !== undefined) {
				await this.pinHostKey(paths, golden, port);
				const target = this.sshTargetFor(paths, golden.manifest, port);
				const first = await exec(target, ["true"]);
				if (first.exitCode === 0) {
					await this.sleep(this.tuning.doubleRoundTripMs);
					this.assertQemuAlive(handle, "between the ssh double round-trip");
					const second = await exec(target, ["true"]);
					if (second.exitCode === 0) {
						return port;
					}
					lastNote = `second round-trip exited ${second.exitCode}: ${second.stderrTail.trim()}`;
				} else {
					lastNote = `first round-trip exited ${first.exitCode}: ${first.stderrTail.trim()}`;
				}
			}
			if (this.now() >= deadline) {
				throw new Error(
					`guest ssh did not confirm the double round-trip within ${this.config.bootTimeoutMs} ms (${lastNote})`,
				);
			}
			await this.sleep(this.tuning.pollIntervalMs);
		}
	}

	/** (Re)write the session's known_hosts pin for THIS port, from the golden's key material. */
	private async pinHostKey(paths: SessionPaths, golden: GoldenFacts, port: number): Promise<void> {
		if (this.pinnedPort === port) return;
		const readFileText = this.deps.readFileText ?? readFileSyncText;
		let text: string;
		try {
			text = readFileText(golden.knownHostsPath);
		} catch (error) {
			throw new Error(`cannot read the golden's host-key pin ${golden.knownHostsPath}: ${messageOf(error)}`);
		}
		const repinned = repinKnownHosts(text, port);
		if (repinned === "") {
			throw new Error(`the golden's host-key pin has no key lines (${golden.knownHostsPath}) — rebuild the golden`);
		}
		const writeFileText = this.deps.writeFileText ?? writeFileTextDefault;
		await writeFileText(paths.knownHostsPath, repinned);
		this.pinnedPort = port;
	}

	/** The backend factory's spec: the port-less pinned target plus the manifest's guest facts. */
	private backendSpecFor(paths: SessionPaths, manifest: Manifest): VmBackendPendingSpec {
		return {
			target: {
				user: manifest.guestUser,
				host: "127.0.0.1",
				keyPath: join(this.dirs.root, "id_ed25519"),
				knownHostsPath: paths.knownHostsPath,
				controlPath: paths.cmSockPath,
			},
			guestUser: manifest.guestUser,
			serialLogPath: paths.serialPath,
		};
	}

	/** The phase-2 probe target (same pinned facts as the backend's, port completed here). */
	private sshTargetFor(paths: SessionPaths, manifest: Manifest, port: number): SshTarget {
		return { ...this.backendSpecFor(paths, manifest).target, port };
	}

	// ---- death mid-session ----

	/**
	 * A ready session's QEMU child is gone (detected at ensureReady). Capture the corpse,
	 * then either the ONE relaunch (the call gets the booting-err) or `failed` naming the
	 * serial log — the strictly-one-shot pin.
	 */
	private async onDeathDetected(): Promise<EnsureReadyResult> {
		const exit = this.handle?.exitInfo();
		const serial = this.paths?.serialPath ?? "(no session)";
		await this.captureEvidence("qemu death mid-session");
		if (this.relaunchUsed) {
			this.lastError =
				`the sandbox died again after its one relaunch (exitCode=${exit?.code ?? "null"} ` +
				`signalCode=${exit?.signal ?? "null"}) — see the VM serial log: ${serial}`;
			this.log(`vm: ${this.lastError}`);
			this.transition("failed", this.lastError);
			return { ok: false, message: this.lastError };
		}
		this.relaunchUsed = true;
		this.log(
			`vm: QEMU died mid-session (exitCode=${exit?.code ?? "null"} signalCode=${exit?.signal ?? "null"}) — ` +
				"one bounded relaunch starting",
		);
		const handle = this.handle;
		if (handle !== null) {
			await this.stopQemu(handle, { stepMs: this.tuning.ladderStepMs }).catch(() => {
				// already-exited in the common case; a ladder failure here must not block the relaunch
			});
		}
		if (this.paths !== null && this.persistPolicy() === "discard") {
			// agent-mode semantics: the dead session's overlay dies with it
			await this.removeSessionDir(this.paths);
		}
		this.backend = null; // the stale mux must never be handed out again
		this.bootSettled = this.runBoot();
		void this.bootSettled; // async on purpose — this call already got its booting-err
		return { ok: false, message: this.bootingMessage() };
	}

	// ---- teardown ----

	/** The failure path's teardown: evidence first, then the powerdown-or-ladder, then persist. */
	private async teardownAfterFailure(handle: QemuHandle | null, paths: SessionPaths | null): Promise<void> {
		if (handle !== null) {
			await this.captureEvidence("boot failure");
			await this.powerdownOrLadder(handle, false);
		}
		if (paths !== null) {
			await this.teardownSessionArtifacts(paths);
		}
	}

	/**
	 * The shared stop core: ACPI powerdown → bounded wait → stop ladder. Callers decide
	 * whether the ladder fallback re-captures (stop() does — its clean path went non-clean;
	 * the failure path captured once, up front).
	 */
	private async powerdownOrLadder(handle: QemuHandle, captureBeforeLadder: boolean): Promise<VmStopPath> {
		if (handle.exitInfo() !== undefined) return "already-exited";
		try {
			await handle.qmp.execute("system_powerdown");
		} catch (error) {
			this.log(`vm: system_powerdown unusable (${messageOf(error)}) — the stop ladder takes over`);
		}
		if (await this.waitQemuExit(handle, this.tuning.powerdownWaitMs)) {
			return "powerdown";
		}
		if (captureBeforeLadder) {
			await this.captureEvidence("stop ladder fallback");
		}
		return (await this.stopQemu(handle, { stepMs: this.tuning.ladderStepMs })).path;
	}

	/** The disk-cap hook, then the persist teardown: discard removes the dir, retain keeps it. */
	private async teardownSessionArtifacts(paths: SessionPaths): Promise<boolean> {
		await this.checkDiskCap(paths.overlayPath, "teardown");
		if (this.persistPolicy() === "discard") {
			await this.removeSessionDir(paths);
			return true;
		}
		return false;
	}

	private async removeSessionDir(paths: SessionPaths): Promise<void> {
		const removeDir = this.deps.removeDir ?? removeDirDefault;
		this.log(`vm: removing session dir ${paths.sessionDir} (persist=discard — the overlay dies with the session)`);
		await removeDir(paths.sessionDir).catch((error: unknown) => {
			this.log(`vm: session dir removal failed (${messageOf(error)}) — the next boot's sweep reclaims it`);
		});
	}

	/**
	 * The disk-cap hook: `qemu-img info` actual-size vs `diskCapGb`. A WARNING line only —
	 * never fatal (an over-cap overlay is degradation doctor reports loudly, not a boot or
	 * teardown decision); an unmeasurable overlay (qemu-img failed, odd JSON) is skipped.
	 */
	private async checkDiskCap(overlayPath: string, when: "boot" | "teardown"): Promise<void> {
		const runQemuImgFn = this.deps.runQemuImg ?? runQemuImgDefault;
		const info = await runQemuImgFn(["info", "-U", "--output=json", overlayPath]).catch(() => undefined);
		if (info === undefined || info.code !== 0) return;
		const actual = actualSizeOf(info.stdoutTail);
		if (actual === undefined) return;
		if (actual > this.config.diskCapGb * GIB) {
			this.log(
				`vm: WARNING (${when}): session overlay ${overlayPath} is ${(actual / GIB).toFixed(1)}G actual, ` +
					`over the ${this.config.diskCapGb}G disk cap (MCP_VM_DISK_CAP_GB) — free host space or raise the cap`,
			);
		}
	}

	/** Evidence, never control flow: a capture failure logs and gets out of the way. */
	private async captureEvidence(reason: string): Promise<void> {
		const paths = this.paths;
		if (paths === null) return;
		const capture = this.deps.capture ?? captureOnTeardown;
		try {
			const result = await capture(paths, this.handle ?? undefined);
			// No QMP wire lines ride along: startQemu's signature does not thread the
			// connect-level onExchange hook, so there is no ring to snapshot — capture.ts
			// skips absent sources by design.
			const names = result.files.map((file) => file.name).join(", ");
			this.log(
				`vm: debug capture (${reason}) → ${result.dir}${names === "" ? " (nothing captured)" : `: ${names}`}`,
			);
		} catch (error) {
			this.log(`vm: debug capture (${reason}) failed: ${messageOf(error)}`);
		}
	}

	// ---- the idle reaper (opt-in: idleTimeoutMs > 0) ----

	private armIdleTimer(): void {
		if (this.config.idleTimeoutMs > 0) this.resetIdleTimer();
	}

	/** Reset the one timer; called at ready and on every successful ensureReady (tool activity). */
	private resetIdleTimer(): void {
		if (this.config.idleTimeoutMs <= 0 || this.currentState !== "ready") return;
		this.clearIdleTimer();
		this.reaperTimer = setTimeout(() => {
			void this.reapIdle();
		}, this.config.idleTimeoutMs);
	}

	private clearIdleTimer(): void {
		if (this.reaperTimer !== null) {
			clearTimeout(this.reaperTimer);
			this.reaperTimer = null;
		}
	}

	/** The reaper: capture, then the same clean stop() an operator would issue. */
	private async reapIdle(): Promise<void> {
		this.reaperTimer = null;
		if (this.currentState !== "ready") return;
		this.log(`vm: idle ${this.config.idleTimeoutMs} ms — capturing and stopping session ${this.sessionId ?? "?"}`);
		await this.captureEvidence("idle reaper");
		await this.stop();
	}

	// ---- small privates ----

	private get dirs(): ReturnType<typeof resolveVmDirs> {
		return resolveVmDirs({ homeDir: this.deps.homeDir });
	}

	private mode(): "vm" | "agent" {
		return this.config.mode === "agent" ? "agent" : "vm";
	}

	private persistPolicy(): "retain" | "discard" {
		return resolvePersistPolicy(this.config.persist, this.mode());
	}

	private get sleep(): (ms: number) => Promise<void> {
		return this.deps.sleep ?? sleepDefault;
	}

	private now(): number {
		return (this.deps.now ?? Date.now)();
	}

	private log(line: string): void {
		(this.deps.log ?? console.log)(line);
	}

	private stopQemu(handle: QemuHandle, opts: StopQemuOptions): Promise<StopOutcome> {
		return (this.deps.stopQemu ?? stopQemu)(handle, opts);
	}

	private bootDeadline(): number {
		return (this.bootStartedAt ?? this.now()) + this.config.bootTimeoutMs;
	}

	private bootingMessage(): string {
		const elapsedMs = Math.max(0, this.now() - (this.bootStartedAt ?? this.now()));
		return `sandbox booting, ${Math.floor(elapsedMs / 1000)}s of ${Math.floor(this.config.bootTimeoutMs / 1000)}s — retry`;
	}

	private throwIfAbandoned(epoch: number): void {
		if (epoch !== this.epoch) {
			throw new Error("boot abandoned: stop() raced the boot");
		}
	}

	private assertQemuAlive(handle: QemuHandle, where: string): void {
		const exit = handle.exitInfo();
		if (exit !== undefined) {
			throw new Error(`QEMU exited during boot, ${where} (exitCode=${exit.code} signalCode=${exit.signal})`);
		}
	}

	/** Poll exitInfo until the exit lands or the budget expires (true = exited). */
	private async waitQemuExit(handle: QemuHandle, timeoutMs: number): Promise<boolean> {
		const deadline = this.now() + timeoutMs;
		for (;;) {
			if (handle.exitInfo() !== undefined) return true;
			if (this.now() >= deadline) return false;
			await this.sleep(this.tuning.pollIntervalMs);
		}
	}

	private transition(to: VmState, reason?: string): void {
		const from = this.currentState;
		if (from === to) return;
		this.currentState = to;
		const transition: VmTransition = { from, to, at: this.now(), sessionId: this.sessionId, reason };
		for (const listener of [...this.transitionListeners]) {
			listener(transition);
		}
	}
}

/** Construct the service (factory style, matching `createVmBackend`). */
export function createVmService(
	config: ResolvedVmConfig,
	deps: VmServiceDeps = {},
	tuning: VmServiceTuning = {},
): VmService {
	return new VmService(config, deps, tuning);
}

// The session dir's full layout for an EXISTING (retained) session — session.ts's
// prepareSession return shape, reconstructed without preparing anything.
function sessionPathsFor(sessionDir: string): SessionPaths {
	return {
		sessionDir,
		overlayPath: join(sessionDir, SESSION_OVERLAY_NAME),
		varsPath: join(sessionDir, SESSION_VARS_NAME),
		qmpSockPath: join(sessionDir, SESSION_QMP_NAME),
		serialPath: join(sessionDir, SESSION_SERIAL_NAME),
		pidfilePath: join(sessionDir, SESSION_PID_NAME),
		metaPath: join(sessionDir, SESSION_META_NAME),
		cmSockPath: join(sessionDir, SESSION_CM_NAME),
		knownHostsPath: join(sessionDir, SESSION_KNOWN_HOSTS_NAME),
		debugDir: join(sessionDir, SESSION_DEBUG_NAME),
	};
}

// The chronological golden sort key — preflight.ts's/manage.ts's posture, restated a
// third time (manifest builtAt digits, falling back to the id's trailing stamp, "" last).
function goldenOrderKey(id: string, manifest: Manifest | null): string {
	const builtAt = manifest?.builtAt;
	if (builtAt !== undefined) return builtAt.replace(/\D/g, "");
	const stamp = /(\d{8}-\d{6})$/.exec(id);
	return stamp === null ? "" : (stamp[1] ?? "").replaceAll("-", "");
}

// ---- the default seams (each a three-liner over the real implementation) ----

const sleepDefault = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

const listGoldenNamesDefault = (imagesDir: string): readonly string[] => {
	try {
		return readdirSync(imagesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && entry.name.startsWith(GOLDEN_PREFIX))
			.map((entry) => entry.name);
	} catch {
		return []; // no images root — no goldens
	}
};

const statSizeDefault = (path: string): number | undefined => statSync(path, { throwIfNoEntry: false })?.size;

const readFileSyncText = (path: string): string => readFileSync(path, "utf8");

const writeFileTextDefault = async (path: string, text: string): Promise<void> => {
	await writeFile(path, text, { mode: 0o600 });
	await chmod(path, 0o600); // writeFile's mode only applies at creation (the provision precedent)
};

const removeDirDefault = (path: string): Promise<void> => rm(path, { recursive: true, force: true });

// The disk-cap hook's runner — snapshot.ts's own default idiom: runBinDefault over
// QEMU_IMG_BIN (BinRunResult ≡ QemuImgResult: code + both 4 KiB tails).
const runQemuImgDefault: RunQemuImg = (args) => runBinDefault(QEMU_IMG_BIN, args);

// The startQemu dep default: the real one, its own deps left at production defaults.
const startQemuDefault: NonNullable<VmServiceDeps["startQemu"]> = (argv, opts) => startQemu(argv, opts);
