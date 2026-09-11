// Boot wiring's backend half — spec 27f: the `DelegatingBackend` a VM-mode boot threads in
// place of LocalBackend, plus `prepareVmBoot` (the preflight verdict + service + backend
// assembly `main` calls). The sandbox boots EAGER-ASYNC (spec 27's "Boot posture": the QEMU
// spawn is kicked off WITHOUT blocking `listen()`), so the process serves `/health` and
// tool calls before any guest exists — this module defines what each ToolBackend method
// does while that is true.
//
// THE NOT-READY MAPPING (the contract, chosen per ToolBackend's own resolution semantics):
//
// - `fs.*`               → `err(new Error(<ensureReady's message>))` — the Result spine's
//                          expected-failure arm: an fs op against a booting sandbox is a
//                          per-call concern the tool shapes into its own error text, same
//                          as a missing file.
// - `runShell`/`runArgv` → REJECT with the same message — a booting sandbox is an
//                          INFRASTRUCTURE failure for a shell call: nothing ran, which is
//                          exactly LocalBackend's spawn-`error` rejection (the one
//                          genuine-throw path both contracts document). bash.ts's final
//                          catch and grep/find's `Failed to run …` narrow it to err text,
//                          so the actionable line ("sandbox booting, Xs of Ys — retry")
//                          surfaces verbatim.
// - `probe`/`probeFlag`  → `false`, with the not-ready state logged ONCE per episode. The
//                          sync surface cannot await the gate (the interface demands a
//                          boolean), and `false` is the safe direction — VmBackend itself
//                          reads a dead guest (rc 255) as absent. The tools' missing-bin
//                          texts would mislead during boot, so the log line carries the
//                          true story, and `MCP_VM_BOOT_BLOCK_MS` is the operator's
//                          explicit-wait alternative (the service's bootBlockMs: the first
//                          ensureReady blocks bounded instead of answering immediately).
// - `homedir`            → the live session's guest home (the manifest's, via the cached
//                          VmBackend) when known, else the resolved config's guest root
//                          (27b's reinterpretation of MCP_ROOT_DIR — `/home/<guestUser>`
//                          by default).
// - `overflowPath`       → the live session's path when cached, else the SAME
//                          `<prefix>-<hex>.log` shape under the guest overflow dir
//                          (DEFAULT_GUEST_OVERFLOW_DIR — never a host tmpdir path, so a
//                          not-ready mint can never name a host location).
// - `close`              → the service's `stop()` — the full session teardown (mux close →
//                          ACPI powerdown → stop ladder → persist policy, spec 27e).
//
// CACHE WARMING (how the sync surface ever knows a live session): a transition INTO ready
// fires `onTransition`, and the listener warms the cached backend by awaiting `ensureReady`
// — microtask work that completes before any HTTP handler macrotask can run, so the first
// `grep` after boot (which probes BEFORE it spawns) sees the live guest, not a false. A
// transition OUT of ready (stop, death, relaunch) drops the cache: a dead mux must never be
// handed out, and probes honestly fall back to false + the once-per-episode line.
import { randomBytes } from "node:crypto";
import type { ResolvedConfig, ResolvedVmConfig } from "../config.ts";
import type { FsBackend, ShellResult, ToolBackend } from "../tools/backend.ts";
import type { Result } from "../tools/result.ts";
import { err } from "../tools/result.ts";
import { DEFAULT_GUEST_OVERFLOW_DIR, type VmBackend } from "./backend.ts";
import { type PreflightResult, vmPreflight } from "./preflight.ts";
import { createVmService, type EnsureReadyResult, type VmState, type VmStatus, type VmTransition } from "./service.ts";

/**
 * The service surface the boot wiring consumes — `VmService`'s public shape, named so the
 * Tier-2 driver (test/e2e-hermetic/vm-boot-driver.ts) and the unit tests can inject a
 * scripted gate without constructing a real QEMU session (the hermetic trio's rule).
 */
export interface VmBootGate {
	/** The current lifecycle state (the sync readiness signal). */
	readonly state: VmState;
	/** The status snapshot (the not-ready probe line's context). */
	status(): VmStatus;
	/** Subscribe to state transitions (the cache-warming hook). Returns the unsubscribe. */
	onTransition(listener: (transition: VmTransition) => void): () => void;
	/** Boot the sandbox; resolves when the boot SETTLES and never rejects (spec 27e). */
	start(): Promise<void>;
	/** The boot-scoped gate every tool call hits (the booting-err / failed line on miss). */
	ensureReady(): Promise<EnsureReadyResult>;
	/** The session teardown (ACPI powerdown + ladder + persist policy). */
	stop(): Promise<unknown>;
}

/** Injectable seams (the box contract: defaults are the real implementations). */
export interface DelegatingBackendDeps {
	/** The once-per-episode not-ready probe line's sink. Default: console.log (service.ts's own default). */
	readonly log?: (line: string) => void;
}

/**
 * The boot-scoped ToolBackend of a VM-mode server (spec 27f): every method gates on the
 * service's readiness — ready delegates to the live session's VmBackend, not-ready answers
 * per the module header's mapping table. Constructed by {@link prepareVmBoot}; `close()` is
 * the shutdown slot's VM stop.
 *
 * `kind` is the informational mode label (spec 29): `"vm"` for a plain sandbox boot,
 * `"agent"` when the resolved mode is agent — identical vm-shaped behavior either way;
 * only `guide`'s variant switch reads it.
 */
export class DelegatingBackend implements ToolBackend {
	readonly kind: "vm" | "agent";

	private readonly gate: VmBootGate;
	private readonly fallbackHome: string;
	private readonly logLine: (line: string) => void;
	private readonly unsubscribe: () => void;
	private cachedBackend: VmBackend | null = null;
	private notReadyProbeLogged = false;
	private closed = false;

	readonly fs: FsBackend = {
		readFile: (path) => this.gateFs((fs) => fs.readFile(path)),
		access: (path) => this.gateFs((fs) => fs.access(path)),
		stat: (path) => this.gateFs((fs) => fs.stat(path)),
		readdir: (path) => this.gateFs((fs) => fs.readdir(path)),
		writeFile: (path, data) => this.gateFs((fs) => fs.writeFile(path, data)),
		mkdir: (path) => this.gateFs((fs) => fs.mkdir(path)),
		exists: (path) => this.gateFs((fs) => fs.exists(path)),
	};

	constructor(gate: VmBootGate, fallbackHome: string, deps: DelegatingBackendDeps = {}, kind: "vm" | "agent" = "vm") {
		this.gate = gate;
		this.fallbackHome = fallbackHome;
		this.kind = kind;
		this.logLine = deps.log ?? console.log;
		this.unsubscribe = gate.onTransition((transition) => {
			if (transition.to === "ready") {
				// Best-effort warm (the 12b idiom): a rejecting gate must not become an
				// unhandled rejection; the next async method re-warms anyway.
				void this.ready().catch(() => {});
			} else {
				this.cachedBackend = null;
			}
		});
	}

	/**
	 * The GUEST home for home-relative paths: the live session's (the manifest's
	 * guestUser — VmBackend.homedir) once a session is cached, else the resolved config's
	 * guest root. Never `os.homedir()` — the host user's home is behind the VM wall.
	 */
	homedir(): string {
		const backend = this.cachedBackend;
		return backend === null ? this.fallbackHome : backend.homedir();
	}

	/**
	 * Run one shell command in the guest — delegates once ready. Not-ready REJECTS with the
	 * actionable line (the module header's infrastructure-failure decision); ready rejects
	 * only the way the inner VmBackend does (rc 255 transport death, spawn error).
	 */
	async runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult> {
		const ready = await this.ready();
		if (!ready.ok) throw new Error(ready.message);
		return ready.backend.runShell(cmd, opts);
	}

	/** runShell's argv twin — same gate, same not-ready rejection, same delegation. */
	async runArgv(
		bin: string,
		args: readonly string[],
		opts: {
			cwd?: string;
			timeoutSec?: number;
			signal?: AbortSignal;
			onStdout?: (b: Buffer) => void;
			onStderr?: (b: Buffer) => void;
		},
	): Promise<ShellResult> {
		const ready = await this.ready();
		if (!ready.ok) throw new Error(ready.message);
		return ready.backend.runArgv(bin, args, opts);
	}

	/**
	 * Whether `bin` resolves in the guest's PATH — delegates once a session is cached;
	 * not-ready answers FALSE with the state logged once per episode (the module header's
	 * sync-surface decision: the interface demands a boolean, and a sync ssh spawn against
	 * a booting guest would hang the event loop).
	 */
	probe(bin: string): boolean {
		const backend = this.cachedBackend;
		if (backend === null) {
			this.logNotReadyProbe(`probe("${bin}")`);
			return false;
		}
		return backend.probe(bin);
	}

	/** probe's flag twin — same cached-session delegation, same not-ready false. */
	probeFlag(bin: string, flag: string): boolean {
		const backend = this.cachedBackend;
		if (backend === null) {
			this.logNotReadyProbe(`probeFlag("${bin}", "${flag}")`);
			return false;
		}
		return backend.probeFlag(bin, flag);
	}

	/**
	 * A fresh unique GUEST path for tee'd overflow — the live session's mint once cached;
	 * otherwise the SAME shape under the default guest overflow dir (VmBackend's own
	 * default dir): a path is minted but nothing runs while not ready, and the shape stays
	 * a guest path so a not-ready mint can never name a host location.
	 */
	overflowPath(prefix: string): string {
		const backend = this.cachedBackend;
		if (backend !== null) return backend.overflowPath(prefix);
		const id = randomBytes(8).toString("hex");
		return `${DEFAULT_GUEST_OVERFLOW_DIR}/${prefix}-${id}.log`;
	}

	/**
	 * The shutdown slot's VM stop: drop the transition subscription + cache, then the
	 * service's `stop()` — mux close, ACPI powerdown (≤180 s), stop ladder, persist
	 * teardown. Idempotent; main's slot calls this AFTER fastify.close() (stop serving
	 * first, then stop the sandbox — no tool call mid-flight against a dying guest).
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unsubscribe();
		this.cachedBackend = null;
		await this.gate.stop();
	}

	// ---- the gate plumbing ----

	/** ensureReady + cache maintenance — the first step of every async method and the warm hook. */
	private async ready(): Promise<EnsureReadyResult> {
		const result = await this.gate.ensureReady();
		if (result.ok) {
			this.cachedBackend = result.backend;
			this.notReadyProbeLogged = false; // a new not-ready episode may log again
		} else {
			this.cachedBackend = null;
		}
		return result;
	}

	/** One fs op through the gate: a miss is an err carrying the actionable line (the Result spine). */
	private async gateFs<T>(op: (fs: FsBackend) => Promise<Result<T>>): Promise<Result<T>> {
		const ready = await this.ready();
		return ready.ok ? op(ready.backend.fs) : err(new Error(ready.message));
	}

	/** The once-per-episode line that keeps a not-ready `false` from reading as "not installed". */
	private logNotReadyProbe(what: string): void {
		if (this.notReadyProbeLogged) return;
		this.notReadyProbeLogged = true;
		const status = this.gate.status();
		const why = status.error ?? `state=${status.state}${status.phase === "none" ? "" : `, phase=${status.phase}`}`;
		this.logLine(
			`vm: ${what} answered absent — the sandbox is not ready (${why}); ` +
				"sync probes cannot wait for boot; set MCP_VM_BOOT_BLOCK_MS to make tool calls wait instead",
		);
	}
}

/** Construct the delegating backend (factory style, matching `createLocalBackend`). */
export function createDelegatingBackend(
	gate: VmBootGate,
	fallbackHome: string,
	deps: DelegatingBackendDeps = {},
	kind: "vm" | "agent" = "vm",
): DelegatingBackend {
	return new DelegatingBackend(gate, fallbackHome, deps, kind);
}

// ---- main's assembly (27f) ----

/** What a VM-mode boot assembled: the eager-async service + the ToolBackend that gates on it. */
export interface VmBootPlan {
	readonly service: VmBootGate;
	readonly backend: DelegatingBackend;
}

/** `prepareVmBoot`'s seams (the box contract: defaults are the real implementations). */
export interface PrepareVmBootDeps {
	/** Override the fail-fatal preflight (the e2e driver scripts a deterministic verdict). */
	readonly preflight?: (config: ResolvedVmConfig, rootDir: string) => PreflightResult;
	/** Override the service factory (the e2e driver injects a scripted gate). */
	readonly createService?: (config: ResolvedVmConfig) => VmBootGate;
	/** The delegating backend's log sink (default: console.log). */
	readonly log?: (line: string) => void;
}

// The typed default, parameterized by the guest rootDir so the injected seam's one-arg shape
// stays callable as one union: threads `config.rootDir` (27b's guest reinterpretation of
// MCP_ROOT_DIR) into the service — the agent-mode tmux session (spec 29) starts there.
const createServiceDefault =
	(rootDir: string) =>
	(config: ResolvedVmConfig): VmBootGate =>
		createVmService(config, { guestRootDir: rootDir });

/**
 * Assemble a VM-mode boot (spec 27f, called from `main` right after config resolution):
 *
 * - `off` → `null` BEFORE any VM dep resolves — the zero-VM-code pin: a local boot never
 *   runs (or even observes) the VM stack, byte-for-byte today's behavior.
 * - `vm`/`agent` → the SYNCHRONOUS fail-fatal preflight first; a miss THROWS preflight's
 *   one actionable line, which `main`'s boot-failure path prints as
 *   `OpenHammer failed to start: <message>` + exit 1 — the deliberate deviation from the
 *   channel null-safe pattern (a VM boot with a missing prerequisite has nothing to
 *   degrade TO). On pass: the service (constructed, NOT started — `main` kicks the eager
 *   spawn off after `listen()` succeeds) and the delegating backend over it.
 */
export function prepareVmBoot(config: ResolvedConfig, deps: PrepareVmBootDeps = {}): VmBootPlan | null {
	if (config.vm.mode === "off") {
		return null;
	}
	const verdict = (deps.preflight ?? vmPreflight)(config.vm, config.rootDir);
	if (!verdict.ok) {
		throw new Error(verdict.message);
	}
	const service = (deps.createService ?? createServiceDefault(config.rootDir))(config.vm);
	// The mode is known here (spec 29): agent mode reports kind "agent" so the guide
	// can add its supervision doctrine — behavior stays vm-shaped either way.
	const kind = config.vm.mode === "agent" ? "agent" : "vm";
	return { service, backend: createDelegatingBackend(service, config.rootDir, { log: deps.log }, kind) };
}
