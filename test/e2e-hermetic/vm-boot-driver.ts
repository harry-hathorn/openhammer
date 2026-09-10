/**
 * Tier-2 boot-E2E VM driver (spec 27f) — NOT a vitest file (the trio only collects
 * `*.test.ts`): boot.e2e.test.ts spawns it via tsx exactly the way it spawns
 * `src/main.ts`, and it runs the REAL `main()` with the VM boot seams (`MainDeps.vm`)
 * injected — so vm-mode boots are driven end to end (boot posture, the booting-err
 * through the full HTTP stack, teardown order) with zero KVM/QEMU/ssh, per the
 * hermetic trio's rule that every vm-path test rides injection seams + scripted fakes.
 *
 * The injected service is a scripted `VmBootGate`; the backend it hands out once
 * ready is a REAL `VmBackend` over scripted ssh seams (the service.test.ts precedent
 * — the types stay honest, no casts), so tool calls genuinely execute against a fake
 * "guest". The script is selected by env so the test process stays in control of a
 * running child:
 *
 *   OH_TEST_VM_MODE=preflight-fail  the preflight seam answers ONE verdict miss (a
 *                                   fixed message) — main must exit 1 with the
 *                                   one-liner on stderr.
 *   OH_TEST_VM_MODE=never-ready     start() settles "booting" forever; every
 *                                   ensureReady answers the not-ready message.
 *   OH_TEST_VM_MODE=ready           start() settles ready handing out the fake
 *                                   guest — bash calls stream OH_TEST_VM_OUTPUT
 *                                   (default "guest-hello").
 *   OH_TEST_VM_MESSAGE              the not-ready message (default: the booting-err
 *                                   shape "sandbox booting, 3s of 180s — retry").
 *
 * Observable events print `vm-driver:` lines on stdout (`start`, guest execs, `stop`)
 * so the e2e asserts ORDER: the stop line records whether the HTTP server was
 * already refusing connections when the VM teardown began — the fastify-close-
 * BEFORE-vm-stop teardown decision 27f made, proven from inside the shutdown path.
 */
import { main } from "../../src/main.ts";
import { createVmBackend, type VmBackend } from "../../src/vm/backend.ts";
import type { PrepareVmBootDeps, VmBootGate } from "../../src/vm/boot-backend.ts";
import type { EnsureReadyResult, VmState, VmStatus, VmTransition } from "../../src/vm/service.ts";
import type { SshExecResult, SshTarget, sshExec } from "../../src/vm/ssh.ts";

const MODE = process.env.OH_TEST_VM_MODE ?? "never-ready";
const MISS_MESSAGE = process.env.OH_TEST_VM_MESSAGE ?? "sandbox booting, 3s of 180s — retry";
const GUEST_OUTPUT = process.env.OH_TEST_VM_OUTPUT ?? "guest-hello";
const HEALTH_URL = `http://127.0.0.1:${process.env.PORT ?? "3000"}/health`;
const SERIAL_LOG = "/tmp/oh-vm-driver-serial.log";

const driverLog = (line: string): void => {
	console.log(`vm-driver: ${line}`);
};

/** The fake guest's target — no real socket ever exists; every seam is scripted. */
const FAKE_TARGET: SshTarget = {
	user: "sandbox",
	host: "127.0.0.1",
	port: 41733,
	keyPath: "/dev/null",
	knownHostsPath: "/dev/null",
	controlPath: "/tmp/oh-vm-driver-cm.sock",
};

/**
 * The fake guest: a REAL VmBackend whose transport seams are scripted. The runShell
 * wrapper is the only caller that passes `onChunk` (the bash tool's merged-stream
 * contract) — it streams {@link GUEST_OUTPUT}; every fs op (`test -e`, `stat`, …)
 * resolves exit 0 silently, so the bash precheck passes and readFile/readdir see empty
 * payloads.
 */
function fakeGuestBackend(): VmBackend {
	const exec: typeof sshExec = async (_target, remoteArgv, opts = {}): Promise<SshExecResult> => {
		if (opts.onChunk !== undefined) {
			// remoteArgv slots: ["bash","-c",script,"bash",cwd,timeoutSec,cmd,overflow]
			driverLog(`guest runShell: ${remoteArgv[6] ?? ""}`);
			opts.onChunk(Buffer.from(GUEST_OUTPUT));
			return { exitCode: 0, timedOut: false, stdoutTail: GUEST_OUTPUT, stderrTail: "" };
		}
		driverLog(`guest fs: ${remoteArgv.join(" ")}`);
		return { exitCode: 0, timedOut: false, stdoutTail: "", stderrTail: "" };
	};
	return createVmBackend(
		{ target: FAKE_TARGET, guestUser: "sandbox", serialLogPath: SERIAL_LOG },
		{ exec, execSync: () => 0, closeMux: async () => true },
	);
}

/** The scripted gate — VmService's public shape (VmBootGate), driven by OH_TEST_VM_MODE. */
class DriverGate implements VmBootGate {
	private readonly listeners: Array<(transition: VmTransition) => void> = [];
	private readonly guest: VmBackend | null;
	private currentState: VmState = "off";

	constructor() {
		this.guest = MODE === "ready" ? fakeGuestBackend() : null;
	}

	get state(): VmState {
		return this.currentState;
	}

	status(): VmStatus {
		return {
			state: this.currentState,
			phase: this.currentState === "booting" ? "ssh" : "none",
			sessionId: this.currentState === "ready" ? "vm-driver" : null,
			sshPort: this.currentState === "ready" ? 41733 : null,
			bootStartedAt: null,
			bootTimeoutMs: 180_000,
			readyAt: null,
			error: null,
			relaunchUsed: false,
		};
	}

	onTransition(listener: (transition: VmTransition) => void): () => void {
		this.listeners.push(listener);
		return () => {
			const index = this.listeners.indexOf(listener);
			if (index >= 0) this.listeners.splice(index, 1);
		};
	}

	async start(): Promise<void> {
		driverLog(`start (mode=${MODE})`);
		this.become(MODE === "ready" ? "ready" : "booting");
	}

	async ensureReady(): Promise<EnsureReadyResult> {
		if (this.currentState === "ready" && this.guest !== null) {
			return { ok: true, backend: this.guest, sessionId: "vm-driver", sshPort: 41733, serialLogPath: SERIAL_LOG };
		}
		return { ok: false, message: MISS_MESSAGE };
	}

	async stop(): Promise<void> {
		// Observe the teardown ORDER from inside the shutdown path: main must
		// have closed Fastify (stopped serving) BEFORE the backend's close()
		// reaches the VM stop — a refused /health here is the proof.
		const server = await fetch(HEALTH_URL).then(
			() => "serving",
			() => "closed",
		);
		driverLog(`stop: health=${server}`);
		this.become("stopped");
	}

	private become(to: VmState): void {
		const from = this.currentState;
		this.currentState = to;
		for (const listener of [...this.listeners]) {
			listener({ from, to, at: Date.now(), sessionId: null });
		}
	}
}

// The driver IS the vm-mode boot: force the mode here (the injected seams carry the
// whole VM story), so a stray MCP_VM_MODE in the parent env can never flip the boot
// to off (or agent) and change what is under test.
process.env.MCP_VM_MODE = "vm";

const vm: PrepareVmBootDeps = {
	preflight: () =>
		MODE === "preflight-fail"
			? { ok: false, message: "vm driver: preflight refused (the scripted miss — 27f's one-line exit pin)" }
			: { ok: true },
	createService: () => new DriverGate(),
};

// The entrypoint contract, verbatim from src/main.ts's module-level auto-run: main's
// boot-failure path is the caller's catch (one actionable line + exit 1) — the driver
// owns that contract for its injected boot, so the e2e pins the REAL formatting.
try {
	await main({ vm });
} catch (error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`OpenHammer failed to start: ${message}`);
	process.exit(1);
}
