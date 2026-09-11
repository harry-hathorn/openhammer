import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ensureVmDir,
	isOurQemu,
	type ProcIdentity,
	prepareSession,
	type RunQemuImg,
	resolveVmDirs,
	type SweepDeps,
	sweepStaleSessions,
} from "./session.ts";

/** A fresh HOME per test — the whole vm tree roots inside it; nothing real is touched. */
function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "openhammer-session-"));
}

function sessionsRoot(home: string): string {
	return join(home, ".openhammer", "vm", "sessions");
}

function sessionDirOf(home: string, id: string): string {
	return join(sessionsRoot(home), id);
}

/** A recorded, always-succeeding qemu-img (the hermetic seam). */
function fakeQemuImg(): { run: RunQemuImg; calls: string[][] } {
	const calls: string[][] = [];
	const run: RunQemuImg = async (args) => {
		calls.push([...args]);
		return { code: 0, stdoutTail: "Formatting, filename=…, size=…", stderrTail: "" };
	};
	return { run, calls };
}

/** A pristine VARS template fixture with known bytes. */
function varsTemplate(home: string): string {
	const path = join(home, "OVMF_VARS.template.fd");
	writeFileSync(path, "VARS-TEMPLATE-BYTES");
	return path;
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * A session dir fixture: a 0700 dir, a pidfile with the given contents, and (when
 * `payloadBytes` > 0) an overlay of exactly those bytes plus an 8-byte serial.log. Returns
 * the dir's expected total size on disk (what a removal reclaims).
 */
function writeSession(
	home: string,
	id: string,
	pidfile: string | undefined,
	payloadBytes = 0,
): { dir: string; bytes: number } {
	const dir = sessionDirOf(home, id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	let bytes = 0;
	if (pidfile !== undefined) {
		writeFileSync(join(dir, "qemu.pid"), pidfile);
		bytes += pidfile.length;
	}
	if (payloadBytes > 0) {
		writeFileSync(join(dir, "overlay.qcow2"), "o".repeat(payloadBytes));
		writeFileSync(join(dir, "serial.log"), "\n".repeat(8));
		bytes += payloadBytes + 8;
	}
	return { dir, bytes };
}

describe("resolveVmDirs", () => {
	it("roots the tree at ~/.openhammer/vm with the five subdirs", () => {
		const dirs = resolveVmDirs();
		expect(dirs.root).toBe(join(homedir(), ".openhammer", "vm"));
		expect(dirs.sessions).toBe(join(dirs.root, "sessions"));
		expect(dirs.images).toBe(join(dirs.root, "images"));
		expect(dirs.isos).toBe(join(dirs.root, "isos"));
		expect(dirs.cidata).toBe(join(dirs.root, "cidata"));
		expect(dirs.secrets).toBe(join(dirs.root, "secrets"));
	});

	it("honors the homeDir override (tests and any future env seam)", () => {
		const home = tempHome();
		expect(resolveVmDirs({ homeDir: home }).root).toBe(join(home, ".openhammer", "vm"));
	});
});

describe("prepareSession", () => {
	it("creates the 0700 layout, the exact overlay argv, and the VARS copy; returns every path", async () => {
		const home = tempHome();
		const template = varsTemplate(home);
		const { run, calls } = fakeQemuImg();
		const golden = join(home, "images", "golden.qcow2");

		const paths = await prepareSession(
			"s1",
			{ goldenDiskPath: golden },
			{ homeDir: home, runQemuImg: run, varsTemplate: template },
		);

		const sessionDir = sessionDirOf(home, "s1");
		expect(paths).toEqual({
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
		});
		// The tree: root → sessions → <id> → debug, all 0700.
		expect(mode(join(home, ".openhammer", "vm"))).toBe(0o700);
		expect(mode(sessionsRoot(home))).toBe(0o700);
		expect(mode(sessionDir)).toBe(0o700);
		expect(mode(paths.debugDir)).toBe(0o700);
		// The overlay: the golden's backing chain, exactly one argv, no size argument (the
		// virtual size inherits the golden's).
		expect(calls).toEqual([["create", "-f", "qcow2", "-b", golden, "-F", "qcow2", paths.overlayPath]]);
		// The writable VARS copy: the template's bytes, per session.
		expect(readFileSync(paths.varsPath, "utf8")).toBe("VARS-TEMPLATE-BYTES");
	});

	it("rejects with the qemu-img stderr tail when the overlay create fails", async () => {
		const home = tempHome();
		const template = varsTemplate(home);
		const failing: RunQemuImg = async () => ({
			code: 1,
			stdoutTail: "",
			stderrTail: "qemu-img: Could not open backing file: nope.qcow2",
		});
		await expect(
			prepareSession(
				"s2",
				{ goldenDiskPath: "/gone.qcow2" },
				{ homeDir: home, runQemuImg: failing, varsTemplate: template },
			),
		).rejects.toThrow("qemu-img create overlay failed (exit 1): qemu-img: Could not open backing file: nope.qcow2");
	});

	it("rejects ids that are not single safe path segments", async () => {
		const home = tempHome();
		const template = varsTemplate(home);
		const { run } = fakeQemuImg();
		const badIds = ["../escape", "a/b", "", ".hidden", "-leading-dash", "has space", "x".repeat(65)];
		for (const bad of badIds) {
			await expect(
				prepareSession(
					bad,
					{ goldenDiskPath: "/g.qcow2" },
					{ homeDir: home, runQemuImg: run, varsTemplate: template },
				),
			).rejects.toThrow("session id is not a safe path segment");
		}
	});
});

describe("isOurQemu — the recycled-PID guard", () => {
	const table: Array<{ identity: ProcIdentity; expected: boolean; why: string }> = [
		{
			identity: { comm: "qemu-system-x86", cmdline: "/usr/bin/qemu-system-x86_64 -name openhammer-vm-s1" },
			expected: true,
			why: "ours: the 15-char-truncated comm plus the full name in cmdline",
		},
		{
			identity: { comm: "qemu-system-x86" },
			expected: true,
			why: "ours: the comm prefix alone when cmdline is unreadable (best provable evidence)",
		},
		{
			identity: { comm: "chrome", cmdline: "/usr/bin/chrome --renderer" },
			expected: false,
			why: "foreign comm",
		},
		{
			identity: { comm: "qemu-system-x86", cmdline: "/opt/other/qemu-system-i386" },
			expected: false,
			why: "the comm prefix matches but the cmdline names a different binary",
		},
		{
			identity: { cmdline: "/usr/bin/qemu-system-x86_64" },
			expected: false,
			why: "no readable comm — unverifiable is not provably ours",
		},
	];
	for (const row of table) {
		it(`${row.expected ? "accepts" : "rejects"} — ${row.why}`, () => {
			expect(isOurQemu(row.identity)).toBe(row.expected);
		});
	}
});

/** Sweep deps scripted per pid: an identity map + a recording kill. */
function sweepDeps(
	home: string,
	identities: Readonly<Record<number, ProcIdentity>>,
): { deps: SweepDeps; kills: Array<{ pid: number; signal: string }> } {
	const kills: Array<{ pid: number; signal: string }> = [];
	const deps: SweepDeps = {
		homeDir: home,
		readProc: (pid: number): ProcIdentity => identities[pid] ?? {},
		kill: (pid: number, signal: "SIGKILL"): void => {
			kills.push({ pid, signal });
		},
	};
	return { deps, kills };
}

describe("sweepStaleSessions", () => {
	it("kills a live, verified-ours qemu and removes its dir (nothing in it is trusted)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "ours-1", "4242", 1000);
		const { deps, kills } = sweepDeps(home, {
			4242: { comm: "qemu-system-x86", cmdline: "/usr/bin/qemu-system-x86_64 -name openhammer-vm-ours-1" },
		});
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({ killed: 1, skippedForeign: 0, removedDirs: 1, bytesReclaimed: fixture.bytes });
		expect(kills).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("removes a dead pid's dir as stale (ESRCH — no /proc entry)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "stale-1", "999");
		const { deps, kills } = sweepDeps(home, {}); // pid 999 → no identity → dead
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 1, bytesReclaimed: fixture.bytes });
		expect(kills).toEqual([]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("keeps a dir whose pidfile names a live FOREIGN process (the recycled PID)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "foreign-1", "777", 500);
		const { deps, kills } = sweepDeps(home, { 777: { comm: "chrome", cmdline: "/usr/bin/chrome" } });
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({ killed: 0, skippedForeign: 1, removedDirs: 0, bytesReclaimed: 0 });
		expect(kills).toEqual([]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("keeps a comm-prefix match whose cmdline names a different binary", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "sneaky-1", "555");
		const { deps } = sweepDeps(home, { 555: { comm: "qemu-system-x86", cmdline: "/opt/emu/qemu-system-i386" } });
		const report = await sweepStaleSessions(deps);
		expect(report.skippedForeign).toBe(1);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("leaves dirs without a pidfile alone (mid-prepare — no mtime heuristics)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "mid-prepare", undefined);
		writeFileSync(join(fixture.dir, "meta.json"), "{}");
		const { deps, kills } = sweepDeps(home, {});
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0 });
		expect(kills).toEqual([]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("leaves a garbage pidfile alone (unverifiable is not stale)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "garbage-1", "not-a-pid");
		const { deps } = sweepDeps(home, {});
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0 });
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("treats a kill that races ESRCH as stale: dir removed, not counted as killed", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "raced-1", "31337");
		const kills: Array<{ pid: number; signal: string }> = [];
		const deps: SweepDeps = {
			homeDir: home,
			readProc: (): ProcIdentity => ({ comm: "qemu-system-x86", cmdline: "/usr/bin/qemu-system-x86_64" }),
			kill: (pid: number, signal: "SIGKILL"): void => {
				kills.push({ pid, signal });
				throw new Error("kill ESRCH");
			},
		};
		const report = await sweepStaleSessions(deps);
		expect(kills).toEqual([{ pid: 31337, signal: "SIGKILL" }]);
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 1, bytesReclaimed: fixture.bytes });
	});

	it("sweeps a mixed sessions dir to one honest report; stray files are not sessions", async () => {
		const home = tempHome();
		const ours = writeSession(home, "live-ours", "111", 100);
		const dead = writeSession(home, "dead", "222", 40);
		const foreign = writeSession(home, "foreign", "333", 10);
		const noPid = writeSession(home, "no-pidfile-dir", undefined);
		writeFileSync(join(sessionsRoot(home), "stray.txt"), "not a session");
		const { deps, kills } = sweepDeps(home, {
			111: { comm: "qemu-system-x86", cmdline: "qemu-system-x86_64" },
			333: { comm: "systemd", cmdline: "/usr/lib/systemd/systemd" },
		});
		const report = await sweepStaleSessions(deps);
		expect(report).toEqual({
			killed: 1, // 111, killed + removed
			skippedForeign: 1, // 333, kept
			removedDirs: 2, // live-ours + dead; no-pidfile-dir kept (mid-prepare rule)
			bytesReclaimed: ours.bytes + dead.bytes,
		});
		expect(kills).toEqual([{ pid: 111, signal: "SIGKILL" }]);
		for (const kept of [foreign.dir, noPid.dir]) {
			expect(statSync(kept, { throwIfNoEntry: false })).toBeDefined();
		}
		expect(statSync(ours.dir, { throwIfNoEntry: false })).toBeUndefined();
	});

	it("is a no-op report when the sessions root does not exist yet (first boot)", async () => {
		const home = tempHome();
		const report = await sweepStaleSessions({ homeDir: home });
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0 });
	});

	it("preserve: a dead pid's dir in the preserve set is KEPT and counted preserved (the pinned-retain recovery dir)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "pinned-dead", "999", 40);
		const { deps, kills } = sweepDeps(home, {}); // pid 999 → no identity → dead, but pinned
		const report = await sweepStaleSessions(deps, { preserve: new Set(["pinned-dead"]) });
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0, preserved: 1 });
		expect(kills).toEqual([]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("preserve: a live-ours orphan in the preserve set is SIGKILLed but its dir KEPT (the retained reuse path)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "pinned-ours", "4242", 1000);
		const { deps, kills } = sweepDeps(home, {
			4242: { comm: "qemu-system-x86", cmdline: "/usr/bin/qemu-system-x86_64 -name openhammer-vm-pinned-ours" },
		});
		const report = await sweepStaleSessions(deps, { preserve: new Set(["pinned-ours"]) });
		expect(report).toEqual({ killed: 1, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0, preserved: 1 });
		expect(kills).toEqual([{ pid: 4242, signal: "SIGKILL" }]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("preserve: a kill racing ESRCH on a preserved dir keeps the dir too (stale-but-pinned)", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "pinned-raced", "31337", 10);
		const kills: Array<{ pid: number; signal: string }> = [];
		const deps: SweepDeps = {
			homeDir: home,
			readProc: (): ProcIdentity => ({ comm: "qemu-system-x86", cmdline: "/usr/bin/qemu-system-x86_64" }),
			kill: (pid: number, signal: "SIGKILL"): void => {
				kills.push({ pid, signal });
				throw new Error("kill ESRCH");
			},
		};
		const report = await sweepStaleSessions(deps, { preserve: new Set(["pinned-raced"]) });
		expect(kills).toEqual([{ pid: 31337, signal: "SIGKILL" }]);
		expect(report).toEqual({ killed: 0, skippedForeign: 0, removedDirs: 0, bytesReclaimed: 0, preserved: 1 });
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("preserve changes nothing for a foreign-pid dir: skipped-foreign, kept, no preserved removal", async () => {
		const home = tempHome();
		const fixture = writeSession(home, "pinned-foreign", "777", 500);
		const { deps, kills } = sweepDeps(home, { 777: { comm: "chrome", cmdline: "/usr/bin/chrome" } });
		const report = await sweepStaleSessions(deps, { preserve: new Set(["pinned-foreign"]) });
		expect(report).toEqual({ killed: 0, skippedForeign: 1, removedDirs: 0, bytesReclaimed: 0, preserved: 0 });
		expect(kills).toEqual([]);
		expect(statSync(fixture.dir, { throwIfNoEntry: false })).toBeDefined();
	});

	it("preserve is by NAME: the named dir is kept, every other dir sweeps as today", async () => {
		const home = tempHome();
		const pinned = writeSession(home, "pinned-mixed", "999", 40);
		const other = writeSession(home, "unpinned-mixed", "998", 10);
		const { deps } = sweepDeps(home, {});
		const report = await sweepStaleSessions(deps, { preserve: new Set(["pinned-mixed"]) });
		expect(report).toEqual({
			killed: 0,
			skippedForeign: 0,
			removedDirs: 1,
			bytesReclaimed: other.bytes,
			preserved: 1,
		});
		expect(statSync(pinned.dir, { throwIfNoEntry: false })).toBeDefined();
		expect(statSync(other.dir, { throwIfNoEntry: false })).toBeUndefined();
	});
});

describe("ensureVmDir", () => {
	it("creates deep paths 0700 (recursive)", async () => {
		const home = tempHome();
		const path = join(home, ".openhammer", "vm", "isos", "ubuntu");
		await ensureVmDir(path);
		expect(mode(path)).toBe(0o700);
		expect(mode(join(home, ".openhammer", "vm", "isos"))).toBe(0o700);
	});
});
