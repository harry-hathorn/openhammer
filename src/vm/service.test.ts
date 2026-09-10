// VmService replay-fixture tests — spec 27's acceptance line: "readiness state machine
// against recorded serial fixtures". Every external effect is a scripted fake (the
// VmServiceDeps seams); the serial/ssh shapes are quoted from the 22-measured run logs,
// so the machine is driven by recordings of the real boot, never by KVM/QEMU/ssh.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedVmConfig } from "../config.ts";
import { createVmBackendFromQmp } from "./backend.ts";
import type { Manifest } from "./provision/snapshot.ts";
import { type QemuExit, type QemuHandle, stopQemu } from "./qemu/process.ts";
import type { QmpClient } from "./qmp/client.ts";
import {
	type AfterReadyHook,
	actualSizeOf,
	createVmService,
	mintSessionId,
	repinKnownHosts,
	resolvePersistPolicy,
	type VmServiceDeps,
	type VmServiceTuning,
	type VmTransition,
} from "./service.ts";
import type { SessionPaths } from "./session.ts";

// ---- the recorded fixtures (22-measured, quoted) ----

/** Gate 8's hostfwd row — what `info usernet` answers once slirp is up (fd 18, port 41733). */
const USERNET_TABLE = "TCP[HOST_FORWARD]  18       127.0.0.1 41733       10.0.2.15    22     0     0\n";

/** The 26d keyscan's pin line shape (host field under the install-time port, key material after). */
const GOLDEN_KNOWN_HOSTS =
	"# 127.0.0.1:2222 SSH-2.0-OpenSSH_10.0\n\n[127.0.0.1]:2222 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeGuestHostKey openhammer-guest\n";

/** Gate 3's serial: the LUKS prompt greppable as text (byte 551, ~20 s in) + the per-key echo. */
const SERIAL_ENCRYPTED = [
	"BdsDxe: loading driver ...\n",
	"[    0.000000] Linux version 6.12.1-arch1-1 ...\n",
	"A password is required to access the root volume: \n",
	" ********************************\n",
	"omarchy-sandbox login: \n",
].join("");

/** The unencrypted golden's serial: full boot, no prompt (finding 6's installed-system shape). */
const SERIAL_UNENCRYPTED = "[    0.000000] Linux version 6.12.1-arch1-1 ...\nomarchy-sandbox login: \n";

const HOME = "/tmp/openhammer-test-home";
const SESSIONS = join(HOME, ".openhammer", "vm", "sessions");
const IMAGES = join(HOME, ".openhammer", "vm", "images");
const GOLDEN_ID = "golden-4.0.3-20260908-010203";
const GIB = 1024 ** 3;

function manifestFixture(overrides: Partial<Manifest> = {}): Manifest {
	return {
		id: GOLDEN_ID,
		flavor: "base",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: "https://iso.omarchy.org/omarchy-4.0.3.iso",
		isoSha256: "0".repeat(64),
		diskVirtualSizeBytes: 42949672960,
		provisionScriptHashes: null,
		builtAt: "2026-09-08T01:02:03.000Z",
		encrypt: false,
		...overrides,
	};
}

function encryptedManifest(): Manifest {
	return manifestFixture({
		encrypt: true,
		unlockPrompt: "A password is required to access the root volume:",
		luksPassphrase: "correct horse battery staple 42",
	});
}

function vmConfig(overrides: Partial<ResolvedVmConfig> = {}): ResolvedVmConfig {
	return {
		mode: "vm",
		image: null,
		memoryMb: 4096,
		cpus: 4,
		sshPort: 0,
		persist: "retain",
		sessionId: null,
		display: "headless",
		bootTimeoutMs: 60_000,
		bootBlockMs: 0,
		diskCapGb: 45,
		idleTimeoutMs: 0,
		agentCmd: "",
		secretsDir: null,
		...overrides,
	};
}

function sessionPathsForTest(id: string): SessionPaths {
	const sessionDir = join(SESSIONS, id);
	return {
		sessionDir,
		overlayPath: join(sessionDir, "overlay.qcow2"),
		varsPath: join(sessionDir, "OVMF_VARS.4m.fd"),
		qmpSockPath: join(sessionDir, "qmp.sock"),
		serialPath: join(sessionDir, "serial.log"),
		pidfilePath: join(sessionDir, "qemu.pid"),
		metaPath: join(sessionDir, "meta.json"),
		cmSockPath: join(sessionDir, "cm.sock"),
		knownHostsPath: join(sessionDir, "known_hosts"),
		debugDir: join(sessionDir, "debug"),
	};
}

// ---- the fakes (process.test.ts's shapes, adapted) ----

/** A pid that is guaranteed reaped-dead: spawnSync waits for exit AND reaps before returning. */
function deadPid(): number {
	const result = spawnSync(process.execPath, ["-e", ""]);
	expect(result.status).toBe(0);
	expect(result.pid).toBeGreaterThan(0);
	return result.pid;
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function flush(times = 5): Promise<void> {
	for (let i = 0; i < times; i++) await tick();
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("waitFor: condition never met");
		await realSleep(5);
	}
}

interface FakeQmp {
	readonly commands: string[];
	execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
	humanMonitorCommand(commandLine: string): Promise<string>;
}

interface FakeVmHandle extends QemuHandle {
	readonly signals: string[];
	readonly qmpFake: FakeQmp;
	emitExit(code: number | null, signal: string | null): void;
}

function fakeHandle(options: { onCommand?: (command: string) => void } = {}): FakeVmHandle {
	const commands: string[] = [];
	const qmpFake: FakeQmp = {
		commands,
		execute: (command) => {
			commands.push(command);
			options.onCommand?.(command);
			return Promise.resolve({});
		},
		humanMonitorCommand: () => Promise.resolve(USERNET_TABLE),
	};
	const qmp: QmpClient = {
		greetingLine: '{"QMP": {"version": {}}}',
		capabilitiesReturn: {},
		execute: qmpFake.execute,
		humanMonitorCommand: qmpFake.humanMonitorCommand,
		close: () => {},
		closed: new Promise<string>(() => {
			// never resolves — no test here needs QEMU-side socket close
		}),
	};
	const signals: string[] = [];
	const exitListeners: Array<(code: number | null, signal: string | null) => void> = [];
	let recorded: QemuExit | undefined;
	let settle: (exit: QemuExit) => void = () => {};
	const exited = new Promise<QemuExit>((resolve) => {
		settle = resolve;
	});
	const handle: FakeVmHandle = {
		pid: deadPid(),
		qmp,
		exited,
		exitInfo: (): QemuExit | undefined => recorded,
		kill: (signal: NodeJS.Signals | number = "SIGTERM"): boolean => {
			const name = typeof signal === "string" ? signal : `signal-${signal}`;
			signals.push(name);
			if (name === "SIGTERM" || name === "SIGKILL") {
				handle.emitExit(null, name);
			}
			return true;
		},
		stderrTail: async () => "",
		signals,
		qmpFake,
		emitExit(code: number | null, signal: string | null): void {
			const info: QemuExit = { code, signal };
			recorded = info;
			for (const listener of exitListeners) listener(code, signal);
			settle(info);
		},
	};
	return handle;
}

// ---- the harness: one fully-scripted service ----

interface HarnessOptions {
	config?: Partial<ResolvedVmConfig>;
	tuning?: Partial<VmServiceTuning>;
	manifest?: Manifest;
	goldens?: ReadonlyArray<{ id: string; manifest: Manifest | null }>;
	serial?: string;
	/** How many `true` execs fail before confirmation (Infinity = never confirms). */
	sshFailures?: number;
	/** A promise the SECOND `true` exec awaits — holds the boot inside phase 2. */
	holdSecondExec?: Promise<void>;
	startQemuFailure?: Error;
	afterReady?: AfterReadyHook;
	/** Side effect when QMP sees system_powerdown (default: none — a wedged guest). */
	onPowerdown?: (handle: FakeVmHandle) => void;
	/** qemu-img actual-size for the disk-cap hook; null = qemu-img fails. */
	qemuImgActualSize?: number | null;
	/** Session ids whose VARS half is missing (the incomplete-retained-session refusal). */
	varsMissingFor?: ReadonlySet<string>;
}

interface Harness {
	service: ReturnType<typeof createVmService>;
	transitions: VmTransition[];
	logs: string[];
	handles: FakeVmHandle[];
	existingSessions: Set<string>;
	calls: {
		prepareSession: Array<{ id: string; goldenDiskPath: string; varsTemplate: string | undefined }>;
		startQemu: Array<{ argv: string[]; stderrPath: string }>;
		sendText: Array<{ text: string }>;
		sshExec: Array<{ port: number; remoteArgv: string[] }>;
		discover: number;
		capture: string[];
		stopQemu: number;
		runQemuImg: string[][];
		pins: Array<{ path: string; text: string }>;
		removedDirs: string[];
		createBackend: number;
		closeMux: number;
	};
}

function harness(options: HarnessOptions = {}): Harness {
	const goldens = options.goldens ?? [{ id: GOLDEN_ID, manifest: options.manifest ?? manifestFixture() }];
	const tuning: VmServiceTuning = {
		pollIntervalMs: 5,
		unlockGraceMs: 1_000,
		doubleRoundTripMs: 50,
		powerdownWaitMs: 2_000,
		ladderStepMs: 10,
		serialTailBytes: 65_536,
		...options.tuning,
	};
	const transitions: VmTransition[] = [];
	const logs: string[] = [];
	const calls: Harness["calls"] = {
		prepareSession: [],
		startQemu: [],
		sendText: [],
		sshExec: [],
		discover: 0,
		capture: [],
		stopQemu: 0,
		runQemuImg: [],
		pins: [],
		removedDirs: [],
		createBackend: 0,
		closeMux: 0,
	};
	const handles: FakeVmHandle[] = [];
	const existingSessions = new Set<string>();
	let clock = 0;
	let sshFailures = options.sshFailures ?? 0;

	const deps: VmServiceDeps = {
		homeDir: HOME,
		readManifest: (path) => {
			for (const golden of goldens) {
				if (path.includes(golden.id)) return golden.manifest;
			}
			return null;
		},
		listGoldenNames: () => goldens.map((golden) => golden.id),
		prepareSession: async (id, opts, prepareDeps) => {
			calls.prepareSession.push({
				id,
				goldenDiskPath: opts.goldenDiskPath,
				varsTemplate: prepareDeps?.varsTemplate,
			});
			return sessionPathsForTest(id);
		},
		startQemu: async (argv, opts) => {
			if (options.startQemuFailure !== undefined) throw options.startQemuFailure;
			calls.startQemu.push({ argv: [...argv], stderrPath: opts.stderrPath });
			const handle = fakeHandle({
				onCommand: (command) => {
					if (command === "system_powerdown") options.onPowerdown?.(handle);
				},
			});
			handles.push(handle);
			return handle;
		},
		// The REAL ladder over the fake handle — the stop tests exercise 24d's actual rungs.
		stopQemu: async (handle, opts) => {
			calls.stopQemu += 1;
			return stopQemu(handle, opts ?? { stepMs: tuning.ladderStepMs });
		},
		discoverSshPort: async () => {
			calls.discover += 1;
			return 41733;
		},
		sshExec: async (target, remoteArgv) => {
			calls.sshExec.push({ port: target.port, remoteArgv: [...remoteArgv] });
			if (calls.sshExec.length === 2 && options.holdSecondExec !== undefined) {
				await options.holdSecondExec;
			}
			if (sshFailures > 0) {
				sshFailures -= 1;
				return {
					exitCode: 255,
					timedOut: false,
					stdoutTail: "",
					stderrTail: "ssh: connect to host 127.0.0.1 port 41733: Connection refused",
				};
			}
			return { exitCode: 0, timedOut: false, stdoutTail: "", stderrTail: "" };
		},
		sendText: async (_transport, text) => {
			calls.sendText.push({ text });
			return { chords: [], exchanges: [] };
		},
		createBackend: async (spec, qmp) => {
			calls.createBackend += 1;
			// The real factory over the scripted qmp, with hermetic transport seams.
			return createVmBackendFromQmp(spec, qmp, {
				closeMux: async () => {
					calls.closeMux += 1;
					return true;
				},
				exec: async () => ({ exitCode: 0, timedOut: false, stdoutTail: "", stderrTail: "" }),
				execSync: () => 0,
			});
		},
		capture: async (sessionPaths) => {
			calls.capture.push(sessionPaths.sessionDir);
			return { dir: sessionPaths.debugDir, files: [] };
		},
		sleep: async (ms) => {
			clock += ms;
			await tick(); // one macrotask per sleep — the boot progresses in observable steps
		},
		now: () => clock,
		tailText: async () => options.serial ?? "",
		log: (line) => {
			logs.push(line);
		},
		statSize: (path) => {
			const match = /sessions[/\\]([^/\\]+)[/\\](overlay\.qcow2|OVMF_VARS\.4m\.fd)$/.exec(path);
			if (match !== null && existingSessions.has(match[1] ?? "")) {
				if (match[2] === "OVMF_VARS.4m.fd" && (options.varsMissingFor?.has(match[1] ?? "") ?? false)) {
					return undefined; // the torn half — the refusal path's fixture
				}
				return match[2] === "overlay.qcow2" ? 2048 : 524_288;
			}
			return undefined;
		},
		readFileText: () => GOLDEN_KNOWN_HOSTS,
		writeFileText: async (path, text) => {
			calls.pins.push({ path, text });
		},
		removeDir: async (path) => {
			calls.removedDirs.push(path);
		},
		runQemuImg: async (args) => {
			calls.runQemuImg.push([...args]);
			if (options.qemuImgActualSize === null) {
				return { code: 1, stdoutTail: "", stderrTail: "qemu-img: Could not open" };
			}
			return {
				code: 0,
				stdoutTail: JSON.stringify({ "actual-size": options.qemuImgActualSize ?? 200_704 }),
				stderrTail: "",
			};
		},
		afterReady: options.afterReady,
	};

	const service = createVmService(vmConfig(options.config ?? {}), deps, tuning);
	service.onTransition((transition) => transitions.push(transition));
	return { service, transitions, logs, handles, existingSessions, calls };
}

// ---- the pure derivations ----

describe("mintSessionId", () => {
	it("mints `<mode>-<UTCstamp>-<hex>` — a safe path segment, distinct within the same second", () => {
		const id = mintSessionId("vm", 0);
		expect(id).toMatch(/^vm-19700101T000000Z-[0-9a-f]{4}$/);
		expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/); // session.ts's SESSION_ID_PATTERN
		expect(mintSessionId("vm", 0)).not.toBe(id); // the random tail
		expect(mintSessionId("agent", 0)).toMatch(/^agent-/);
	});
});

describe("resolvePersistPolicy", () => {
	it("auto resolves per mode: vm retains, agent discards; explicit values win", () => {
		expect(resolvePersistPolicy("auto", "vm")).toBe("retain");
		expect(resolvePersistPolicy("auto", "agent")).toBe("discard");
		expect(resolvePersistPolicy("retain", "agent")).toBe("retain");
		expect(resolvePersistPolicy("discard", "vm")).toBe("discard");
	});
});

describe("repinKnownHosts", () => {
	it("re-keys the golden's pin under the session port, carrying key material verbatim", () => {
		const pinned = repinKnownHosts(GOLDEN_KNOWN_HOSTS, 41733);
		expect(pinned).toBe("[127.0.0.1]:41733 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeGuestHostKey openhammer-guest\n");
	});

	it("drops comments/blanks and multi-key files keep every key line", () => {
		const pinned = repinKnownHosts("# comment\n\n[127.0.0.1]:1 ssh-ed25519 K1\n[127.0.0.1]:2 ssh-rsa K2\n", 999);
		expect(pinned).toBe("[127.0.0.1]:999 ssh-ed25519 K1\n[127.0.0.1]:999 ssh-rsa K2\n");
	});

	it("returns empty for a source with no usable key lines", () => {
		expect(repinKnownHosts("# only comments\n\n", 1)).toBe("");
		expect(repinKnownHosts("not-a-pin-line\n", 1)).toBe("");
	});
});

describe("actualSizeOf", () => {
	it("reads qemu-img info's actual-size; anything else is undefined", () => {
		expect(actualSizeOf(JSON.stringify({ "actual-size": 6_233_722_880 }))).toBe(6_233_722_880);
		expect(actualSizeOf(JSON.stringify({ "virtual-size": 1 }))).toBeUndefined();
		expect(actualSizeOf("not json")).toBeUndefined();
		expect(actualSizeOf(JSON.stringify({ "actual-size": -1 }))).toBeUndefined();
	});
});

// ---- the state machine ----

describe("VmService — unencrypted happy path", () => {
	it("boots to ready: transitions, timing fields, overlay argv, golden facts, pinned target, cached backend", async () => {
		const h = harness();
		const before = await h.service.ensureReady();
		expect(before).toEqual({ ok: false, message: "sandbox not started — start() was never called" });

		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["off->booting", "booting->ready"]);

		const status = h.service.status();
		expect(status.phase).toBe("none");
		expect(status.bootStartedAt).toBe(0); // the fake clock's boot start
		expect(status.readyAt).toBe(50); // the double round-trip sleep is the only wait
		expect(status.sshPort).toBe(41733);
		expect(status.sessionId).toMatch(/^vm-/);
		expect(status.error).toBeNull();

		// The overlay boot shape: the golden's overlay as the only disk, config-threaded.
		const sessionId = status.sessionId ?? "";
		const paths = sessionPathsForTest(sessionId);
		const argv = h.calls.startQemu[0]?.argv ?? [];
		const argvValue = (flag: string): string => {
			const index = argv.indexOf(flag);
			expect(index).toBeGreaterThan(-1);
			return argv[index + 1] ?? "";
		};
		expect(argvValue("-name")).toBe(`openhammer-vm-${sessionId}`);
		expect(argvValue("-m")).toBe("4096M");
		expect(argvValue("-smp")).toBe("4");
		expect(argv).toContain(`file=${paths.overlayPath},if=none,id=hd0,format=qcow2`);
		expect(argvValue("-serial")).toBe(`file:${paths.serialPath}`);
		expect(h.calls.startQemu[0]?.stderrPath).toBe(join(paths.sessionDir, "qemu.stderr"));

		// The golden facts: overlay backed onto golden.qcow2, VARS from the INSTALLED copy.
		expect(h.calls.prepareSession[0]?.goldenDiskPath).toBe(join(IMAGES, GOLDEN_ID, "golden.qcow2"));
		expect(h.calls.prepareSession[0]?.varsTemplate).toBe(join(IMAGES, GOLDEN_ID, "OVMF_VARS.4m.fd"));

		// The pin re-keyed under the discovered port, then the double round-trip on that port.
		expect(h.calls.pins[0]?.path).toBe(paths.knownHostsPath);
		expect(h.calls.pins[0]?.text).toBe(
			"[127.0.0.1]:41733 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeGuestHostKey openhammer-guest\n",
		);
		expect(h.calls.sshExec.map((call) => [call.port, call.remoteArgv])).toEqual([
			[41733, ["true"]],
			[41733, ["true"]],
		]);
		expect(h.calls.sendText).toEqual([]); // unencrypted: phase 1 never runs

		// The disk-cap hook ran at boot over the overlay.
		expect(h.calls.runQemuImg[0]).toEqual(["info", "-U", "--output=json", paths.overlayPath]);

		// ensureReady hands out the CACHED backend (constructed once).
		const first = await h.service.ensureReady();
		const second = await h.service.ensureReady();
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (first.ok && second.ok) {
			expect(first.backend).toBe(second.backend);
			expect(first.sshPort).toBe(41733);
			expect(first.serialLogPath).toBe(paths.serialPath);
			expect(first.sessionId).toBe(sessionId);
		}
		expect(h.calls.createBackend).toBe(1);
	});

	it("picks the NEWEST golden; a corrupt newest is named, never fallen back past", async () => {
		const older = manifestFixture({ id: "golden-4.0.3-20260907-000000", builtAt: "2026-09-07T00:00:00.000Z" });
		const newer = manifestFixture({ id: "golden-4.0.3-20260909-000000", builtAt: "2026-09-09T00:00:00.000Z" });
		const h = harness({
			goldens: [
				{ id: older.id, manifest: older },
				{ id: newer.id, manifest: newer },
			],
		});
		await h.service.start();
		expect(h.calls.prepareSession[0]?.goldenDiskPath).toContain(newer.id);

		const corrupt = harness({
			goldens: [
				{ id: older.id, manifest: older },
				{ id: newer.id, manifest: null },
			],
		});
		await corrupt.service.start();
		expect(corrupt.service.state).toBe("failed");
		const r = await corrupt.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain(`(corrupt manifest: ${newer.id})`);
	});

	it("no goldens → failed with preflight's actionable line", async () => {
		const h = harness({ goldens: [] });
		await h.service.start();
		expect(h.service.state).toBe("failed");
		const r = await h.service.ensureReady();
		expect(r).toEqual({
			ok: false,
			message:
				"sandbox boot failed: no valid golden image — run: openhammer vm install && openhammer vm provision && openhammer vm snapshot",
		});
	});

	it("MCP_VM_IMAGE override: the named golden is used", async () => {
		const h = harness({
			config: { image: join(IMAGES, "custom-golden") },
			goldens: [{ id: "custom-golden", manifest: manifestFixture({ id: "custom-golden" }) }],
		});
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.calls.prepareSession[0]?.goldenDiskPath).toBe(join(IMAGES, "custom-golden", "golden.qcow2"));
	});

	it("qemu spawn failure → failed (no capture: QEMU never lived), serial-less message", async () => {
		const h = harness({ startQemuFailure: new Error("qemu: spawn qemu-system-x86_64 failed (no pid)") });
		await h.service.start();
		expect(h.service.state).toBe("failed");
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("spawn qemu-system-x86_64 failed");
		expect(h.calls.capture.length).toBe(0);
	});
});

describe("VmService — encrypted unlock (phase 1)", () => {
	it("greps the serial prompt, types the passphrase over QMP send-key, reaches ready", async () => {
		const h = harness({ manifest: encryptedManifest(), serial: SERIAL_ENCRYPTED });
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.calls.sendText).toEqual([{ text: "correct horse battery staple 42" }]);
		expect(h.calls.sshExec.length).toBe(2); // phase 2 still confirms after the unlock
	});

	it("grace: the prompt never appearing is a logged finding, not a failure — sshd still confirms", async () => {
		const h = harness({
			manifest: encryptedManifest(),
			serial: SERIAL_UNENCRYPTED, // a differently-worded hook set
			tuning: { unlockGraceMs: 100 },
		});
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.calls.sendText).toEqual([]);
		expect(h.logs.some((line) => line.includes("finding: encrypted golden did not print the unlock prompt"))).toBe(
			true,
		);
	});
});

describe("VmService — phase 2 failures", () => {
	it("sshd never confirms: budget expiry → failed, capture called, serial log named, ladder teardown", async () => {
		const h = harness({ config: { bootTimeoutMs: 200 }, sshFailures: Number.POSITIVE_INFINITY });
		await h.service.start();
		expect(h.service.state).toBe("failed");
		const serialPath = sessionPathsForTest(h.service.status().sessionId ?? "").serialPath;
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("guest ssh did not confirm the double round-trip within 200 ms");
			expect(r.message).toContain(serialPath);
		}
		expect(h.calls.capture.length).toBe(1); // evidence before the teardown
		expect(h.handles[0]?.qmpFake.commands).toEqual(["system_powerdown", "quit"]); // the clean attempt, then the ladder's first rung
		expect(h.calls.stopQemu).toBe(1); // then the ladder
		expect(h.handles[0]?.signals).toEqual(["SIGTERM"]); // the fake dies on TERM (the quit rung failed)
		expect(h.transitions.map((t) => t.to)).toEqual(["booting", "failed"]);
	});

	it("booting-err with elapsed/total while phase 2 waits on the second round-trip", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		// doubleRoundTripMs 12_500 → the fake clock reads 12.5 s elapsed when the call lands.
		const h = harness({ holdSecondExec: held, tuning: { doubleRoundTripMs: 12_500 } });
		const boot = h.service.start();
		void boot;
		await flush();
		expect(h.service.state).toBe("booting");
		expect(h.service.status().phase).toBe("ssh");
		const r = await h.service.ensureReady();
		expect(r).toEqual({ ok: false, message: "sandbox booting, 12s of 60s — retry" });
		release();
		await boot;
		expect(h.service.state).toBe("ready");
	});

	it("stop() racing the boot's tail: the boot abandons quietly — state stays stopped, never resurrected", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({ holdSecondExec: held });
		const boot = h.service.start();
		void boot;
		await flush();
		expect(h.service.state).toBe("booting");
		await h.service.stop(); // the operator stop lands while the second round-trip is held
		expect(h.service.state).toBe("stopped");
		release();
		await boot;
		expect(h.service.state).toBe("stopped"); // not resurrected as ready
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("sandbox stopped");
	});

	it("bootBlockMs > 0: the gate blocks bounded (no hang), then answers honestly", async () => {
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const h = harness({
			config: { bootBlockMs: 5_000 },
			holdSecondExec: held,
			tuning: { doubleRoundTripMs: 12_500 },
		});
		const boot = h.service.start();
		void boot;
		await flush();
		const gated = h.service.ensureReady(); // blocks up to bootBlockMs — the boot is held
		await flush(3); // the bounded block expires without the boot settling (12.5 s + the 5 s block)
		const r = await gated;
		expect(r).toEqual({ ok: false, message: "sandbox booting, 17s of 60s — retry" });
		release();
		await boot;
		const after = await h.service.ensureReady();
		expect(after.ok).toBe(true);
	});
});

describe("VmService — death mid-session (strictly one-shot)", () => {
	it("first death: corpse captured, ONE relaunch (fresh overlay under discard), the call gets the booting-err", async () => {
		const h = harness({ config: { persist: "discard" } });
		await h.service.start();
		const firstId = h.service.status().sessionId ?? "";
		expect(h.service.state).toBe("ready");

		h.handles[0]?.emitExit(1, null);
		const r = await h.service.ensureReady();
		expect(r).toEqual({ ok: false, message: "sandbox booting, 0s of 60s — retry" });
		expect(h.calls.capture.length).toBe(1); // the corpse's evidence
		expect(h.calls.removedDirs).toEqual([sessionPathsForTest(firstId).sessionDir]); // died with the overlay

		await h.service.start(); // waits for the relaunch to settle
		expect(h.service.state).toBe("ready");
		const secondId = h.service.status().sessionId ?? "";
		expect(secondId).not.toBe(firstId); // fresh session
		expect(h.calls.prepareSession.length).toBe(2);
		const again = await h.service.ensureReady();
		expect(again.ok).toBe(true);
	});

	it("second death: failed naming the serial log — further calls keep the actionable err (the one-shot pin)", async () => {
		const h = harness();
		await h.service.start();
		h.handles[0]?.emitExit(1, null);
		await h.service.ensureReady();
		await h.service.start();
		expect(h.service.state).toBe("ready");

		h.handles[1]?.emitExit(null, "SIGKILL");
		const serialPath = sessionPathsForTest(h.service.status().sessionId ?? "").serialPath;
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.message).toContain("died again after its one relaunch");
			expect(r.message).toContain(serialPath);
		}
		expect(h.service.state).toBe("failed");
		const again = await h.service.ensureReady();
		expect(again.ok).toBe(false);
		if (!again.ok) expect(again.message).toContain("died again after its one relaunch");
		expect(h.calls.prepareSession.length).toBe(2); // never a third boot
	});
});

describe("VmService — persist rules", () => {
	it("retain: the minted id is stable, a retained overlay is REUSED (never re-prepared), stop keeps the dir", async () => {
		const h = harness(); // persist: retain
		await h.service.start();
		const id = h.service.status().sessionId ?? "";
		h.existingSessions.add(id); // the overlay now exists on "disk"

		h.handles[0]?.emitExit(0, null);
		await h.service.ensureReady(); // relaunch
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.service.status().sessionId).toBe(id);
		expect(h.calls.prepareSession.length).toBe(1); // the recovery path reuses, not re-creates
		expect(h.logs.some((line) => line.includes("reusing retained session"))).toBe(true);

		const outcome = await h.service.stop();
		expect(outcome.overlayRemoved).toBe(false);
		expect(h.calls.removedDirs).toEqual([]);
	});

	it("retain with a pinned MCP_VM_SESSION_ID: the pinned id survives stop→start", async () => {
		const h = harness({ config: { sessionId: "pinned-session" } });
		await h.service.start();
		expect(h.service.status().sessionId).toBe("pinned-session");
		h.existingSessions.add("pinned-session");
		await h.service.stop();
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.service.status().sessionId).toBe("pinned-session");
		expect(h.calls.prepareSession.length).toBe(1);
	});

	it("retain refuses (never destroys) an incomplete retained session", async () => {
		const h = harness({ config: { sessionId: "torn-session" }, varsMissingFor: new Set(["torn-session"]) });
		h.existingSessions.add("torn-session"); // the overlay exists; the VARS half does not
		await h.service.start();
		expect(h.service.state).toBe("failed");
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("retained session torn-session is incomplete");
		expect(h.calls.prepareSession.length).toBe(0); // nothing was re-created over it
	});

	it("discard: fresh id per boot, stop removes the dir", async () => {
		const h = harness({ config: { persist: "discard" } });
		await h.service.start();
		const id = h.service.status().sessionId ?? "";
		const outcome = await h.service.stop();
		expect(outcome.overlayRemoved).toBe(true);
		expect(h.calls.removedDirs).toEqual([sessionPathsForTest(id).sessionDir]);
		await h.service.start();
		expect(h.service.status().sessionId ?? "").not.toBe(id);
		expect(h.calls.prepareSession.length).toBe(2);
	});

	it("persist auto resolves per mode at teardown: agent discards, vm retains", async () => {
		const agent = harness({ config: { mode: "agent", persist: "auto" } });
		await agent.service.start();
		expect(await agent.service.stop()).toMatchObject({ overlayRemoved: true });

		const vm = harness({ config: { mode: "vm", persist: "auto" } });
		await vm.service.start();
		expect(await vm.service.stop()).toMatchObject({ overlayRemoved: false });
	});
});

describe("VmService — stop", () => {
	it("ACPI powerdown exits the guest: no ladder, no capture, dir kept, state stopped", async () => {
		const h = harness({
			onPowerdown: (handle) => handle.emitExit(0, null),
		});
		await h.service.start();
		const outcome = await h.service.stop();
		expect(outcome).toEqual({ path: "powerdown", overlayRemoved: false });
		expect(h.handles[0]?.qmpFake.commands).toEqual(["system_powerdown"]);
		expect(h.calls.stopQemu).toBe(0); // the ladder never ran
		expect(h.calls.capture.length).toBe(0); // a clean end captures nothing
		expect(h.calls.closeMux).toBe(1); // the backend's ControlMaster was torn down
		expect(h.calls.removedDirs).toEqual([]); // retain keeps the overlay
		expect(h.service.state).toBe("stopped");
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("sandbox stopped");
	});

	it("wedged guest: the powerdown budget expires → capture, then the ladder (quit → SIGTERM)", async () => {
		const h = harness(); // no onPowerdown: the guest ignores the button, quit, and only dies on TERM
		await h.service.start();
		const outcome = await h.service.stop();
		expect(outcome.path).toBe("sigterm");
		expect(h.handles[0]?.qmpFake.commands).toEqual(["system_powerdown", "quit"]);
		expect(h.calls.capture.length).toBe(1); // evidence before the force
		expect(h.calls.stopQemu).toBe(1);
		expect(h.handles[0]?.signals).toEqual(["SIGTERM"]);
		expect(h.service.state).toBe("stopped");
	});

	it("stop before any start is a no-op 'none'; stop closes the backend mux", async () => {
		const h = harness();
		expect(await h.service.stop()).toEqual({ path: "none", overlayRemoved: false });
		expect(h.service.state).toBe("stopped");
	});
});

describe("VmService — idle reaper (opt-in)", () => {
	it("fires after idleTimeoutMs with no tool activity: capture, then the clean stop", async () => {
		const h = harness({
			config: { idleTimeoutMs: 20 },
			onPowerdown: (handle) => handle.emitExit(0, null), // a clean poweroff — one capture, no ladder
		});
		await h.service.start();
		await waitFor(() => h.service.state === "stopped", 2_000);
		expect(h.calls.capture.length).toBe(1);
		expect(h.logs.some((line) => line.includes("idle 20 ms"))).toBe(true);
		expect(h.service.status().state).toBe("stopped");
	});

	it("resets on tool activity: repeated ensureReady keeps the session alive past the timeout", async () => {
		const h = harness({ config: { idleTimeoutMs: 60 } });
		await h.service.start();
		for (let i = 0; i < 6; i++) {
			await realSleep(30);
			const r = await h.service.ensureReady();
			expect(r.ok).toBe(true);
		}
		expect(h.service.state).toBe("ready"); // ~180 ms of activity, no reap
		await realSleep(150);
		await waitFor(() => h.service.state === "stopped", 2_000);
	});
});

describe("VmService — disk-cap hook", () => {
	it("over-cap actual-size: a WARNING line at boot and teardown — never fatal", async () => {
		const h = harness({ config: { diskCapGb: 1 }, qemuImgActualSize: 2 * GIB });
		await h.service.start();
		expect(h.service.state).toBe("ready");
		expect(h.logs.some((line) => line.includes("WARNING (boot)") && line.includes("over the 1G disk cap"))).toBe(
			true,
		);
		await h.service.stop();
		expect(h.logs.some((line) => line.includes("WARNING (teardown)"))).toBe(true);
	});

	it("under-cap stays silent; an unmeasurable overlay (qemu-img fails) is skipped silently", async () => {
		const quiet = harness({ qemuImgActualSize: 200_704 });
		await quiet.service.start();
		expect(quiet.logs.some((line) => line.includes("WARNING"))).toBe(false);

		const broken = harness({ qemuImgActualSize: null });
		await broken.service.start();
		expect(broken.service.state).toBe("ready");
		expect(broken.logs.some((line) => line.includes("WARNING"))).toBe(false);
	});
});

describe("VmService — the mode-A extras hook (a no-op parameter here)", () => {
	it("runs between phase 2 and ready with the session context", async () => {
		const seen: string[] = [];
		const h = harness({
			afterReady: async (context) => {
				seen.push(context.sessionId);
				expect(context.manifest.guestUser).toBe("sandbox");
			},
		});
		await h.service.start();
		expect(seen.length).toBe(1);
		expect(seen[0]).toBe(h.service.status().sessionId);
	});

	it("a throw follows the normal failure path (capture + teardown + failed)", async () => {
		const h = harness({
			afterReady: async () => {
				throw new Error("mode-A extras exploded");
			},
		});
		await h.service.start();
		expect(h.service.state).toBe("failed");
		const r = await h.service.ensureReady();
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.message).toContain("mode-A extras exploded");
		expect(h.calls.capture.length).toBe(1);
	});
});

describe("VmService — construction guard", () => {
	it("mode off throws (the zero-VM-code pin: an off boot constructs none of this)", () => {
		expect(() => createVmService(vmConfig({ mode: "off" }))).toThrow(
			"VmService requires a VM mode (vm or agent) — an off boot runs zero VM code",
		);
	});
});
