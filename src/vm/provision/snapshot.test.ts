import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVmDirs } from "../session.ts";
import { defaultGuestConfig, saveGuestConfig } from "./guest-config.ts";
import type { ActiveSession } from "./install.ts";
import { ISO_SHA256, ISO_URL } from "./iso.ts";
import {
	GOLDEN_DISK_FILE,
	goldenIdFor,
	isoVersionOf,
	type Manifest,
	normalizeManifest,
	readManifest,
	runSnapshot,
	type SnapshotDeps,
} from "./snapshot.ts";

const PASSWORD = "test-recovery-password";
const HOST_KEY = "[127.0.0.1]:41733 ssh-ed25519 AAAAFAKEOPENHAMMERTESTKEY== fake\n";
const SESSION = "build-2026-09-09T07-18-29-884Z";
const OLDER_SESSION = "build-2026-09-09T06-00-00-000Z";
const DISK_CONTENT = "fake-installed-disk";
const VARS_CONTENT = "fake-installed-vars";
const VIRTUAL_SIZE = 42_949_672_960;

/** The per-test harness knobs; every default produces the full unencrypted happy path. */
interface HarnessOptions {
	/** guest.json's encrypt (default: false — the product default). */
	readonly encrypt?: boolean;
	/** The single-flight scan result (default: no active sessions). */
	readonly scan?: ActiveSession[];
	/** Seed NO build session at all (default: one complete provisioned session). */
	readonly noSession?: boolean;
	/** Seed `~/.openhammer/vm/provision.sh` (default: absent → null hashes). */
	readonly provisionScript?: boolean;
	/** Script the stat seam: the minted golden dir "already exists" (the collision guard). */
	readonly goldenExists?: boolean;
	/** The qemu-img info result (default: rc 0 with virtual-size VIRTUAL_SIZE). */
	readonly qemuImgResult?: { readonly code: number | null; readonly stdoutTail: string; readonly stderrTail: string };
}

/**
 * The full fake snapshot world: a real temp HOME with a seeded provisioned session, every
 * external seam injected (the renames go through the REAL renameSync so the move semantics
 * are exercised for real). ZERO real binaries — qemu-img is faked, no QEMU ever runs.
 */
function harness(options: HarnessOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "openhammer-snapshot-"));
	const dirs = resolveVmDirs({ homeDir: home });
	const logs: string[] = [];
	const qemuImgCalls: string[][] = [];
	const renames: Array<readonly [string, string]> = [];

	if (options.encrypt) {
		saveGuestConfig(dirs, { ...defaultGuestConfig(), encrypt: true });
	}

	const sessionDir = join(dirs.sessions, SESSION);
	if (!options.noSession) {
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "disk.qcow2"), DISK_CONTENT);
		writeFileSync(join(sessionDir, "OVMF_VARS.4m.fd"), VARS_CONTENT);
		writeFileSync(join(sessionDir, "known_hosts"), HOST_KEY, { mode: 0o600 });
		writeFileSync(join(sessionDir, "luks-or-sudo-password.txt"), `${PASSWORD}\n`, { mode: 0o600 });
		// The session's own evidence — these must SURVIVE the promote.
		writeFileSync(join(sessionDir, "install.log"), "install evidence\n");
		writeFileSync(join(sessionDir, "provision.log"), "provision evidence\n");
	}
	if (options.provisionScript) {
		mkdirSync(dirs.root, { recursive: true });
		writeFileSync(join(dirs.root, "provision.sh"), "#!/bin/bash\necho custom step\n");
	}

	const goldenPrefix = join(dirs.images, "golden-");
	const deps: SnapshotDeps = {
		homeDir: home,
		log: (line) => logs.push(line),
		scanActiveSessions: async () => options.scan ?? [],
		runQemuImg: async (args) => {
			qemuImgCalls.push([...args]);
			return (
				options.qemuImgResult ?? {
					code: 0,
					stdoutTail: JSON.stringify({ "virtual-size": VIRTUAL_SIZE, "actual-size": 123 }),
					stderrTail: "",
				}
			);
		},
		rename: (from, to) => {
			renames.push([from, to]);
			renameSync(from, to); // the REAL move — the promote semantics are the thing under test
		},
		stat: (path) =>
			options.goldenExists && path.startsWith(goldenPrefix)
				? statSync(sessionDir) // a real Stats: the minted golden dir "exists"
				: statSync(path, { throwIfNoEntry: false }),
	};

	return {
		home,
		dirs,
		deps,
		logs,
		qemuImgCalls,
		renames,
		sessionDir,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
	};
}

describe("runSnapshot — the promote (happy path)", () => {
	it("moves disk + installed VARS, copies known_hosts 0600, and the session's logs survive", async () => {
		const h = harness();
		try {
			const result = await runSnapshot(h.deps);
			expect(result.goldenId).toMatch(/^golden-4\.0\.3-\d{8}-\d{6}$/);
			expect(result.diskVirtualSizeBytes).toBe(VIRTUAL_SIZE);
			const goldenDir = join(h.dirs.images, result.goldenId);
			expect(result.manifestPath).toBe(join(goldenDir, "manifest.json"));
			// The two MOVES: gone from the session, present as the golden.
			expect(existsSync(join(h.sessionDir, "disk.qcow2"))).toBe(false);
			expect(existsSync(join(h.sessionDir, "OVMF_VARS.4m.fd"))).toBe(false);
			expect(readFileSync(join(goldenDir, GOLDEN_DISK_FILE), "utf8")).toBe(DISK_CONTENT);
			expect(readFileSync(join(goldenDir, "OVMF_VARS.4m.fd"), "utf8")).toBe(VARS_CONTENT);
			// The one COPY: the session KEEPS its pin (the evidence stays), the golden gets a 0600 twin.
			expect(readFileSync(join(h.sessionDir, "known_hosts"), "utf8")).toBe(HOST_KEY);
			expect(readFileSync(join(goldenDir, "known_hosts"), "utf8")).toBe(HOST_KEY);
			expect(statSync(join(goldenDir, "known_hosts")).mode & 0o777).toBe(0o600);
			// Only disk + VARS move — the session's logs survive untouched.
			expect(readFileSync(join(h.sessionDir, "install.log"), "utf8")).toBe("install evidence\n");
			expect(readFileSync(join(h.sessionDir, "provision.log"), "utf8")).toBe("provision evidence\n");
			// The golden dir is 0700, and the licensing note is logged.
			expect(statSync(goldenDir).mode & 0o777).toBe(0o700);
			expect(
				h.logs.some((line) =>
					line.includes(
						"Note: the golden image is a personal artifact (Omarchy's ISO license terms apply to " +
							"redistributed images, not personal use).",
					),
				),
			).toBe(true);
			expect(h.logs.some((line) => line.includes(`golden ${result.goldenId} at ${goldenDir}`))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("qemu-img info feeds diskVirtualSizeBytes (measured on the session disk BEFORE the move)", async () => {
		const h = harness();
		try {
			await runSnapshot(h.deps);
			expect(h.qemuImgCalls).toEqual([["info", "-U", "--output=json", join(h.sessionDir, "disk.qcow2")]]);
		} finally {
			h.cleanup();
		}
	});

	it("picks the most recent COMPLETE provisioned session (an unprovisioned newer one is skipped)", async () => {
		const h = harness();
		try {
			const older = join(h.dirs.sessions, OLDER_SESSION);
			mkdirSync(older, { recursive: true });
			writeFileSync(join(older, "disk.qcow2"), "older-disk");
			writeFileSync(join(older, "OVMF_VARS.4m.fd"), "older-vars");
			writeFileSync(join(older, "known_hosts"), "older-pin\n", { mode: 0o600 });
			writeFileSync(join(older, "luks-or-sudo-password.txt"), "older-password\n", { mode: 0o600 });
			rmSync(join(h.sessionDir, "known_hosts")); // SESSION is newer but never provisioned
			const result = await runSnapshot(h.deps);
			const goldenDir = join(h.dirs.images, result.goldenId);
			expect(readFileSync(join(goldenDir, GOLDEN_DISK_FILE), "utf8")).toBe("older-disk");
			expect(readFileSync(join(goldenDir, "known_hosts"), "utf8")).toBe("older-pin\n");
		} finally {
			h.cleanup();
		}
	});

	it("an explicit sessionName promotes that session", async () => {
		const h = harness();
		try {
			await runSnapshot(h.deps, { sessionName: SESSION });
			expect(h.renames[0]?.[0]).toBe(join(h.sessionDir, "disk.qcow2"));
		} finally {
			h.cleanup();
		}
	});
});

describe("runSnapshot — the manifest", () => {
	it("unencrypted: the exact shape, NO passphrase keys (key-set assert), 0600", async () => {
		const h = harness();
		try {
			const result = await runSnapshot(h.deps);
			const raw = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Record<string, unknown>;
			expect(Object.keys(raw).sort()).toEqual([
				"builtAt",
				"diskVirtualSizeBytes",
				"encrypt",
				"flavor",
				"guestUser",
				"id",
				"isoSha256",
				"isoUrl",
				"isoVersion",
				"provisionScriptHashes",
				"rootDir",
			]);
			expect(raw).toEqual({
				id: result.goldenId,
				flavor: "base",
				guestUser: "sandbox",
				rootDir: "/home/sandbox",
				isoVersion: "4.0.3",
				isoUrl: ISO_URL,
				isoSha256: ISO_SHA256,
				diskVirtualSizeBytes: VIRTUAL_SIZE,
				provisionScriptHashes: null,
				builtAt: raw.builtAt, // an ISO stamp — asserted just below
				encrypt: false,
			});
			expect(raw.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(statSync(result.manifestPath).mode & 0o777).toBe(0o600);
		} finally {
			h.cleanup();
		}
	});

	it("encrypted: unlockPrompt + the session's passphrase present, and the current-config warning logged", async () => {
		const h = harness({ encrypt: true });
		try {
			const result = await runSnapshot(h.deps);
			const raw = JSON.parse(readFileSync(result.manifestPath, "utf8")) as Record<string, unknown>;
			expect(Object.keys(raw).sort()).toEqual([
				"builtAt",
				"diskVirtualSizeBytes",
				"encrypt",
				"flavor",
				"guestUser",
				"id",
				"isoSha256",
				"isoUrl",
				"isoVersion",
				"luksPassphrase",
				"provisionScriptHashes",
				"rootDir",
				"unlockPrompt",
			]);
			expect(raw.encrypt).toBe(true);
			expect(raw.unlockPrompt).toBe("A password is required to access the root volume:");
			expect(raw.luksPassphrase).toBe(PASSWORD);
			// The documented-limitation warning, and the passphrase NEVER logged.
			expect(h.logs.some((line) => line.includes("encrypt flag taken from the CURRENT guest.json"))).toBe(true);
			expect(h.logs.some((line) => line.includes(PASSWORD))).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	it("provision.sh present → its sha256; absent → null", async () => {
		const script = "#!/bin/bash\necho custom step\n";
		const withScript = harness({ provisionScript: true });
		const without = harness();
		try {
			const a = await runSnapshot(withScript.deps);
			const rawA = JSON.parse(readFileSync(a.manifestPath, "utf8")) as Record<string, unknown>;
			expect(rawA.provisionScriptHashes).toBe(createHash("sha256").update(script).digest("hex"));
			const b = await runSnapshot(without.deps);
			const rawB = JSON.parse(readFileSync(b.manifestPath, "utf8")) as Record<string, unknown>;
			expect(rawB.provisionScriptHashes).toBeNull();
		} finally {
			withScript.cleanup();
			without.cleanup();
		}
	});
});

describe("runSnapshot — refusals (before any side effect)", () => {
	it("no known_hosts → the provision-first error; nothing moved", async () => {
		const h = harness();
		try {
			rmSync(join(h.sessionDir, "known_hosts"));
			await expect(runSnapshot(h.deps)).rejects.toThrow(
				`vm snapshot: no provisioned build session to promote — ${h.sessionDir} is missing known_hosts — ` +
					"run `openhammer vm provision` first",
			);
			expect(existsSync(join(h.sessionDir, "disk.qcow2"))).toBe(true);
			expect(h.renames).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	it("no session at all → the install-first error", async () => {
		const h = harness({ noSession: true });
		try {
			await expect(runSnapshot(h.deps)).rejects.toThrow(
				`vm snapshot: no provisioned build session to promote — ${join(h.dirs.sessions, "build-")} is missing ` +
					"disk.qcow2 — run `openhammer vm install` first",
			);
		} finally {
			h.cleanup();
		}
	});

	it("an already-existing golden id is refused — never overwritten", async () => {
		const h = harness({ goldenExists: true });
		try {
			await expect(runSnapshot(h.deps)).rejects.toThrow(/golden golden-4\.0\.3-\d{8}-\d{6} already exists at .* — /);
			expect(existsSync(join(h.sessionDir, "disk.qcow2"))).toBe(true);
			expect(h.renames).toEqual([]);
			expect(existsSync(h.dirs.images)).toBe(false); // the tree was never created
		} finally {
			h.cleanup();
		}
	});

	it("single-flight: an active session refuses before anything runs", async () => {
		const live: ActiveSession = { sessionDir: "/home/x/.openhammer/vm/sessions/live-one", pid: 999 };
		const h = harness({ scan: [live] });
		try {
			await expect(runSnapshot(h.deps)).rejects.toThrow(
				"vm snapshot: a VM session is active — stop it first (openhammer vm status) — " +
					"/home/x/.openhammer/vm/sessions/live-one holds qemu pid 999",
			);
			expect(h.qemuImgCalls).toEqual([]);
			expect(h.renames).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	it("a failing qemu-img info is an actionable error; nothing moved", async () => {
		const h = harness({ qemuImgResult: { code: 1, stdoutTail: "", stderrTail: "boom" } });
		try {
			await expect(runSnapshot(h.deps)).rejects.toThrow("vm snapshot: qemu-img info exited 1: boom");
			expect(h.renames).toEqual([]);
			expect(existsSync(join(h.sessionDir, "disk.qcow2"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("an unusable virtual-size is refused too", async () => {
		const h = harness({ qemuImgResult: { code: 0, stdoutTail: '{"actual-size": 1}', stderrTail: "" } });
		try {
			await expect(runSnapshot(h.deps)).rejects.toThrow("no usable virtual-size");
			expect(h.renames).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	it("encrypt=true with the recovery file missing → the install-first error", async () => {
		const h = harness({ encrypt: true });
		try {
			rmSync(join(h.sessionDir, "luks-or-sudo-password.txt"));
			await expect(runSnapshot(h.deps)).rejects.toThrow(/luks-or-sudo-password\.txt is missing .* vm install/);
			expect(h.renames).toEqual([]);
		} finally {
			h.cleanup();
		}
	});

	it("an unsafe session name is refused before anything runs", async () => {
		const h = harness();
		try {
			await expect(runSnapshot(h.deps, { sessionName: "../evil" })).rejects.toThrow(
				"vm snapshot: session name is not a safe path segment",
			);
			expect(h.qemuImgCalls).toEqual([]);
		} finally {
			h.cleanup();
		}
	});
});

describe("readManifest / normalizeManifest — the strict boundary", () => {
	const valid = {
		id: "golden-4.0.3-20260910-070809",
		flavor: "base",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: ISO_URL,
		isoSha256: ISO_SHA256,
		diskVirtualSizeBytes: VIRTUAL_SIZE,
		provisionScriptHashes: null,
		builtAt: "2026-09-10T07:08:09.000Z",
		encrypt: false,
	};

	it("accepts the canonical shape (and the agent flavor)", () => {
		expect(normalizeManifest(valid)).toEqual(valid);
		expect(normalizeManifest({ ...valid, flavor: "agent" })?.flavor).toBe("agent");
	});

	it("rejects each invalid variant", () => {
		const missing: Record<string, unknown> = { ...valid };
		delete missing.encrypt;
		const variants: Array<[string, unknown]> = [
			["null", null],
			["an array", [valid]],
			["a string", "golden"],
			["a number", 42],
			["unsafe id", { ...valid, id: "../evil" }],
			["empty id", { ...valid, id: "" }],
			["unknown flavor", { ...valid, flavor: "custom" }],
			["bad guestUser", { ...valid, guestUser: "not a user" }],
			["relative rootDir", { ...valid, rootDir: "home/sandbox" }],
			["empty isoVersion", { ...valid, isoVersion: "" }],
			["empty isoUrl", { ...valid, isoUrl: "" }],
			["non-hex sha256", { ...valid, isoSha256: "not-a-digest" }],
			["zero disk size", { ...valid, diskVirtualSizeBytes: 0 }],
			["fractional disk size", { ...valid, diskVirtualSizeBytes: 1.5 }],
			["string disk size", { ...valid, diskVirtualSizeBytes: "40" }],
			["non-sha256 script hashes", { ...valid, provisionScriptHashes: "nope" }],
			["non-stamp builtAt", { ...valid, builtAt: "yesterday" }],
			["missing encrypt", missing],
			["encrypt without unlockPrompt", { ...valid, encrypt: true, luksPassphrase: "p" }],
			["encrypt without luksPassphrase", { ...valid, encrypt: true, unlockPrompt: "prompt:" }],
			["encrypt with an empty passphrase", { ...valid, encrypt: true, unlockPrompt: "prompt:", luksPassphrase: "" }],
			["unencrypted WITH a passphrase", { ...valid, luksPassphrase: "sneaky" }],
			["unencrypted WITH unlockPrompt", { ...valid, unlockPrompt: "prompt:" }],
		];
		for (const [label, variant] of variants) {
			expect(normalizeManifest(variant), label).toBeNull();
		}
	});

	it("readManifest: absent + unparseable files are null; a valid file round-trips", () => {
		expect(readManifest(join(tmpdir(), "openhammer-no-such-manifest.json"))).toBeNull();
		const dir = mkdtempSync(join(tmpdir(), "openhammer-manifest-"));
		try {
			const path = join(dir, "manifest.json");
			writeFileSync(path, "{not json");
			expect(readManifest(path)).toBeNull();
			writeFileSync(path, JSON.stringify(valid));
			expect(readManifest(path)).toEqual(valid);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("a written golden's manifest round-trips through readManifest", async () => {
		const h = harness();
		try {
			const result = await runSnapshot(h.deps);
			const back: Manifest | null = readManifest(result.manifestPath);
			expect(back).not.toBeNull();
			expect(back?.id).toBe(result.goldenId);
			expect(back?.flavor).toBe("base");
			expect(back?.guestUser).toBe("sandbox");
			expect(back?.rootDir).toBe("/home/sandbox");
			expect(back?.isoVersion).toBe("4.0.3");
			expect(back?.isoUrl).toBe(ISO_URL);
			expect(back?.isoSha256).toBe(ISO_SHA256);
			expect(back?.diskVirtualSizeBytes).toBe(VIRTUAL_SIZE);
			expect(back?.provisionScriptHashes).toBeNull();
			expect(back?.encrypt).toBe(false);
			expect(back?.unlockPrompt).toBeUndefined();
			expect(back?.luksPassphrase).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});

describe("the id derivations", () => {
	it("goldenIdFor mints golden-<version>-<YYYYMMDD-HHMMSS> (UTC)", () => {
		expect(goldenIdFor("4.0.3", new Date(Date.UTC(2026, 8, 10, 7, 8, 9)))).toBe("golden-4.0.3-20260910-070809");
	});

	it("isoVersionOf derives the version from the pinned ISO name", () => {
		expect(isoVersionOf("omarchy-4.0.3.iso")).toBe("4.0.3");
	});
});
