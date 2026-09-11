/**
 * The `vm list|reset|gc` runners (spec 26f): read the golden tree, discard stale
 * sessions, reclaim the aggregate stale footprint. The management surface over what
 * 26c–26e leave behind — goldens under `images/golden-<id>/`, session dirs under
 * `sessions/`, cidata builds under `cidata/`.
 *
 * THE LIST POSTURE (the spec's edge case): the manifest is the RECORD OF WHAT WAS
 * BAKED — guest.json edits after a golden exists apply on the NEXT build, and `vm
 * list` is where that truth surfaces. Every golden gets a row; a manifest that is
 * missing or fails {@link readManifest} is a SURFACED `corrupt:` row (never hidden),
 * and a golden whose recorded guestUser/encrypt/agent differ from the CURRENT guest.json
 * carries the drift note (`guest.json changed since this golden was baked (…) —
 * edits apply on the next vm install`). The comparison covers exactly the fields the
 * manifest records — guestUser + encrypt + agent (spec 29 added the agent field, closing
 * 28d's gap; 26e goldens predate it and normalize to the documented `claude` default,
 * so an agent note against a legacy golden reflects that assumption). The
 * actual disk size is measured LIVE (qemu-img info -U on the golden.qcow2) because it
 * grows with every session's overlay commits — 0 means unmeasured (the InstallResult
 * convention), never a claim of emptiness.
 *
 * THE CONFIRM PRECEDENT (ESTABLISHED HERE): no prior OpenHammer command's whole job
 * is deleting bulk state (`channel remove` deletes one entry immediately), so this
 * module defines the repo's destructive-command shape: **dry run by default, `--yes`
 * to act**. Without the flag the command prints exactly what would go — every path
 * and its byte footprint — and removes NOTHING; with it the same plan executes. The
 * plan is computed up front either way, so the dry run is a faithful preview.
 *
 * STALENESS IS THE SWEEP'S DEFINITION (session.ts, reused verbatim): a session dir
 * is stale when its qemu.pid names a pid with NO /proc entry (dead — ESRCH). Dirs
 * without a pidfile (mid-prepare, or not ours to judge — no mtime heuristics), dirs
 * with a garbage pidfile (unverifiable is not stale), and dirs whose pid is a LIVE
 * FOREIGN process (a recycled PID — removing data on PID-reuse evidence is the one
 * unrecoverable mistake available here) are KEPT and reported, never removed.
 *
 * WHAT EACH COMMAND TOUCHES — and never touches:
 * - `list`: reads images/ + guest.json + qemu-img info. Touches nothing.
 * - `reset`: removes STALE session dirs only. Never goldens, never cidata.
 * - `gc`: stale session dirs + orphaned cidata builds (no matching session — or a
 *   session going in this same pass: discarding a session discards its install
 *   cidata with it) + goldens beyond the keep count (default 2), OLDEST first, the
 *   newest ALWAYS kept (keepGoldens >= 1 is enforced — it is the active golden), and
 *   never a golden an overlay still references (best-effort: qemu-img info's
 *   `backing-filename` over every session's overlay.qcow2; an unreadable overlay
 *   contributes no protection — best-effort by design).
 *
 * SINGLE-FLIGHT (26c's guard, the install-side precedent): both reset and gc REFUSE
 * outright when any qemu.pid under `sessions/` names a live verified-ours QEMU —
 * removing state out from under a running boot is not a judgment call. The refusal is
 * install.ts's SHARED builder ({@link activeSessionRefusal} — one message across the vm
 * tree, so the CLI stderr and the dashboard's inline flash can never drift) and it names
 * the session dir, the pid, and the escape (mode off + restart, or Sandbox → Stop
 * sandbox — spec 28 matrix rows 4/5).
 *
 * Error model: process layer, not a tool. Expected failures THROW actionable errors
 * (the snapshot.ts posture); the CLI boundary maps them to exit 1.
 */
import { type Dirent, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { QEMU_IMG_BIN } from "../qemu/process.ts";
import { type ProcIdentity, type ReadProc, type RunQemuImg, resolveVmDirs, type VmDirs } from "../session.ts";
import { loadGuestConfig } from "./guest-config.ts";
import { activeSessionRefusal, type ScanActiveSessions, scanActiveVmSessions } from "./install.ts";
import { runBinDefault } from "./iso.ts";
import { GOLDEN_DISK_FILE, type Manifest, type ManifestFlavor, readManifest } from "./snapshot.ts";

// ---- tunables ----

/** How many goldens `gc` keeps by default: the active one + its predecessor. */
export const DEFAULT_KEEP_GOLDENS = 2;

// ---- the fixed names (26c/26e's tree shapes, restated: this module only manages) ----

const GOLDEN_PREFIX = "golden-";
const MANIFEST_FILE = "manifest.json";
const PID_FILE = "qemu.pid";
const OVERLAY_FILE = "overlay.qcow2";
const ISO_SUFFIX = ".iso";

// ---- the external seams ----

/**
 * The byte-footprint seam (default: recursive du with session.ts's dirSize semantics
 * — lstat via dirent, symlinks unopened, unreadable entries contribute zero; a bare
 * file contributes its size). Injected so footprint math is exact under test.
 */
export type DuOf = (path: string) => Promise<number>;

/**
 * Injection seams for EVERYTHING external (the box contract: defaults = the real
 * ones). `scanActiveSessions` is 26c's single-flight scan (the snapshot.ts seam
 * posture) so refusals are scriptable without a live QEMU; `readProc` classifies
 * stale vs live session dirs; `duOf` sizes what removal reclaims.
 */
export interface ManageDeps {
	/** Override the HOME the vm tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the qemu-img runner (default: runBinDefault over QEMU_IMG_BIN). */
	readonly runQemuImg?: RunQemuImg;
	/** The report line sink (the CLI passes its stdout). Default: console.log. */
	readonly log?: (line: string) => void;
	/** Override the single-flight pid scan (tests script a hit or a miss). */
	readonly scanActiveSessions?: ScanActiveSessions;
	/** Override the /proc identity read (tests script dead/live/foreign pids). */
	readonly readProc?: ReadProc;
	/** Override the byte-footprint measure (tests return exact numbers). */
	readonly duOf?: DuOf;
}

// The /proc reader — session.ts's readProcDefault posture, restated (install.ts
// restates it too; consolidate when spec 27's service extracts the shared module).
const readProcDefault: ReadProc = (pid: number): ProcIdentity => {
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
		// cmdline unreadable — comm-only verification
	}
	return { comm, cmdline };
};

const duOfDefault: DuOf = async (path: string): Promise<number> => {
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === undefined) return 0;
	if (!info.isDirectory()) return info.size;
	let total = 0;
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			total += await duOfDefault(child);
		} else if (entry.isFile()) {
			total += (await stat(child).catch(() => undefined))?.size ?? 0;
		}
	}
	return total;
};

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---- shared tree scans ----

/** One golden dir under `images/`, with its parsed (or rejected) manifest. */
interface GoldenDir {
	readonly id: string;
	readonly dir: string;
	readonly manifest: Manifest | null;
}

/**
 * The chronological sort key: the manifest's builtAt (digits only, so ISO stamps and
 * bare ids compare), falling back to the id's trailing `-YYYYMMDD-HHMMSS` stamp (a
 * corrupt manifest still sorts by when it was minted), "" last.
 */
function orderKeyOf(golden: GoldenDir): string {
	const builtAt = golden.manifest?.builtAt;
	if (builtAt !== undefined) return builtAt.replace(/\D/g, "");
	const stamp = /(\d{8}-\d{6})$/.exec(golden.id);
	return stamp === null ? "" : (stamp[1] ?? "").replaceAll("-", "");
}

/** Every `images/golden-<id>/` dir, NEWEST FIRST (list prints newest-first; gc keeps the head). */
function listGoldenDirs(dirs: VmDirs): GoldenDir[] {
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(dirs.images, { withFileTypes: true });
	} catch {
		return []; // no images root — no goldens
	}
	const goldens: GoldenDir[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(GOLDEN_PREFIX)) continue; // strays are not goldens
		const dir = join(dirs.images, entry.name);
		goldens.push({ id: entry.name, dir, manifest: readManifest(join(dir, MANIFEST_FILE)) });
	}
	goldens.sort((a, b) => {
		const keyA = orderKeyOf(a);
		const keyB = orderKeyOf(b);
		if (keyA !== keyB) return keyA < keyB ? 1 : -1;
		return a.id < b.id ? 1 : -1;
	});
	return goldens;
}

/** Every session dir under `sessions/` (an absent root is an empty list). */
function listSessionDirs(dirs: VmDirs): string[] {
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(dirs.sessions, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => join(dirs.sessions, entry.name));
}

// ---- session classification (the sweep's semantics, read-only) ----

/** Why a session dir survives a reset/gc pass. */
export type KeptReason = "no-pidfile" | "garbage-pidfile" | "live-foreign";

/** A session dir that was kept, and why (the honest dry-run half of the report). */
export interface KeptSession {
	readonly dir: string;
	readonly reason: KeptReason;
}

type SessionVerdict = { readonly kind: "stale" } | { readonly kind: "kept"; readonly reason: KeptReason };

// Live-ours never appears here: the single-flight scan refuses the whole command
// first, so any pid that is alive by classification time is foreign (or a race —
// kept either way, the safe direction).
function classifySession(sessionDir: string, readProc: ReadProc): SessionVerdict {
	let pidText: string | undefined;
	try {
		pidText = readFileSync(join(sessionDir, PID_FILE), "utf8");
	} catch {
		return { kind: "kept", reason: "no-pidfile" }; // mid-prepare or not ours to judge
	}
	const pid = Number(pidText.trim());
	if (!Number.isInteger(pid) || pid <= 0) {
		return { kind: "kept", reason: "garbage-pidfile" }; // unverifiable is not stale
	}
	const identity = readProc(pid);
	if (identity.comm === undefined) {
		return { kind: "stale" }; // no /proc entry — ESRCH, the process is gone
	}
	return { kind: "kept", reason: "live-foreign" }; // a recycled PID — never removal evidence
}

// ---- qemu-img helpers ----

/** Pull `actual-size` out of qemu-img info JSON; 0 on ANY failure (0 = unmeasured). */
function actualSizeOf(stdout: string): number {
	try {
		const parsed: unknown = JSON.parse(stdout);
		if (typeof parsed === "object" && parsed !== null) {
			const actual = (parsed as Record<string, unknown>)["actual-size"];
			if (typeof actual === "number" && Number.isFinite(actual) && actual >= 0) return actual;
		}
	} catch {
		// unparseable — unmeasured
	}
	return 0;
}

/**
 * Every golden disk an existing session overlay still references (resolved paths):
 * qemu-img info's `backing-filename` per overlay. Best-effort by design — a failing
 * info run contributes no protection and no error (the keep-count is the real bound).
 */
async function scanOverlayBackingFiles(sessionDirs: readonly string[], runQemuImg: RunQemuImg): Promise<Set<string>> {
	const referenced = new Set<string>();
	for (const sessionDir of sessionDirs) {
		const overlayPath = join(sessionDir, OVERLAY_FILE);
		if (statSync(overlayPath, { throwIfNoEntry: false }) === undefined) continue;
		const info = await runQemuImg(["info", "-U", "--output=json", overlayPath]);
		if (info.code !== 0) continue;
		try {
			const parsed: unknown = JSON.parse(info.stdoutTail);
			if (typeof parsed === "object" && parsed !== null) {
				const backing = (parsed as Record<string, unknown>)["backing-filename"];
				if (typeof backing === "string" && backing.length > 0) referenced.add(resolve(backing));
			}
		} catch {
			// unparseable — best-effort skip
		}
	}
	return referenced;
}

// ---- vm list ----

/** One golden's row for the table. `null` fields = unknown (the manifest failed validation). */
export interface GoldenSummary {
	readonly id: string;
	/** false → the `corrupt:` row (the manifest is missing or invalid — surfaced, never hidden). */
	readonly manifestOk: boolean;
	readonly flavor: ManifestFlavor | null;
	readonly guestUser: string | null;
	readonly encrypt: boolean | null;
	readonly builtAt: string | null;
	readonly isoVersion: string | null;
	readonly diskVirtualSizeBytes: number | null;
	/** Measured live via qemu-img info -U; 0 = unmeasured (never a claim of emptiness). */
	readonly diskActualBytes: number;
	/** The guest.json-drift note, or null when the manifest matches the current config. */
	readonly note: string | null;
}

/**
 * The drift note (spec 26's edge case): the manifest is what was baked; when the
 * fields it records differ from the CURRENT guest.json, the row says so and where
 * the edit lands (the NEXT build). Spec 29 added the agent to the recorded set
 * (28d's gap closed); a legacy manifest's normalized `claude` default rides that
 * documented assumption (see the module header).
 */
function driftNote(manifest: Manifest, username: string, encrypt: boolean, agent: string): string | null {
	const changes: string[] = [];
	if (manifest.guestUser !== username) changes.push(`guestUser: ${manifest.guestUser}→${username}`);
	if (manifest.encrypt !== encrypt) changes.push(`encrypt: ${manifest.encrypt}→${encrypt}`);
	if (manifest.agent !== agent) changes.push(`agent: ${manifest.agent}→${agent}`);
	if (changes.length === 0) return null;
	return `guest.json changed since this golden was baked (${changes.join(", ")}) — edits apply on the next vm install`;
}

/**
 * `openhammer vm list` (spec 26f) — every golden, newest first, with its manifest's
 * recorded shape, its live-measured actual disk size, corrupt manifests surfaced as
 * rows, and the guest.json-drift note. Never throws on a degraded tree (a broken
 * qemu-img or a corrupt manifest degrades the row, not the command).
 */
export async function vmList(deps: ManageDeps = {}): Promise<GoldenSummary[]> {
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const runQemuImgFn = deps.runQemuImg ?? ((args: readonly string[]) => runBinDefault(QEMU_IMG_BIN, args));
	const config = loadGuestConfig(dirs); // the CURRENT doc — the drift comparison's other side
	const rows: GoldenSummary[] = [];
	for (const golden of listGoldenDirs(dirs)) {
		const manifest = golden.manifest;
		const info = await runQemuImgFn(["info", "-U", "--output=json", join(golden.dir, GOLDEN_DISK_FILE)]);
		rows.push({
			id: golden.id,
			manifestOk: manifest !== null,
			flavor: manifest?.flavor ?? null,
			guestUser: manifest?.guestUser ?? null,
			encrypt: manifest?.encrypt ?? null,
			builtAt: manifest?.builtAt ?? null,
			isoVersion: manifest?.isoVersion ?? null,
			diskVirtualSizeBytes: manifest?.diskVirtualSizeBytes ?? null,
			diskActualBytes: actualSizeOf(info.stdoutTail),
			note: manifest === null ? null : driftNote(manifest, config.username, config.encrypt, config.agent),
		});
	}
	return rows;
}

// ---- vm reset ----

export interface ResetOptions {
	/** false (default) → the dry run: report exactly, remove nothing. */
	readonly yes?: boolean;
}

/** One reclaim category's totals (gc's aggregate-footprint report reuses this). */
export interface CategoryFootprint {
	readonly count: number;
	readonly bytes: number;
}

export interface ResetReport {
	/** true when nothing was removed (the dry-run default). */
	readonly dryRun: boolean;
	readonly sessions: CategoryFootprint;
	/** The stale session dirs removed (or, on a dry run, that would be). */
	readonly removed: readonly string[];
	/** The session dirs kept, with the sweep-posture reason for each. */
	readonly kept: readonly KeptSession[];
}

/**
 * `openhammer vm reset` (spec 26f) — discard stale session dirs: every dir whose
 * qemu.pid names a dead pid, with a footprint report (dir count + bytes). Refuses
 * outright when a live ours-QEMU session exists (single-flight, naming it); keeps
 * no-pidfile/garbage-pidfile/live-foreign dirs and reports why; NEVER touches
 * goldens or cidata. Dry run by default; `--yes` removes (the module's confirm
 * precedent — see the header).
 */
export async function vmReset(deps: ManageDeps = {}, options: ResetOptions = {}): Promise<ResetReport> {
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const log = deps.log ?? ((line: string) => console.log(line));
	const scan = deps.scanActiveSessions ?? (() => scanActiveVmSessions(dirs));
	const active = (await scan())[0];
	if (active !== undefined) {
		throw activeSessionRefusal("reset", active);
	}
	const readProc = deps.readProc ?? readProcDefault;
	const duOf = deps.duOf ?? duOfDefault;

	const removed: string[] = [];
	const kept: KeptSession[] = [];
	let bytes = 0;
	for (const sessionDir of listSessionDirs(dirs)) {
		const verdict = classifySession(sessionDir, readProc);
		if (verdict.kind === "kept") {
			kept.push({ dir: sessionDir, reason: verdict.reason });
			log(`reset: kept ${sessionDir} (${verdict.reason})`);
			continue;
		}
		const size = await duOf(sessionDir); // size before remove — only finished removals count
		if (options.yes === true) {
			try {
				rmSync(sessionDir, { recursive: true, force: true });
			} catch (error) {
				throw new Error(`vm reset: cannot remove ${sessionDir}: ${messageOf(error)}`);
			}
			log(`reset: removed ${sessionDir} (${size} B)`);
		} else {
			log(`reset: would remove ${sessionDir} (${size} B)`);
		}
		removed.push(sessionDir);
		bytes += size;
	}
	if (options.yes === true) {
		log(`reset: removed ${removed.length} session dir(s), reclaimed ${bytes} B`);
	} else {
		log(`reset: DRY RUN — ${removed.length} session dir(s), ${bytes} B — rerun with --yes to remove`);
	}
	return { dryRun: options.yes !== true, sessions: { count: removed.length, bytes }, removed, kept };
}

// ---- vm gc ----

export interface GcOptions {
	/** How many goldens to keep, newest first (default {@link DEFAULT_KEEP_GOLDENS}; must be >= 1). */
	readonly keepGoldens?: number;
	/** false (default) → the dry run: report exactly, remove nothing. */
	readonly yes?: boolean;
}

export interface GcReport {
	/** true when nothing was removed (the dry-run default). */
	readonly dryRun: boolean;
	readonly sessions: CategoryFootprint;
	readonly cidata: CategoryFootprint;
	readonly goldens: CategoryFootprint;
	/** Paths actually removed (empty arrays on a dry run — the counts above are the plan). */
	readonly removed: {
		readonly sessions: readonly string[];
		readonly cidata: readonly string[];
		readonly goldens: readonly string[];
	};
	/** Goldens beyond the keep count that an overlay's backing file still references. */
	readonly protectedGoldens: readonly string[];
}

/**
 * `openhammer vm gc` (spec 26f) — the aggregate-footprint reclaimer over three
 * categories: stale session dirs (the reset classification), orphaned cidata builds
 * (no matching session — including sessions going in this same pass), and goldens
 * beyond the keep count, oldest first, the newest ALWAYS kept, overlay-referenced
 * goldens protected best-effort. Refuses outright when a live ours-QEMU session
 * exists (single-flight with install, naming it). Dry run by default; `--yes`
 * removes. See the module header for the full touch/never-touch table.
 */
export async function vmGc(deps: ManageDeps = {}, options: GcOptions = {}): Promise<GcReport> {
	const keepGoldens = options.keepGoldens ?? DEFAULT_KEEP_GOLDENS;
	if (!Number.isInteger(keepGoldens) || keepGoldens < 1) {
		throw new Error(`vm gc: keepGoldens must be an integer >= 1 (got ${options.keepGoldens})`);
	}
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const log = deps.log ?? ((line: string) => console.log(line));
	const scan = deps.scanActiveSessions ?? (() => scanActiveVmSessions(dirs));
	const active = (await scan())[0];
	if (active !== undefined) {
		throw activeSessionRefusal("gc", active);
	}
	const readProc = deps.readProc ?? readProcDefault;
	const duOf = deps.duOf ?? duOfDefault;
	const runQemuImgFn = deps.runQemuImg ?? ((args: readonly string[]) => runBinDefault(QEMU_IMG_BIN, args));
	const acting = options.yes === true;

	// ---- sessions: the reset classification ----
	const sessionDirs = listSessionDirs(dirs);
	const staleSessions: string[] = [];
	for (const sessionDir of sessionDirs) {
		if (classifySession(sessionDir, readProc).kind === "stale") staleSessions.push(sessionDir);
	}
	const staleSet = new Set(staleSessions);

	// ---- cidata: builds whose session is gone — or going in this same pass ----
	const sessionNames = new Set(sessionDirs.map((dir) => basename(dir)));
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(dirs.cidata, { withFileTypes: true });
	} catch {
		entries = []; // no cidata root — nothing orphaned
	}
	const buildNames = new Set<string>();
	for (const entry of entries) {
		if (entry.isDirectory()) buildNames.add(entry.name);
		else if (entry.isFile() && entry.name.endsWith(ISO_SUFFIX))
			buildNames.add(entry.name.slice(0, -ISO_SUFFIX.length));
	}
	const orphanCidataPaths: string[] = [];
	let cidataCount = 0;
	for (const name of buildNames) {
		const sessionDir = join(dirs.sessions, name);
		if (sessionNames.has(name) && !staleSet.has(sessionDir)) continue; // still referenced
		const buildDir = join(dirs.cidata, name);
		if (statSync(buildDir, { throwIfNoEntry: false }) !== undefined) orphanCidataPaths.push(buildDir);
		const isoPath = `${buildDir}${ISO_SUFFIX}`;
		if (statSync(isoPath, { throwIfNoEntry: false }) !== undefined) orphanCidataPaths.push(isoPath);
		cidataCount += 1;
	}

	// ---- goldens: beyond the keep count, minus overlay-referenced ones ----
	const referenced = await scanOverlayBackingFiles(sessionDirs, runQemuImgFn);
	const reclaimGoldens: GoldenDir[] = [];
	const protectedGoldens: string[] = [];
	for (const golden of listGoldenDirs(dirs).slice(keepGoldens)) {
		if (referenced.has(resolve(join(golden.dir, GOLDEN_DISK_FILE)))) {
			protectedGoldens.push(golden.id);
			log(`gc: golden ${golden.id} kept — an overlay's backing file still references it`);
			continue;
		}
		reclaimGoldens.push(golden);
	}

	// ---- footprints (measured BEFORE any removal; independent → parallel) ----
	const [sessionBytes, cidataBytes, goldenBytes] = await Promise.all([
		sumOf(staleSessions.map((path) => duOf(path))),
		sumOf(orphanCidataPaths.map((path) => duOf(path))),
		sumOf(reclaimGoldens.map((golden) => duOf(golden.dir))),
	]);

	// ---- the removal (only under --yes; the dry run computed the identical plan) ----
	const remove = (path: string): void => {
		try {
			rmSync(path, { recursive: true, force: true });
		} catch (error) {
			throw new Error(`vm gc: cannot remove ${path}: ${messageOf(error)}`);
		}
	};
	if (acting) {
		for (const sessionDir of staleSessions) {
			remove(sessionDir);
			log(`gc: removed session ${sessionDir}`);
		}
		for (const path of orphanCidataPaths) {
			remove(path);
			log(`gc: removed cidata ${path}`);
		}
		for (const golden of reclaimGoldens) {
			remove(golden.dir);
			log(`gc: removed golden ${golden.id} (${golden.dir})`);
		}
	} else {
		for (const sessionDir of staleSessions) log(`gc: would remove session ${sessionDir}`);
		for (const path of orphanCidataPaths) log(`gc: would remove cidata ${path}`);
		for (const golden of reclaimGoldens) log(`gc: would remove golden ${golden.id} (${golden.dir})`);
	}
	const totals =
		`sessions ${staleSessions.length}/${sessionBytes} B, cidata ${cidataCount}/${cidataBytes} B, ` +
		`goldens ${reclaimGoldens.length}/${goldenBytes} B`;
	log(acting ? `gc: reclaimed ${totals}` : `gc: DRY RUN — ${totals} — rerun with --yes to reclaim`);

	return {
		dryRun: !acting,
		sessions: { count: staleSessions.length, bytes: sessionBytes },
		cidata: { count: cidataCount, bytes: cidataBytes },
		goldens: { count: reclaimGoldens.length, bytes: goldenBytes },
		removed: {
			sessions: acting ? staleSessions : [],
			cidata: acting ? orphanCidataPaths : [],
			goldens: acting ? reclaimGoldens.map((golden) => golden.dir) : [],
		},
		protectedGoldens,
	};
}

async function sumOf(sizes: readonly Promise<number>[]): Promise<number> {
	return (await Promise.all(sizes)).reduce((total, size) => total + size, 0);
}
