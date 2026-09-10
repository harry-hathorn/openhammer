import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ProcIdentity, type RunQemuImg, resolveVmDirs, type VmDirs } from "../session.ts";
import { defaultGuestConfig, saveGuestConfig } from "./guest-config.ts";
import type { ActiveSession } from "./install.ts";
import { ISO_SHA256, ISO_URL } from "./iso.ts";
import { DEFAULT_KEEP_GOLDENS, type ManageDeps, vmGc, vmList, vmReset } from "./manage.ts";
import { GOLDEN_DISK_FILE } from "./snapshot.ts";

// ---- the fake world's fixed shapes ----

const VIRTUAL = 42_949_672_960;
const ACTUAL = 123_456;
const STALE_PID = 999_999; // readProc says dead — the stale classification
const FOREIGN_PID = 424_242; // readProc says a live non-qemu process — kept, never removal evidence

const NEWEST = "golden-4.0.3-20260910-070809";
const MIDDLE = "golden-4.0.3-20260905-010101";
const OLDEST = "golden-4.0.3-20260801-000000";

/** The three goldens' ids → the manifest builtAt each seeds (keeps ordering honest). */
const BUILT_AT: Record<string, string> = {
	[NEWEST]: "2026-09-10T07:08:09.000Z",
	[MIDDLE]: "2026-09-05T01:01:01.000Z",
	[OLDEST]: "2026-08-01T00:00:00.000Z",
};

/** A manifest that passes readManifest (snapshot.test.ts's canonical shape). */
function validManifest(id: string): Record<string, unknown> {
	return {
		id,
		flavor: "base",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: ISO_URL,
		isoSha256: ISO_SHA256,
		diskVirtualSizeBytes: VIRTUAL,
		provisionScriptHashes: null,
		builtAt: BUILT_AT[id] ?? "2026-09-10T07:08:09.000Z",
		encrypt: false,
	};
}

/** Seed `images/<id>/` with a golden.qcow2 + a valid manifest (or a corrupt/absent one). */
function seedGolden(
	dirs: VmDirs,
	id: string,
	manifest: "valid" | "corrupt" | "none" | Record<string, unknown> = "valid",
): string {
	const dir = join(dirs.images, id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, GOLDEN_DISK_FILE), "fake-golden-disk");
	if (manifest === "valid") {
		writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(validManifest(id), null, 2)}\n`);
	} else if (manifest === "corrupt") {
		writeFileSync(join(dir, "manifest.json"), "{not json");
	}
	return dir;
}

/** Seed a session dir: a pid naming a dead pid (stale), a live foreign pid, or no usable pidfile. */
function seedSession(dirs: VmDirs, name: string, pid: number | "none" | "garbage" = STALE_PID): string {
	const dir = join(dirs.sessions, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "overlay.qcow2"), "fake-overlay");
	if (pid === "garbage") {
		writeFileSync(join(dir, "qemu.pid"), "not-a-pid\n");
	} else if (pid !== "none") {
		writeFileSync(join(dir, "qemu.pid"), `${pid}\n`);
	}
	return dir;
}

/** Seed a cidata build (the dir + the packed iso) under `cidata/<name>`. */
function seedCidata(dirs: VmDirs, name: string): void {
	mkdirSync(join(dirs.cidata, name), { recursive: true });
	writeFileSync(join(dirs.cidata, name, "user_configuration.json"), "{}");
	writeFileSync(`${join(dirs.cidata, name)}.iso`, "fake-cidata-iso");
}

/** The per-test knobs; every default makes pid STALE_PID dead and FOREIGN_PID live-foreign. */
interface HarnessOptions {
	/** The single-flight scan result (default: no active sessions). */
	readonly scan?: ActiveSession[];
	/** Replace the whole qemu-img fake (default: actual-size for golden disks, backing-filename for overlays). */
	readonly qemuImg?: RunQemuImg;
	/** Exact byte footprints (default: the real recursive du over the temp tree). */
	readonly duOf?: (path: string) => Promise<number>;
}

/**
 * The full fake manage world: a real temp HOME, every external seam injected. ZERO real
 * binaries — qemu-img is faked, /proc is faked, the single-flight scan is faked; the
 * removals go through the REAL rmSync so the removal semantics are exercised for real.
 */
function harness(options: HarnessOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "openhammer-manage-"));
	const dirs = resolveVmDirs({ homeDir: home });
	const logs: string[] = [];
	const qemuImgCalls: string[][] = [];
	const overlayBacking = new Map<string, string>(); // overlay path → golden disk path

	const defaultQemuImg: RunQemuImg = async (args) => {
		qemuImgCalls.push([...args]);
		const path = args[3] ?? "";
		if (path.endsWith(GOLDEN_DISK_FILE)) {
			return {
				code: 0,
				stdoutTail: JSON.stringify({ "actual-size": ACTUAL, "virtual-size": VIRTUAL }),
				stderrTail: "",
			};
		}
		const backing = overlayBacking.get(path) ?? "";
		return { code: 0, stdoutTail: JSON.stringify({ "backing-filename": backing }), stderrTail: "" };
	};

	const deps: ManageDeps = {
		homeDir: home,
		log: (line) => logs.push(line),
		scanActiveSessions: async () => options.scan ?? [],
		readProc: (pid: number): ProcIdentity =>
			pid === FOREIGN_PID ? { comm: "systemd", cmdline: "/usr/lib/systemd/systemd --system" } : {},
		runQemuImg: options.qemuImg ?? defaultQemuImg,
		duOf: options.duOf,
	};

	return {
		home,
		dirs,
		deps,
		logs,
		qemuImgCalls,
		/** Point a session's overlay at a golden's disk — the gc protection's fake evidence. */
		setOverlayBacking: (sessionName: string, goldenId: string): void => {
			overlayBacking.set(
				join(dirs.sessions, sessionName, "overlay.qcow2"),
				join(dirs.images, goldenId, GOLDEN_DISK_FILE),
			);
		},
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

describe("vmList — the golden table", () => {
	it("two goldens → newest first, the manifest's recorded fields + the live-measured actual size", async () => {
		const h = harness();
		try {
			seedGolden(h.dirs, OLDEST);
			seedGolden(h.dirs, NEWEST);
			const rows = await vmList(h.deps);
			expect(rows.map((row) => row.id)).toEqual([NEWEST, OLDEST]);
			expect(rows[0]).toEqual({
				id: NEWEST,
				manifestOk: true,
				flavor: "base",
				guestUser: "sandbox",
				encrypt: false,
				builtAt: BUILT_AT[NEWEST],
				isoVersion: "4.0.3",
				diskVirtualSizeBytes: VIRTUAL,
				diskActualBytes: ACTUAL,
				note: null,
			});
			expect(h.qemuImgCalls).toContainEqual([
				"info",
				"-U",
				"--output=json",
				join(h.dirs.images, NEWEST, GOLDEN_DISK_FILE),
			]);
		} finally {
			h.cleanup();
		}
	});

	it("a corrupt manifest is a SURFACED corrupt row — null fields, disk still measured, no note", async () => {
		const h = harness();
		try {
			seedGolden(h.dirs, NEWEST, "corrupt");
			const rows = await vmList(h.deps);
			expect(rows[0]).toEqual({
				id: NEWEST,
				manifestOk: false,
				flavor: null,
				guestUser: null,
				encrypt: null,
				builtAt: null,
				isoVersion: null,
				diskVirtualSizeBytes: null,
				diskActualBytes: ACTUAL,
				note: null,
			});
		} finally {
			h.cleanup();
		}
	});

	it("a corrupt golden still sorts by its id's stamp (the newest is the newest, manifest or no)", async () => {
		const h = harness();
		try {
			seedGolden(h.dirs, OLDEST);
			seedGolden(h.dirs, NEWEST, "corrupt");
			const rows = await vmList(h.deps);
			expect(rows.map((row) => row.id)).toEqual([NEWEST, OLDEST]);
		} finally {
			h.cleanup();
		}
	});

	it("the drift note fires on a guestUser change (the spec's next-build edge case)", async () => {
		const h = harness();
		try {
			saveGuestConfig(h.dirs, { ...defaultGuestConfig(), username: "builder" });
			seedGolden(h.dirs, NEWEST);
			const rows = await vmList(h.deps);
			expect(rows[0].note).toBe(
				"guest.json changed since this golden was baked (guestUser: sandbox→builder) — " +
					"edits apply on the next vm install",
			);
		} finally {
			h.cleanup();
		}
	});

	it("the drift note fires on an encrypt change", async () => {
		const h = harness();
		try {
			saveGuestConfig(h.dirs, { ...defaultGuestConfig(), encrypt: true });
			seedGolden(h.dirs, NEWEST);
			const rows = await vmList(h.deps);
			expect(rows[0].note).toBe(
				"guest.json changed since this golden was baked (encrypt: false→true) — " +
					"edits apply on the next vm install",
			);
		} finally {
			h.cleanup();
		}
	});

	it("no drift → note is null (a fresh-config golden is quiet)", async () => {
		const h = harness();
		try {
			seedGolden(h.dirs, NEWEST);
			const rows = await vmList(h.deps);
			expect(rows[0].note).toBeNull();
		} finally {
			h.cleanup();
		}
	});

	it("an empty tree → an empty list (and a failing qemu-img means unmeasured, not an error)", async () => {
		const empty = harness();
		const broken = harness({ qemuImg: async () => ({ code: 1, stdoutTail: "", stderrTail: "boom" }) });
		try {
			expect(await vmList(empty.deps)).toEqual([]);
			seedGolden(broken.dirs, NEWEST);
			const rows = await vmList(broken.deps);
			expect(rows[0].manifestOk).toBe(true);
			expect(rows[0].diskActualBytes).toBe(0);
		} finally {
			empty.cleanup();
			broken.cleanup();
		}
	});
});

describe("vmReset — discard stale sessions", () => {
	/** The four-way session world: one stale, three kept for three different reasons. */
	function seedMixedSessions(h: ReturnType<typeof harness>): void {
		seedSession(h.dirs, "build-stale", STALE_PID);
		seedSession(h.dirs, "build-nopid", "none");
		seedSession(h.dirs, "build-garbage", "garbage");
		seedSession(h.dirs, "build-foreign", FOREIGN_PID);
	}

	it("dry run (default): lists exactly the stale dir, removes NOTHING", async () => {
		const h = harness();
		try {
			seedMixedSessions(h);
			const report = await vmReset(h.deps);
			expect(report.dryRun).toBe(true);
			expect(report.removed).toEqual([join(h.dirs.sessions, "build-stale")]);
			expect(report.sessions.count).toBe(1);
			expect(report.sessions.bytes).toBeGreaterThan(0);
			expect(new Set(report.kept.map((kept) => kept.reason))).toEqual(
				new Set(["no-pidfile", "garbage-pidfile", "live-foreign"]),
			);
			for (const name of ["build-stale", "build-nopid", "build-garbage", "build-foreign"]) {
				expect(existsSync(join(h.dirs.sessions, name)), name).toBe(true);
			}
			expect(h.logs.some((line) => line.includes("would remove"))).toBe(true);
			expect(h.logs.some((line) => line.includes("DRY RUN"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("--yes removes the stale dir only; every kept classification survives", async () => {
		const h = harness();
		try {
			seedMixedSessions(h);
			const report = await vmReset(h.deps, { yes: true });
			expect(report.dryRun).toBe(false);
			expect(existsSync(join(h.dirs.sessions, "build-stale"))).toBe(false);
			expect(existsSync(join(h.dirs.sessions, "build-nopid"))).toBe(true);
			expect(existsSync(join(h.dirs.sessions, "build-garbage"))).toBe(true);
			expect(existsSync(join(h.dirs.sessions, "build-foreign"))).toBe(true);
			expect(report.kept).toHaveLength(3);
		} finally {
			h.cleanup();
		}
	});

	it("a live session refuses the whole command, naming it — nothing removed", async () => {
		const live: ActiveSession = { sessionDir: "/home/x/.openhammer/vm/sessions/live-one", pid: 999 };
		const h = harness({ scan: [live] });
		try {
			seedSession(h.dirs, "build-stale", STALE_PID);
			await expect(vmReset(h.deps)).rejects.toThrow(
				"vm reset: a VM session is active — stop it first (openhammer vm status) — " +
					"/home/x/.openhammer/vm/sessions/live-one holds qemu pid 999",
			);
			expect(existsSync(join(h.dirs.sessions, "build-stale"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("footprint math is the injected duOf's exact sum", async () => {
		const sizes = new Map<string, number>();
		const h = harness({ duOf: async (path) => sizes.get(path) ?? 0 });
		try {
			sizes.set(join(h.dirs.sessions, "build-a"), 100);
			sizes.set(join(h.dirs.sessions, "build-b"), 50);
			seedSession(h.dirs, "build-a", STALE_PID);
			seedSession(h.dirs, "build-b", STALE_PID);
			const report = await vmReset(h.deps);
			expect(report.sessions).toEqual({ count: 2, bytes: 150 });
		} finally {
			h.cleanup();
		}
	});

	it("goldens and cidata are NEVER touched by reset", async () => {
		const h = harness();
		try {
			seedSession(h.dirs, "build-stale", STALE_PID);
			seedGolden(h.dirs, NEWEST);
			seedCidata(h.dirs, "build-stale");
			await vmReset(h.deps, { yes: true });
			expect(existsSync(join(h.dirs.images, NEWEST))).toBe(true);
			expect(existsSync(join(h.dirs.cidata, "build-stale"))).toBe(true);
			expect(existsSync(`${join(h.dirs.cidata, "build-stale")}.iso`)).toBe(true);
		} finally {
			h.cleanup();
		}
	});
});

describe("vmGc — the aggregate-footprint reclaimer", () => {
	/** The full three-category world: 3 goldens, 1 stale + 1 retained session, 3 cidata builds. */
	function seedWorld(h: ReturnType<typeof harness>): void {
		seedGolden(h.dirs, OLDEST);
		seedGolden(h.dirs, MIDDLE);
		seedGolden(h.dirs, NEWEST);
		seedSession(h.dirs, "build-stale", STALE_PID);
		seedSession(h.dirs, "build-kept", "none");
		seedCidata(h.dirs, "build-stale"); // orphan: its session goes in this same pass
		seedCidata(h.dirs, "build-kept"); // referenced: its session survives
		seedCidata(h.dirs, "build-ghost"); // orphan: no session ever matched it
	}

	it("--yes reclaims stale sessions + both orphan cidata builds + the oldest golden; keeps the newest 2", async () => {
		const h = harness();
		try {
			seedWorld(h);
			const report = await vmGc(h.deps, { yes: true });
			expect(report.dryRun).toBe(false);
			expect(report.sessions.count).toBe(1);
			expect(report.cidata.count).toBe(2);
			expect(report.goldens.count).toBe(1);
			expect(existsSync(join(h.dirs.sessions, "build-stale"))).toBe(false);
			expect(existsSync(join(h.dirs.sessions, "build-kept"))).toBe(true);
			expect(existsSync(join(h.dirs.cidata, "build-stale"))).toBe(false);
			expect(existsSync(`${join(h.dirs.cidata, "build-stale")}.iso`)).toBe(false);
			expect(existsSync(join(h.dirs.cidata, "build-kept"))).toBe(true);
			expect(existsSync(`${join(h.dirs.cidata, "build-kept")}.iso`)).toBe(true);
			expect(existsSync(join(h.dirs.cidata, "build-ghost"))).toBe(false);
			expect(existsSync(join(h.dirs.images, OLDEST))).toBe(false);
			expect(existsSync(join(h.dirs.images, MIDDLE))).toBe(true);
			expect(existsSync(join(h.dirs.images, NEWEST))).toBe(true);
			expect(report.protectedGoldens).toEqual([]);
			expect(report.removed.goldens).toEqual([join(h.dirs.images, OLDEST)]);
		} finally {
			h.cleanup();
		}
	});

	it("dry run (default) computes the identical plan and removes NOTHING", async () => {
		const h = harness();
		try {
			seedWorld(h);
			const report = await vmGc(h.deps);
			expect(report.dryRun).toBe(true);
			expect(report.sessions.count).toBe(1);
			expect(report.cidata.count).toBe(2);
			expect(report.goldens.count).toBe(1);
			expect(report.removed).toEqual({ sessions: [], cidata: [], goldens: [] });
			for (const path of [
				join(h.dirs.sessions, "build-stale"),
				join(h.dirs.cidata, "build-stale"),
				`${join(h.dirs.cidata, "build-ghost")}.iso`,
				join(h.dirs.images, OLDEST),
			]) {
				expect(existsSync(path), path).toBe(true);
			}
			expect(h.logs.some((line) => line.includes("DRY RUN") && line.includes("--yes"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("report totals are the injected duOf's exact per-category sums", async () => {
		const sizes = new Map<string, number>();
		const h = harness({ duOf: async (path) => sizes.get(path) ?? 0 });
		try {
			seedWorld(h);
			sizes.set(join(h.dirs.sessions, "build-stale"), 100);
			sizes.set(join(h.dirs.cidata, "build-stale"), 10);
			sizes.set(`${join(h.dirs.cidata, "build-stale")}.iso`, 5);
			sizes.set(join(h.dirs.cidata, "build-ghost"), 20);
			sizes.set(`${join(h.dirs.cidata, "build-ghost")}.iso`, 2);
			sizes.set(join(h.dirs.images, OLDEST), 500);
			const report = await vmGc(h.deps);
			expect(report.sessions).toEqual({ count: 1, bytes: 100 });
			expect(report.cidata).toEqual({ count: 2, bytes: 37 });
			expect(report.goldens).toEqual({ count: 1, bytes: 500 });
			expect(DEFAULT_KEEP_GOLDENS).toBe(2);
		} finally {
			h.cleanup();
		}
	});

	it("a live session refuses the whole command (single-flight with install) — nothing removed", async () => {
		const live: ActiveSession = { sessionDir: "/home/x/.openhammer/vm/sessions/live-one", pid: 999 };
		const h = harness({ scan: [live] });
		try {
			seedWorld(h);
			await expect(vmGc(h.deps, { yes: true })).rejects.toThrow(
				"vm gc: a VM session is active — stop it first (openhammer vm status) — " +
					"/home/x/.openhammer/vm/sessions/live-one holds qemu pid 999",
			);
			expect(existsSync(join(h.dirs.sessions, "build-stale"))).toBe(true);
			expect(existsSync(join(h.dirs.images, OLDEST))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("a golden an overlay's backing file references is PROTECTED even beyond the keep count", async () => {
		const h = harness();
		try {
			seedWorld(h);
			h.setOverlayBacking("build-kept", MIDDLE); // the retained session still boots off MIDDLE
			const report = await vmGc(h.deps, { yes: true, keepGoldens: 1 });
			expect(report.protectedGoldens).toEqual([MIDDLE]);
			expect(report.goldens.count).toBe(1); // only OLDEST actually reclaimed
			expect(existsSync(join(h.dirs.images, MIDDLE))).toBe(true);
			expect(existsSync(join(h.dirs.images, OLDEST))).toBe(false);
			expect(existsSync(join(h.dirs.images, NEWEST))).toBe(true);
			expect(h.logs.some((line) => line.includes("an overlay's backing file still references it"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("keep-goldens >= 1 is enforced — the newest (active) golden is never a candidate", async () => {
		const h = harness();
		try {
			seedWorld(h);
			await expect(vmGc(h.deps, { keepGoldens: 0 })).rejects.toThrow(
				"vm gc: keepGoldens must be an integer >= 1 (got 0)",
			);
			const keepAll = await vmGc(h.deps, { keepGoldens: 3 });
			expect(keepAll.goldens.count).toBe(0);
			const keepOne = await vmGc(h.deps, { keepGoldens: 1 });
			expect(keepOne.goldens.count).toBe(2); // MIDDLE + OLDEST — NEWEST always survives
		} finally {
			h.cleanup();
		}
	});
});
