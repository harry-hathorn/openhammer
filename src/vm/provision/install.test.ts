import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { goldenManifestExists } from "../../config/sections.ts";
import { qemuBootArgs } from "../qemu/args.ts";
import type { QemuExit, QemuHandle } from "../qemu/process.ts";
import type { QmpClient } from "../qmp/client.ts";
import { resolveVmDirs, type VmDirs } from "../session.ts";
import { type BinRunResult, type CidataBuild, type CidataInput, DISK_BYTES } from "./cidata.ts";
import { defaultGuestConfig, saveGuestConfig } from "./guest-config.ts";
import {
	type ActiveSession,
	DEFAULT_BUDGET_MINUTES,
	type DiskSample,
	type InstallDeps,
	newestGoldenId,
	runInstall,
	scanActiveVmSessions,
} from "./install.ts";
import { ISO_NAME, ISO_SHA256, ISO_URL } from "./iso.ts";

const PORT = 41733;
const PASSWORD = "test-recovery-password";
const TEMPLATE_BYTES = "fake-ovmf-vars-template";

/** One install-mode ssh call, as the seam sees it. */
interface SshCall {
	readonly user: string;
	readonly port: number;
	readonly keyPath: string;
	readonly command: string;
	readonly stdin?: string;
}

/** The per-test behavior knobs; every default produces the full happy path. */
interface HarnessOptions {
	/** The ssh responder (default: `true` answers rc 0, poweroff rc 0 + the guest exits). */
	readonly ssh?: (call: SshCall) => BinRunResult;
	/** The stop-ladder outcome (default "quit"). */
	readonly stopPath?: "quit" | "sigterm" | "sigkill" | "already-exited";
	/** The scripted disk samples, popped per diskInfo call (last repeats; default one final sample). */
	readonly diskSamples?: DiskSample[];
	/** The port discovery (default: resolves PORT immediately). */
	readonly discover?: () => Promise<number>;
	/** The sleeper (default: advances the fake clock by the slept ms). */
	readonly sleep?: (ms: number) => Promise<void>;
	/** The single-flight scan result (default: no active sessions). */
	readonly scan?: ActiveSession[];
	/** The rebuild probe's scripted golden id (default: none — a fresh tree, no warning). */
	readonly goldenId?: string | null;
	/** Make the teardown capture reject (default: records + succeeds). */
	readonly captureFails?: boolean;
}

/**
 * The full fake install world: every external seam injected, a fake clock that only moves
 * when the runner sleeps, and a fake QEMU whose exit is flipped by the ssh responder when
 * the guest is told to power off — exactly the real causality. ZERO real binaries/network.
 */
function harness(options: HarnessOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "openhammer-install-"));
	const dirs = resolveVmDirs({ homeDir: home });
	const logs: string[] = [];
	const clock = { now: 1_700_000_000_000 };
	const exit: { current?: QemuExit } = {};
	const sshCalls: SshCall[] = [];
	const qmpCommands: string[] = [];
	const qemuImgCalls: string[][] = [];
	const captureCalls: Array<{ serialPath: string; debugDir: string }> = [];
	const stopCalls: QemuHandle[] = [];
	const isoCalls: VmDirs[] = [];
	let qemuArgv: readonly string[] | undefined;
	let qemuStartSessionDir: string | undefined;
	let cidataInput: CidataInput | undefined;

	// The guest user the product must thread everywhere: a saved guest.json, not the default.
	saveGuestConfig(dirs, { ...defaultGuestConfig(), hostname: "build-box", username: "builder" });

	const varsTemplate = join(home, "OVMF_VARS.template");
	writeFileSync(varsTemplate, TEMPLATE_BYTES);

	const defaultSsh = (call: SshCall): BinRunResult => {
		if (call.command === "sudo -S systemctl poweroff") {
			exit.current = { code: 0, signal: null }; // the guest powers off when told
		}
		return { code: 0, stdoutTail: "", stderrTail: "" };
	};
	const ssh = options.ssh ?? defaultSsh;

	const qmp: QmpClient = {
		greetingLine: '{"QMP": {"version": {"qemu": {"major": 11}}}}',
		capabilitiesReturn: {},
		execute: async (command: string) => {
			qmpCommands.push(command);
			return { status: "running" };
		},
		humanMonitorCommand: async () => "",
		close: () => {},
		closed: new Promise<string>(() => {}),
	};
	const handle: QemuHandle = {
		pid: 424242,
		qmp,
		exited: new Promise<QemuExit>(() => {}),
		exitInfo: () => exit.current,
		kill: () => true,
		stderrTail: async () => "fake-qemu-stderr-tail",
	};

	let diskIndex = 0;
	const samples = options.diskSamples ?? [{ virtualSize: DISK_BYTES, actualSize: 6_233_722_880 }];

	const deps: InstallDeps = {
		homeDir: home,
		log: (line) => logs.push(line),
		now: () => clock.now,
		sleep:
			options.sleep ??
			(async (ms: number) => {
				clock.now += ms;
			}),
		scanActiveSessions: async () => options.scan ?? [],
		newestGoldenId: () => options.goldenId ?? null,
		ensureIso: async (d) => {
			isoCalls.push(d);
			return { path: join(d.isos, ISO_NAME), action: "cached", size: 6_260_654_080, sha256: ISO_SHA256 };
		},
		buildCidata: async (input) => {
			cidataInput = input;
			writeFileSync(input.recoveryPath, `${PASSWORD}\n`);
			const build: CidataBuild = {
				dir: join(input.dirs.cidata, input.name),
				isoPath: join(input.dirs.cidata, `${input.name}.iso`),
				isoSize: 2048,
				privateKeyPath: join(input.dirs.root, "id_ed25519"),
				publicKey: "ssh-ed25519 AAAAOPENHAMMERTEST fake",
				recoveryPasswordPath: input.recoveryPath,
			};
			return build;
		},
		startQemu: async (argv, opts) => {
			qemuArgv = [...argv];
			qemuStartSessionDir = opts.sessionDir;
			return handle;
		},
		stopQemu: async (h) => {
			stopCalls.push(h);
			return { path: options.stopPath ?? "quit", detail: "fake ladder" };
		},
		discoverSshPort: options.discover ?? (async () => PORT),
		sshExec: async (user, port, keyPath, command, opts) => {
			const call: SshCall = { user, port, keyPath, command, stdin: opts?.stdin };
			sshCalls.push(call);
			return ssh(call);
		},
		diskInfo: async (path) => {
			void path;
			const sample = samples[Math.min(diskIndex, samples.length - 1)];
			diskIndex += 1;
			return sample;
		},
		capture: async (paths) => {
			captureCalls.push({ serialPath: paths.serialPath, debugDir: paths.debugDir });
			if (options.captureFails) {
				throw new Error("broken debug dir");
			}
			return { dir: paths.debugDir, files: [] };
		},
		varsTemplate,
		runQemuImg: async (args) => {
			qemuImgCalls.push([...args]);
			return { code: 0, stdoutTail: "", stderrTail: "" };
		},
	};

	return {
		home,
		dirs,
		deps,
		logs,
		clock,
		sshCalls,
		qmpCommands,
		qemuImgCalls,
		captureCalls,
		stopCalls,
		isoCalls,
		exit,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
		qemuArgv: () => qemuArgv,
		qemuStartSessionDir: () => qemuStartSessionDir,
		cidataInput: () => cidataInput,
	};
}

describe("runInstall — happy path", () => {
	it("builds end to end: iso cache hit, cidata, blank 40G disk, boot, gate, clean poweroff", async () => {
		const h = harness({ diskSamples: [{ virtualSize: DISK_BYTES, actualSize: 6_257_840_128 }] });
		try {
			const result = await runInstall(h.deps, { sessionName: "build-test" });
			const sessionDir = join(h.dirs.sessions, "build-test");
			expect(result).toEqual({
				sessionDir,
				wallClockSeconds: 10, // the one sleep: the 10 s confirm gap
				diskVirtualBytes: DISK_BYTES,
				diskActualBytes: 6_257_840_128,
				shutdownPath: "guest-poweroff",
			});
			// ISO came from the resolved tree (cached).
			expect(h.isoCalls).toEqual([h.dirs]);
			// cidata got the SAVED guest config + the session-local recovery path.
			expect(h.cidataInput()?.config.username).toBe("builder");
			expect(h.cidataInput()?.recoveryPath).toBe(join(sessionDir, "luks-or-sudo-password.txt"));
			// The blank disk: numeric DISK_BYTES (the partition-geometry lockstep).
			expect(h.qemuImgCalls).toEqual([
				["create", "-f", "qcow2", join(sessionDir, "disk.qcow2"), String(DISK_BYTES)],
			]);
			// The boot argv: the install triple wired through 24c's builder.
			expect(h.qemuArgv()).toEqual(
				qemuBootArgs({
					name: "build-test",
					sessionDir,
					disks: {
						targetDiskPath: join(sessionDir, "disk.qcow2"),
						isoPath: join(h.dirs.isos, ISO_NAME),
						cidataIsoPath: join(h.dirs.cidata, "build-test.iso"),
					},
				}),
			);
			expect(h.qemuStartSessionDir()).toBe(sessionDir);
			// The VARS copy landed from the injected template.
			expect(readFileSync(join(sessionDir, "OVMF_VARS.4m.fd"), "utf8")).toBe(TEMPLATE_BYTES);
			// The ssh trail: two `true` round-trips + the poweroff with the recovery password.
			expect(h.sshCalls.map((c) => [c.user, c.port, c.command])).toEqual([
				["builder", PORT, "true"],
				["builder", PORT, "true"],
				["builder", PORT, "sudo -S systemctl poweroff"],
			]);
			expect(h.sshCalls[2]?.stdin).toBe(`${PASSWORD}\n`);
			expect(h.sshCalls.every((c) => c.keyPath === join(h.dirs.root, "id_ed25519"))).toBe(true);
			// Clean path: NO capture, NO ladder.
			expect(h.captureCalls).toEqual([]);
			expect(h.stopCalls).toEqual([]);
			// Observability + the run log.
			expect(h.logs.some((line) => line.includes("ssh CONFIRMED user=builder — gate passed"))).toBe(true);
			const runLog = readFileSync(join(sessionDir, "install.log"), "utf8");
			expect(runLog).toContain("guest user: builder");
			expect(runLog).toContain("gate: PASSED (user=builder)");
			expect(runLog).toContain("shutdown: guest-poweroff");
			expect(runLog).toContain("qemu.stderr tail: fake-qemu-stderr-tail");
		} finally {
			h.cleanup();
		}
	});

	it("the default session name is a build-<stamp> safe segment", async () => {
		const h = harness();
		try {
			const result = await runInstall(h.deps);
			expect(basename(result.sessionDir)).toMatch(/^build-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/);
		} finally {
			h.cleanup();
		}
	});

	it("an unsafe session name is refused before anything runs", async () => {
		const h = harness();
		try {
			await expect(runInstall(h.deps, { sessionName: "../evil" })).rejects.toThrow(
				"vm install: session name is not a safe path segment",
			);
			expect(h.isoCalls).toEqual([]);
		} finally {
			h.cleanup();
		}
	});
});

describe("runInstall — failures", () => {
	it("budget expiry throws with the disk-growth samples, serial-log path, capture, and the ladder", async () => {
		const h = harness({
			ssh: (call) =>
				call.command === "true"
					? { code: 1, stdoutTail: "", stderrTail: "refused" }
					: { code: 0, stdoutTail: "", stderrTail: "" },
			diskSamples: [
				{ virtualSize: DISK_BYTES, actualSize: 200_704 },
				{ virtualSize: DISK_BYTES, actualSize: 4_000_000_000 },
				{ virtualSize: DISK_BYTES, actualSize: 4_100_000_000 },
			],
		});
		try {
			await expect(runInstall(h.deps, { sessionName: "build-budget", budgetMinutes: 2 })).rejects.toThrow(
				new RegExp(
					[
						"vm install: no ssh gate within the 2 min budget",
						"disk grew 3999799296 B \\(first 200704 → last 4000000000\\)",
						"last status running",
						`serial log ${join(h.dirs.sessions, "build-budget", "serial.log").replaceAll("/", "\\/")}`,
						"session kept at",
						"qemu stderr: fake-qemu-stderr-tail",
						"plan B is the manual GTK install path",
					].join(".*"),
				),
			);
			// Non-clean teardown: capture BEFORE the ladder, both exactly once.
			expect(h.captureCalls).toEqual([
				{
					serialPath: join(h.dirs.sessions, "build-budget", "serial.log"),
					debugDir: join(h.dirs.sessions, "build-budget", "debug"),
				},
			]);
			expect(h.stopCalls).toHaveLength(1);
			// The run log records the observed growth + the failure.
			const runLog = readFileSync(join(h.dirs.sessions, "build-budget", "install.log"), "utf8");
			expect(runLog).toContain("gate: FAILED");
			expect(runLog.match(/observe\|/g)?.length).toBe(2);
			expect(runLog).toContain("disk-actual=4000000000 (+3999799296)");
		} finally {
			h.cleanup();
		}
	});

	it("qemu exiting mid-install throws with the exit codes and the stderr tail", async () => {
		let sleeps = 0;
		const h = harness({
			ssh: (call) =>
				call.command === "true"
					? { code: 1, stdoutTail: "", stderrTail: "" }
					: { code: 0, stdoutTail: "", stderrTail: "" },
			sleep: async (ms) => {
				h.clock.now += ms;
				if (++sleeps === 1) h.exit.current = { code: 1, signal: null };
			},
		});
		try {
			await expect(runInstall(h.deps, { sessionName: "build-qemu-dies" })).rejects.toThrow(
				/qemu exited mid-install \(exitCode=1 signalCode=null\).*fake-qemu-stderr-tail/s,
			);
			expect(h.captureCalls).toHaveLength(1);
			expect(h.stopCalls).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});

	it("qemu exiting during the confirm gap is its own failure", async () => {
		let sleeps = 0;
		const h = harness({
			sleep: async (ms) => {
				h.clock.now += ms;
				if (++sleeps === 1) h.exit.current = { code: 0, signal: null };
			},
		});
		try {
			await expect(runInstall(h.deps, { sessionName: "build-gap-dies" })).rejects.toThrow(
				/qemu exited during the confirm gap \(exitCode=0\)/,
			);
		} finally {
			h.cleanup();
		}
	});

	it("a budgetMinutes of 0 or NaN is refused up front", async () => {
		const h = harness();
		try {
			await expect(runInstall(h.deps, { budgetMinutes: 0 })).rejects.toThrow(
				"vm install: budgetMinutes must be a positive number (got 0)",
			);
			await expect(runInstall(h.deps, { budgetMinutes: Number.NaN })).rejects.toThrow(
				"vm install: budgetMinutes must be a positive number (got NaN)",
			);
			expect(h.isoCalls).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	it("a SIGKILL ladder ending is a failure even with the gate passed (the corrupt-golden rule)", async () => {
		const h = harness({
			ssh: (call) =>
				call.command === "sudo -S systemctl poweroff"
					? { code: 255, stdoutTail: "", stderrTail: "Connection closed" }
					: { code: 0, stdoutTail: "", stderrTail: "" },
			stopPath: "sigkill",
		});
		try {
			// The poweroff never lands (rc 255, guest never exits) → the ladder → SIGKILL → refuse.
			await expect(runInstall(h.deps, { sessionName: "build-sigkill" })).rejects.toThrow(
				"qemu only died to SIGKILL — the disk cannot be trusted as a golden (rerun vm install)",
			);
			expect(h.captureCalls).toHaveLength(1);
		} finally {
			h.cleanup();
		}
	});

	it("a failing capture is logged and swallowed — the stop ladder still runs (no leaked qemu)", async () => {
		const h = harness({
			ssh: (call) =>
				call.command === "true"
					? { code: 1, stdoutTail: "", stderrTail: "" }
					: { code: 0, stdoutTail: "", stderrTail: "" },
			captureFails: true,
		});
		try {
			await expect(runInstall(h.deps, { sessionName: "build-bad-capture", budgetMinutes: 0.5 })).rejects.toThrow(
				"no ssh gate within the 0.5 min budget",
			);
			expect(h.captureCalls).toHaveLength(1); // it was attempted…
			expect(h.stopCalls).toHaveLength(1); // …and the ladder ran anyway
			expect(
				h.logs.some((line) =>
					line.includes("debug capture failed (continuing to the stop ladder): broken debug dir"),
				),
			).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

describe("runInstall — shutdown fallback + single-flight", () => {
	it("a poweroff that never lands records the ladder fallback and still succeeds (gate passed)", async () => {
		const h = harness({
			ssh: (call) =>
				call.command === "sudo -S systemctl poweroff"
					? { code: 255, stdoutTail: "", stderrTail: "Connection closed by remote host" }
					: { code: 0, stdoutTail: "", stderrTail: "" },
		});
		try {
			const result = await runInstall(h.deps, { sessionName: "build-slow-poweroff" });
			expect(result.shutdownPath).toBe("quit");
			expect(h.captureCalls).toHaveLength(1); // non-clean path captured
			expect(h.stopCalls).toHaveLength(1); // the ladder ran as the fallback
			const runLog = readFileSync(join(h.dirs.sessions, "build-slow-poweroff", "install.log"), "utf8");
			expect(runLog).toContain("poweroff: ssh sudo systemctl poweroff rc=255 Connection closed by remote host");
			expect(runLog).toContain("shutdown: quit");
		} finally {
			h.cleanup();
		}
	});

	it("refuses before ANY side effect when a session is active (the single-flight guard)", async () => {
		const live: ActiveSession = { sessionDir: "/home/x/.openhammer/vm/sessions/live-one", pid: 999 };
		const h = harness({ scan: [live] });
		try {
			await expect(runInstall(h.deps, { sessionName: "build-refused" })).rejects.toThrow(
				"vm install: a VM session is active — stop the session first: mode off + restart, " +
					"or Sandbox → Stop sandbox — /home/x/.openhammer/vm/sessions/live-one holds qemu pid 999",
			);
			expect(h.isoCalls).toEqual([]); // nothing ran: no iso, no qemu, no session dir
			expect(h.sshCalls).toEqual([]);
			expect(existsSync(join(h.dirs.sessions, "build-refused"))).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});

describe("runInstall — port discovery retry", () => {
	it("a discovery miss retries on the next tick and the install still gates", async () => {
		let discovers = 0;
		const h = harness({
			discover: async () => {
				discovers += 1;
				if (discovers === 1) {
					throw new Error("no hostfwd row in info usernet after 10 attempts");
				}
				return PORT;
			},
		});
		try {
			const result = await runInstall(h.deps, { sessionName: "build-retry" });
			expect(result.shutdownPath).toBe("guest-poweroff");
			expect(discovers).toBe(2);
			expect(h.logs.some((line) => line.includes(`usernet host port ${PORT}`))).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

describe("runInstall — default budget", () => {
	it("the default budget is 45 minutes (generous over the ~160 s measured reality)", () => {
		expect(DEFAULT_BUDGET_MINUTES).toBe(45);
	});
});

describe("scanActiveVmSessions", () => {
	it("reports only sessions whose pidfile names a live, verified-ours qemu", async () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-scan-"));
		try {
			const dirs = resolveVmDirs({ homeDir: home });
			const sessions = dirs.sessions;
			mkdirSync(join(sessions, "alpha"), { recursive: true });
			writeFileSync(join(sessions, "alpha", "qemu.pid"), "100\n");
			mkdirSync(join(sessions, "beta"), { recursive: true });
			writeFileSync(join(sessions, "beta", "qemu.pid"), "200\n"); // foreign (bash)
			mkdirSync(join(sessions, "gamma"), { recursive: true });
			writeFileSync(join(sessions, "gamma", "qemu.pid"), "300\n"); // dead pid
			mkdirSync(join(sessions, "delta"), { recursive: true });
			writeFileSync(join(sessions, "delta", "qemu.pid"), "not-a-pid\n"); // garbage
			mkdirSync(join(sessions, "epsilon"), { recursive: true }); // no pidfile
			mkdirSync(join(sessions, "zeta"), { recursive: true });
			writeFileSync(join(sessions, "zeta", "qemu.pid"), "400\n"); // comm matches, cmdline does not
			writeFileSync(join(sessions, "stray-file"), "not a session\n");

			const readProc = (pid: number) => {
				if (pid === 100) {
					return { comm: "qemu-system-x86", cmdline: "qemu-system-x86_64 -name openhammer-vm-alpha" };
				}
				if (pid === 200) {
					return { comm: "bash", cmdline: "bash" };
				}
				if (pid === 300) {
					return {}; // ESRCH shape — gone
				}
				if (pid === 400) {
					return { comm: "qemu-system-x86", cmdline: "/usr/bin/not-qemu-at-all" };
				}
				return {};
			};
			const active = await scanActiveVmSessions(dirs, { readProc });
			expect(active).toEqual([{ sessionDir: join(sessions, "alpha"), pid: 100 }]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("a missing sessions root is an empty scan, not an error", async () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-scan-none-"));
		try {
			expect(await scanActiveVmSessions(resolveVmDirs({ homeDir: home }))).toEqual([]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("runInstall — the rebuild warning (spec 28, matrix row 5)", () => {
	it("a golden on disk logs the pre-flight WARNING and the run PROCEEDS (a rebuild is legitimate)", async () => {
		const h = harness({ goldenId: "golden-4.0.3-20260910-070809" });
		try {
			const result = await runInstall(h.deps, { sessionName: "build-rebuild" });
			expect(result.shutdownPath).toBe("guest-poweroff"); // it ran to completion — a warning, never a block
			expect(h.logs).toContain(
				"install: WARNING: a golden already exists (golden-4.0.3-20260910-070809) — " +
					"rebuilding invalidates retained overlays (recovery path); consider `openhammer vm reset` first",
			);
			// Pre-flight: the warning lands before the FIRST side effect (the iso ensure).
			const warningAt = h.logs.findIndex((line) => line.includes("WARNING: a golden already exists"));
			const isoAt = h.logs.findIndex((line) => line.startsWith("iso:"));
			expect(warningAt).toBeGreaterThanOrEqual(0);
			expect(isoAt).toBeGreaterThan(warningAt);
		} finally {
			h.cleanup();
		}
	});

	it("no golden on disk → no warning line (a fresh install is quiet)", async () => {
		const h = harness();
		try {
			await runInstall(h.deps, { sessionName: "build-fresh" });
			expect(h.logs.some((line) => line.includes("a golden already exists"))).toBe(false);
		} finally {
			h.cleanup();
		}
	});
});

describe("newestGoldenId — the rebuild probe (the restated twin of goldenManifestExists)", () => {
	/** A manifest body that passes readManifest (manage.test.ts's canonical shape). */
	function fullManifest(id: string, builtAt: string): string {
		return `${JSON.stringify(
			{
				id,
				flavor: "base",
				guestUser: "sandbox",
				rootDir: "/home/sandbox",
				isoVersion: "4.0.3",
				isoUrl: ISO_URL,
				isoSha256: ISO_SHA256,
				diskVirtualSizeBytes: DISK_BYTES,
				provisionScriptHashes: null,
				builtAt,
				encrypt: false,
			},
			null,
			2,
		)}\n`;
	}

	/** Seed `images/<id>/` with a manifest body — or a corrupt / absent one. */
	function seedGoldenAt(dirs: VmDirs, id: string, body: string | "corrupt" | "none"): void {
		mkdirSync(join(dirs.images, id), { recursive: true });
		if (body === "corrupt") {
			writeFileSync(join(dirs.images, id, "manifest.json"), "{not json");
		} else if (body !== "none") {
			writeFileSync(join(dirs.images, id, "manifest.json"), body);
		}
	}

	it("empty tree → null, agreeing with the bootability probe", () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-golden-empty-"));
		try {
			expect(newestGoldenId(home)).toBeNull();
			expect(goldenManifestExists(home)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("one valid golden → its id; both probes agree the tree holds a golden", () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-golden-one-"));
		const id = "golden-4.0.3-20260910-070809";
		try {
			seedGoldenAt(resolveVmDirs({ homeDir: home }), id, fullManifest(id, "2026-09-10T07:08:09.000Z"));
			expect(newestGoldenId(home)).toBe(id);
			expect(goldenManifestExists(home)).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("two goldens → the NEWEST; a corrupt newest still orders by its id's stamp (the twin's fallback)", () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-golden-order-"));
		const oldest = "golden-4.0.3-20260801-000000";
		const newest = "golden-4.0.3-20260910-070809";
		try {
			const dirs = resolveVmDirs({ homeDir: home });
			seedGoldenAt(dirs, oldest, fullManifest(oldest, "2026-08-01T00:00:00.000Z"));
			seedGoldenAt(dirs, newest, "corrupt"); // no builtAt — the id's stamp orders it (still newest)
			expect(newestGoldenId(home)).toBe(newest);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("the deliberate divergence, pinned: a corrupt-manifest newest is a golden EXISTENCE (rebuild warns) but not bootable", () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-golden-diverge-"));
		const oldest = "golden-4.0.3-20260801-000000";
		const newest = "golden-4.0.3-20260910-070809";
		try {
			const dirs = resolveVmDirs({ homeDir: home });
			seedGoldenAt(dirs, oldest, fullManifest(oldest, "2026-08-01T00:00:00.000Z"));
			seedGoldenAt(dirs, newest, "corrupt");
			// The rebuild warning's probe answers "does a golden exist" (the doctor's
			// dir-level notion) — the displaced-prior-golden question. The dashboard's
			// Install-row probe answers "is a golden BOOTABLE" — on this tree it says no,
			// so the dashboard OFFERS Install while the CLI install warns the rebuild:
			// coherent (the rebuild is the remedy both surfaces point at), and pinned so
			// the difference can never drift silently.
			expect(newestGoldenId(home)).toBe(newest);
			expect(goldenManifestExists(home)).toBe(false);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
