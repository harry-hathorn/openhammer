// DelegatingBackend + prepareVmBoot units — spec 27f's boot-wiring contracts, hermetic:
// the gate is a scripted VmBootGate (no QEMU), and the "guest" it hands out is a REAL
// VmBackend over scripted ssh seams (the service.test.ts precedent — the types stay
// honest). What is pinned here:
//
// - the NOT-READY MAPPING, per method: fs ops err the actionable line (Result spine),
//   runShell/runArgv REJECT it (infrastructure failure — nothing ran), probes answer
//   false with the state logged ONCE per episode, homedir/overflowPath fall back to the
//   config guest root / the guest-dir path shape.
// - the READY delegation: every method reaches the live VmBackend (argv recorded), and
//   the cache warming is driven by the ready TRANSITION (the first grep after boot probes
//   the live guest — probe runs before the tool's first async call).
// - the cache lifecycle: a transition out of ready drops the cached backend (a dead mux
//   is never handed out); close stops the service exactly once and silences re-warming.
// - prepareVmBoot: off assembles NOTHING (null before any seam is consulted — the
//   zero-VM-code pin), a preflight miss throws the one actionable line (main's
//   boot-failure path prints it), a pass wires service + delegating backend.
import { describe, expect, it } from "vitest";
import type { ResolvedConfig, ResolvedVmConfig } from "../config.ts";
import { createVmBackend, type VmBackend } from "./backend.ts";
import { createDelegatingBackend, prepareVmBoot, type VmBootGate } from "./boot-backend.ts";
import type { EnsureReadyResult, VmState, VmStatus, VmTransition } from "./service.ts";
import type { SshExecResult, SshTarget, sshExec } from "./ssh.ts";

const BOOTING = "sandbox booting, 12s of 180s — retry";
const FALLBACK_HOME = "/fallback-root";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** Drain the warm hook's microtask chain (a couple of macrotasks is generous). */
async function flush(times = 3): Promise<void> {
	for (let i = 0; i < times; i++) await tick();
}

// ---- the fakes ----

const FAKE_TARGET: SshTarget = {
	user: "sandbox",
	host: "127.0.0.1",
	port: 41733,
	keyPath: "/tmp/oh-boot-backend-test-key",
	knownHostsPath: "/tmp/oh-boot-backend-test-kh",
	controlPath: "/tmp/oh-boot-backend-test-cm.sock",
};

interface ScriptedExec {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

/** A real VmBackend over scripted ssh seams — `calls`/`syncCalls` record the delegation. */
function fakeGuest(script: ScriptedExec[] = []): { backend: VmBackend; calls: string[][]; syncCalls: string[] } {
	const calls: string[][] = [];
	const syncCalls: string[] = [];
	const exec: typeof sshExec = async (_target, remoteArgv, opts = {}): Promise<SshExecResult> => {
		calls.push([...remoteArgv]);
		const answer = script.shift() ?? { exitCode: 0 };
		const out = answer.stdout ?? "";
		const errorOut = answer.stderr ?? "";
		if (out !== "") {
			if (opts.onChunk !== undefined) opts.onChunk(Buffer.from(out));
			opts.onStdout?.(Buffer.from(out));
		}
		if (errorOut !== "") {
			if (opts.onChunk !== undefined) opts.onChunk(Buffer.from(errorOut));
			opts.onStderr?.(Buffer.from(errorOut));
		}
		return { exitCode: answer.exitCode, timedOut: false, stdoutTail: out, stderrTail: errorOut };
	};
	const backend = createVmBackend(
		{ target: FAKE_TARGET, guestUser: "sandbox", serialLogPath: "/tmp/oh-boot-backend-test-serial.log" },
		{
			exec,
			execSync: (_target, remoteArgv) => {
				syncCalls.push(remoteArgv.join(" "));
				return 0;
			},
			closeMux: async () => true,
		},
	);
	return { backend, calls, syncCalls };
}

/** The scripted gate — VmService's public shape (VmBootGate), directly steerable. */
class FakeGate implements VmBootGate {
	private readonly listeners: Array<(transition: VmTransition) => void> = [];
	private readonly guest: VmBackend | null;
	state: VmState = "off";
	ensureReadyCalls = 0;
	stopCalls = 0;

	constructor(guest: VmBackend | null = null) {
		this.guest = guest;
	}

	status(): VmStatus {
		return {
			state: this.state,
			phase: this.state === "booting" ? "ssh" : "none",
			sessionId: this.state === "ready" ? "vm-fake" : null,
			sshPort: this.state === "ready" ? 41733 : null,
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
		this.become("booting");
	}

	async ensureReady(): Promise<EnsureReadyResult> {
		this.ensureReadyCalls += 1;
		if (this.state === "ready" && this.guest !== null) {
			return {
				ok: true,
				backend: this.guest,
				sessionId: "vm-fake",
				sshPort: 41733,
				serialLogPath: "/tmp/oh-boot-backend-test-serial.log",
			};
		}
		return { ok: false, message: BOOTING };
	}

	async stop(): Promise<void> {
		this.stopCalls += 1;
		this.become("stopped");
	}

	become(to: VmState): void {
		const from = this.state;
		this.state = to;
		for (const listener of [...this.listeners]) {
			listener({ from, to, at: 0, sessionId: null });
		}
	}
}

/** A delegating backend over a fresh gate, with the log line captured. */
function harness(guest: VmBackend | null = null): {
	backend: ReturnType<typeof createDelegatingBackend>;
	gate: FakeGate;
	logs: string[];
} {
	const gate = new FakeGate(guest);
	const logs: string[] = [];
	const backend = createDelegatingBackend(gate, FALLBACK_HOME, { log: (line) => logs.push(line) });
	return { backend, gate, logs };
}

// ---- the not-ready mapping ----

describe("DelegatingBackend — not-ready mapping", () => {
	it("every fs op errs the actionable line (the Result spine's expected failure)", async () => {
		const { backend, gate } = harness();
		gate.become("booting");
		const read = await backend.fs.readFile("/g/x.txt");
		expect(read.ok).toBe(false);
		if (!read.ok) expect(read.error.message).toBe(BOOTING);
		const exists = await backend.fs.exists("/g");
		expect(exists.ok).toBe(false);
		if (!exists.ok) expect(exists.error.message).toBe(BOOTING);
		const stat = await backend.fs.stat("/g");
		expect(stat.ok).toBe(false);
		const wrote = await backend.fs.writeFile("/g/x", Buffer.from("x"));
		expect(wrote.ok).toBe(false);
		const made = await backend.fs.mkdir("/g/d");
		expect(made.ok).toBe(false);
		const listed = await backend.fs.readdir("/g");
		expect(listed.ok).toBe(false);
		const access = await backend.fs.access("/g/x");
		expect(access.ok).toBe(false);
		// Every one of those gated on the service — 7 calls, 7 ensureReady hits.
		expect(gate.ensureReadyCalls).toBe(7);
	});

	it("runShell and runArgv REJECT the actionable line — a booting sandbox is an infrastructure failure", async () => {
		const { backend, gate } = harness();
		gate.become("booting");
		await expect(backend.runShell("uname -a", { cwd: "/g" })).rejects.toThrow(BOOTING);
		await expect(backend.runArgv("rg", ["--json", "x"], {})).rejects.toThrow(BOOTING);
		expect(gate.ensureReadyCalls).toBe(2);
	});

	it("probes answer false with the not-ready state logged ONCE per episode", () => {
		const { backend, gate, logs } = harness();
		gate.become("booting");
		expect(backend.probe("rg")).toBe(false);
		expect(backend.probe("fd")).toBe(false);
		expect(backend.probeFlag("fd", "--no-require-git")).toBe(false);
		expect(logs).toHaveLength(1); // once per episode, not once per probe
		expect(logs[0]).toContain('probe("rg")');
		expect(logs[0]).toContain("state=booting");
		expect(logs[0]).toContain("phase=ssh");
	});

	it("homedir falls back to the config guest root; overflowPath keeps the guest-dir shape", () => {
		const { backend, gate } = harness();
		gate.become("booting");
		expect(backend.homedir()).toBe(FALLBACK_HOME);
		expect(backend.overflowPath("openhammer")).toMatch(/^\/tmp\/\.openhammer\/openhammer-[0-9a-f]{16}\.log$/);
	});
});

// ---- the ready delegation + cache lifecycle ----

describe("DelegatingBackend — ready delegation", () => {
	it("the ready TRANSITION warms the sync surface: probes hit the live guest, not a false", async () => {
		const guest = fakeGuest();
		const { backend, gate } = harness(guest.backend);
		gate.become("ready");
		await flush();
		expect(backend.probe("rg")).toBe(true);
		expect(guest.syncCalls[0]).toContain("rg");
		expect(backend.probeFlag("fd", "--no-require-git")).toBe(true);
		expect(backend.homedir()).toBe("/home/sandbox"); // the manifest-derived guest home
		expect(backend.overflowPath("openhammer")).toMatch(/^\/tmp\/\.openhammer\/openhammer-[0-9a-f]{16}\.log$/);
	});

	it("runShell/runArgv/fs delegate to the live VmBackend verbatim", async () => {
		const guest = fakeGuest([
			{ exitCode: 0, stdout: "guest-out" }, // runShell wrapper (merged stream)
			{ exitCode: 0 }, // bash precheck's test -e
			{ exitCode: 0, stdout: "directory|4096|1700000000" }, // stat
			{ exitCode: 0, stdout: "aGVsbG8=" }, // readFile base64
			{ exitCode: 3 }, // runArgv
		]);
		const { backend, gate } = harness(guest.backend);
		gate.become("ready");
		await flush();

		const shell = await backend.runShell("echo hi", { cwd: "/g" });
		expect(shell).toEqual({ exitCode: 0, timedOut: false });
		expect(guest.calls[0]?.[6]).toBe("echo hi"); // the wrapper's cmd slot — verbatim

		const exists = await backend.fs.exists("/g");
		expect(exists).toEqual({ ok: true, value: true });
		expect(guest.calls[1]?.[0]).toBe("test");

		const stat = await backend.fs.stat("/g");
		expect(stat.ok).toBe(true);
		if (stat.ok) expect(stat.value.isDir).toBe(true);

		const read = await backend.fs.readFile("/g/x.txt");
		expect(read.ok).toBe(true);
		if (read.ok) expect(read.value).toEqual(Buffer.from("hello"));

		const argv = await backend.runArgv("rg", ["--json", "-e", "x"], {});
		expect(argv).toEqual({ exitCode: 3, timedOut: false });
	});

	it("a transition OUT of ready drops the cache (a dead mux is never handed out); re-ready re-warms", async () => {
		const guest = fakeGuest();
		const { backend, gate, logs } = harness(guest.backend);
		gate.become("ready");
		await flush();
		expect(backend.probe("rg")).toBe(true);
		expect(logs).toHaveLength(0);

		gate.become("booting"); // death → relaunch
		expect(backend.probe("rg")).toBe(false); // dropped, no stale guest
		expect(backend.homedir()).toBe(FALLBACK_HOME);
		expect(logs).toHaveLength(1); // a NEW episode logs again

		gate.become("ready");
		await flush();
		expect(backend.probe("rg")).toBe(true);
		expect(logs).toHaveLength(1); // warming re-arms the episode flag without logging
	});

	it("an ensureReady miss during use also drops the cache", async () => {
		const guest = fakeGuest();
		const { backend, gate } = harness(guest.backend);
		gate.become("ready");
		await flush();
		gate.become("failed");
		await expect(backend.runShell("true", { cwd: "/g" })).rejects.toThrow(BOOTING);
		expect(backend.probe("rg")).toBe(false);
	});
});

// ---- close ----

describe("DelegatingBackend — close", () => {
	it("close is the service stop: exactly once, and the sync surface stays silent after", async () => {
		const { backend, gate } = harness();
		gate.become("ready");
		await backend.close();
		await backend.close(); // idempotent
		expect(gate.stopCalls).toBe(1);
		expect(gate.state).toBe("stopped");
		expect(backend.probe("rg")).toBe(false);
		gate.become("ready"); // unsubscribed: no re-warm after close
		await flush();
		expect(backend.probe("rg")).toBe(false);
	});
});

// ---- prepareVmBoot ----

function vmConfig(mode: "off" | "vm"): ResolvedVmConfig {
	return {
		mode,
		image: null,
		memoryMb: 4096,
		cpus: 4,
		sshPort: 0,
		persist: "auto",
		sessionId: null,
		display: "headless",
		bootTimeoutMs: 180_000,
		bootBlockMs: 0,
		diskCapGb: 45,
		idleTimeoutMs: 0,
		agentCmd: "",
		secretsDir: null,
	};
}

function resolvedConfig(mode: "off" | "vm"): ResolvedConfig {
	return {
		port: 3000,
		host: "127.0.0.1",
		rootDir: "/home/sandbox",
		authToken: undefined,
		publicUrl: undefined,
		maxResponseBytes: 512_000,
		logLevel: "info",
		channelId: null,
		allowedClients: [],
		vm: vmConfig(mode),
	};
}

describe("prepareVmBoot", () => {
	it("mode off assembles NOTHING — null before any seam is consulted (the zero-VM-code pin)", () => {
		let preflightCalls = 0;
		let serviceCalls = 0;
		const plan = prepareVmBoot(resolvedConfig("off"), {
			preflight: () => {
				preflightCalls += 1;
				return { ok: true };
			},
			createService: () => {
				serviceCalls += 1;
				return new FakeGate();
			},
		});
		expect(plan).toBeNull();
		expect(preflightCalls).toBe(0);
		expect(serviceCalls).toBe(0);
	});

	it("a preflight miss THROWS the one actionable line (main's boot-failure path prints it)", () => {
		expect(() =>
			prepareVmBoot(resolvedConfig("vm"), {
				preflight: () => ({ ok: false, message: "KVM unavailable: /dev/kvm is not readable/writable" }),
			}),
		).toThrow("KVM unavailable: /dev/kvm is not readable/writable");
	});

	it("a pass assembles the service + the delegating backend over it (config guest root as fallback)", () => {
		const gate = new FakeGate();
		const logs: string[] = [];
		const plan = prepareVmBoot(resolvedConfig("vm"), {
			preflight: () => ({ ok: true }),
			createService: () => gate,
			log: (line) => logs.push(line),
		});
		expect(plan).not.toBeNull();
		if (plan === null) throw new Error("unreachable");
		expect(plan.service).toBe(gate);
		expect(plan.backend.kind).toBe("vm");
		expect(plan.backend.homedir()).toBe("/home/sandbox"); // ResolvedConfig.rootDir, 27b's guest root
	});
});
