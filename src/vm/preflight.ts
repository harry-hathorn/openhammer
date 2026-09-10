// Boot preflight — spec 27's src/vm/preflight.ts: the fail-fatal gate a VM-mode boot
// runs BEFORE any spawn. Every check is synchronous and every failure is ONE
// actionable line — the deliberate deviation from the channel null-safe pattern
// (spec 27 "Boot posture", argued there): a tunnel that fails to start degrades to
// localhost and the server is still useful, but a VM boot with a missing prerequisite
// has nothing to degrade TO, and a half-booted sandbox is exactly the failure mode the
// VM wall exists to prevent. `main` (27f) turns `{ ok: false }` into the one-line
// non-zero exit; doctor (27d) re-runs the same checks through the same seams as
// non-fatal advice.
//
// THE CHECK ORDER IS THE CONTRACT (cheapest-and-most-fundamental first, each row
// pinned by a test): platform → qemu/qemu-img on PATH → OVMF pair readable →
// /dev/kvm readable+writable → newest golden manifest valid → guest root absolute →
// free disk under the vm tree → memory bounds → display literal.
//
// NO TCG FALLBACK (the 22-measured chassis is KVM): `/dev/kvm` absence is fatal,
// never a `-accel tcg` degradation — "fail fast, never silently degrade". The same
// no-degrade rule runs through every row: nothing here falls back, retries, or guesses.
//
// THE DISK EXCEPTION (the one warning-shaped pass): a disk preflight CANNOT measure
// (statfs fails on the path) SKIPS the check instead of failing the boot. An
// unmeasurable disk is not a missing prerequisite, and low-disk is degradation over a
// session's lifetime rather than a boot-time impossibility — doctor (27d) is the loud
// surface for it. Everything else stays fatal.
//
// THE GOLDEN SCAN mirrors manage.ts's listGoldenDirs/orderKeyOf posture, restated
// here (the readProcDefault precedent — consolidate when spec 27's service extracts
// the shared scan): newest-first by the manifest's builtAt, falling back to the id's
// trailing `-YYYYMMDD-HHMMSS` stamp. The NEWEST golden must be valid — preflight
// never falls back to a valid predecessor (gc's "the newest is the active golden").
//
// OFF MODE = ZERO VM CODE (spec 27's requirement): mode `off` returns ok BEFORE any
// dep is resolved, pinned by a test that counts dep calls at zero. There is no `env`
// seam on purpose: ResolvedVmConfig arrives fully coerced (resolveConfig owns env;
// the variable names below appear only inside message strings), so preflight judges
// values, never strings.
import { accessSync, constants, type Dirent, readdirSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedVmConfig } from "../config.ts";
import { type Manifest, readManifest, type StatPath } from "./provision/snapshot.ts";
import { OVMF_CODE, OVMF_VARS } from "./qemu/args.ts";
import { missingBinaryHint, QEMU_BIN, QEMU_IMG_BIN, qemuAvailable, qemuImgAvailable } from "./qemu/process.ts";
import { resolveVmDirs } from "./session.ts";

/** One boot-posture decision: all clear, or the ONE actionable line that ends the boot. */
export type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

// ---- the external seams (the box contract: defaults = the real ones) ----

/** `accessSync`'s shape: returns on permission GRANTED, throws on denial. */
export type AccessPath = (path: string, mode: number) => void;

/** `readManifest`'s shape (snapshot.ts) — the golden-validity seam. */
export type ReadManifest = (path: string) => Manifest | null;

/**
 * The free-bytes seam (default: real `statfsSync`, node ≥ 18.15). `undefined` =
 * unmeasurable — the disk check's warning-shaped pass (see the module header).
 */
export type FreeBytes = (path: string) => number | undefined;

/**
 * Injection seams for EVERYTHING external (the repo's box contract: defaults are the
 * real implementations, so the hermetic trio never requires KVM/QEMU/OVMF).
 */
export interface PreflightDeps {
	/** The platform gate's subject (default: process.platform). */
	readonly platform?: NodeJS.Platform;
	/** Override the `qemu-system-x86_64` PATH probe (default: qemuAvailable). */
	readonly qemuOnPath?: () => boolean;
	/** Override the `qemu-img` PATH probe (default: qemuImgAvailable). */
	readonly qemuImgOnPath?: () => boolean;
	/** Override the existence stat (default: statSync with throwIfNoEntry). */
	readonly stat?: StatPath;
	/** Override the permission probe (default: accessSync). */
	readonly access?: AccessPath;
	/** Override the golden-manifest reader (default: snapshot.ts's readManifest). */
	readonly readManifest?: ReadManifest;
	/** Override the HOME the golden tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the free-space measure (default: statfsSync's bavail × bsize). */
	readonly freeBytes?: FreeBytes;
}

// ---- the fixed names / bounds this gate owns ----

/** The acceleration device the 22-measured chassis requires — absent means no VM, never TCG. */
const KVM_DEVICE = "/dev/kvm";

/**
 * Guest RAM bounds (MiB): 2048 floor (a desktop guest under 2G thrashes), 16384 cap
 * (the host keeps its own RAM — a bigger ask is a doctor free-RAM conversation, not
 * a boot decision).
 */
const MEMORY_MIN_MB = 2048;
const MEMORY_MAX_MB = 16384;

/** One GiB — `diskCapGb`'s unit on both sides of the comparison. */
const GIB = 1024 ** 3;

const GOLDEN_PREFIX = "golden-";
const MANIFEST_FILE = "manifest.json";

/** The remedy every golden failure names — the full build pipeline, in order. */
const GOLDEN_REMEDY = "run: openhammer vm install && openhammer vm provision && openhammer vm snapshot";

const statDefault: StatPath = (path) => statSync(path, { throwIfNoEntry: false });
const accessDefault: AccessPath = (path, mode) => accessSync(path, mode);
const readManifestDefault: ReadManifest = (path) => readManifest(path);

// `bavail` (available to unprivileged processes) × `bsize` — the bytes an overlay can
// actually grow into. Any statfs failure is `undefined`: unmeasurable, NOT zero (a
// zero would read as "low disk" and fail a boot that may have plenty).
const freeBytesDefault: FreeBytes = (path) => {
	try {
		const info = statfsSync(path);
		return info.bavail * info.bsize;
	} catch {
		return undefined;
	}
};

const fail = (message: string): PreflightResult => ({ ok: false, message });

// accessSync's throw-on-denial folded into a predicate (the stat/access split: stat
// answers DOES it exist, access answers MAY we use it).
function canAccess(access: AccessPath, path: string, mode: number): boolean {
	try {
		access(path, mode);
		return true;
	} catch {
		return false;
	}
}

// ---- the newest-golden scan (manage.ts's posture, restated) ----

/** One golden candidate: its dir id and the manifest the seam read (`null` = absent/corrupt). */
interface GoldenDir {
	readonly id: string;
	readonly manifest: Manifest | null;
}

// manage.ts's orderKeyOf, verbatim in shape: the manifest's builtAt (digits only, so
// ISO stamps compare), falling back to the id's trailing stamp (a corrupt manifest
// still sorts by when it was minted), "" last.
function orderKeyOf(golden: GoldenDir): string {
	const builtAt = golden.manifest?.builtAt;
	if (builtAt !== undefined) return builtAt.replace(/\D/g, "");
	const stamp = /(\d{8}-\d{6})$/.exec(golden.id);
	return stamp === null ? "" : (stamp[1] ?? "").replaceAll("-", "");
}

/**
 * The NEWEST `images/golden-<id>` dir, or `null` when the tree has none (an absent
 * images root included). Strays (non-dirs, non-`golden-` names) are not goldens —
 * the manage.ts rule.
 */
function newestGolden(imagesDir: string, read: ReadManifest): GoldenDir | null {
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(imagesDir, { withFileTypes: true });
	} catch {
		return null; // no images root — no goldens
	}
	const goldens: GoldenDir[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory() || !entry.name.startsWith(GOLDEN_PREFIX)) continue;
		goldens.push({ id: entry.name, manifest: read(join(imagesDir, entry.name, MANIFEST_FILE)) });
	}
	goldens.sort((a, b) => {
		const keyA = orderKeyOf(a);
		const keyB = orderKeyOf(b);
		if (keyA !== keyB) return keyA < keyB ? 1 : -1;
		return a.id < b.id ? 1 : -1;
	});
	return goldens.length === 0 ? null : goldens[0];
}

/**
 * Spec 27's boot preflight: run every VM-mode prerequisite check, in the module
 * header's fixed order, and report the FIRST failure as one actionable line.
 * Synchronous by design — these are all local probes (stat/access/readdir/statfs),
 * and the boot path that calls this wants its answer before `listen()`.
 *
 * `rootDir` is the guest root (the 27b reinterpretation — `ResolvedConfig.rootDir`,
 * threaded separately from the {@link ResolvedVmConfig} family because that is the
 * server shape, not the vm surface).
 *
 * Mode `off` returns `{ ok: true }` before ANY dep is resolved — the zero-VM-code
 * pin: a local boot can never fail on (or even observe) the VM stack.
 */
export function vmPreflight(config: ResolvedVmConfig, rootDir: string, deps: PreflightDeps = {}): PreflightResult {
	if (config.mode === "off") {
		return { ok: true };
	}

	// 1 — platform: the chassis is Linux/KVM; there is no ported-accel story to offer.
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") {
		return fail(`VM modes need Linux with KVM (platform: ${platform}) — see docs`);
	}

	// 2 — the two binaries. missingBinaryHint's shared line keeps doctor and preflight
	// from drifting apart; qemu first (the one that boots), then qemu-img (the one that
	// builds disks).
	const qemuOnPath = deps.qemuOnPath ?? qemuAvailable;
	if (!qemuOnPath()) {
		return fail(missingBinaryHint(QEMU_BIN));
	}
	const qemuImgOnPath = deps.qemuImgOnPath ?? qemuImgAvailable;
	if (!qemuImgOnPath()) {
		return fail(missingBinaryHint(QEMU_IMG_BIN));
	}

	const stat = deps.stat ?? statDefault;
	const access = deps.access ?? accessDefault;

	// 3 — the OVMF pair, from qemu/args.ts's consts (NOT config.image — that is the
	// golden-image override, not firmware): both must exist AND be readable (the boot
	// layer maps CODE read-only and copies VARS per session).
	for (const firmware of [OVMF_CODE, OVMF_VARS]) {
		if (stat(firmware) === undefined || !canAccess(access, firmware, constants.R_OK)) {
			return fail(`OVMF firmware missing: ${firmware} — install edk2 (Arch: sudo pacman -S edk2)`);
		}
	}

	// 4 — /dev/kvm readable AND writable. NO TCG fallback: absence is fatal (fail
	// fast, never silently degrade) — a software-emulated sandbox is not this product.
	if (stat(KVM_DEVICE) === undefined || !canAccess(access, KVM_DEVICE, constants.R_OK | constants.W_OK)) {
		return fail(
			`KVM unavailable: ${KVM_DEVICE} is not readable/writable — ` +
				"enable the kvm module and add yourself to the kvm group",
		);
	}

	// 5 — the NEWEST golden must carry a valid manifest. A corrupt newest is NAMED,
	// never silently skipped past for an older valid one (the no-degrade rule).
	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const read = deps.readManifest ?? readManifestDefault;
	const newest = newestGolden(dirs.images, read);
	if (newest === null) {
		return fail(`no valid golden image — ${GOLDEN_REMEDY}`);
	}
	if (newest.manifest === null) {
		return fail(`no valid golden image (corrupt manifest: ${newest.id}) — ${GOLDEN_REMEDY}`);
	}

	// 6 — the guest root must be absolute. resolveConfig's reinterpretation normally
	// guarantees it (`resolve()` makes host-relative values absolute), but the boundary
	// asserts it anyway: a relative guest path threaded into ssh/scp commands would
	// resolve against the HOST cwd — exactly the leak the VM wall exists to prevent.
	if (!rootDir.startsWith("/")) {
		return fail(`MCP_ROOT_DIR must be an absolute guest path in vm modes (got "${rootDir}")`);
	}

	// 7 — free space on the filesystem holding the VM TREE (overlays grow there; the
	// guest root names inside-guest space). The check-5 pass implies the tree exists,
	// so a statfs failure here is exotic — and an unmeasurable disk is the one
	// warning-shaped pass (see the module header): doctor (27d) surfaces it loudly.
	const freeBytes = deps.freeBytes ?? freeBytesDefault;
	const free = freeBytes(dirs.root);
	if (free !== undefined && free < config.diskCapGb * GIB) {
		return fail(
			`low disk space: ${Math.floor(free / GIB)}G free, VM modes want ${config.diskCapGb}G+ headroom — ` +
				"free space or lower MCP_VM_DISK_CAP_GB",
		);
	}

	// 8 — memory bounds (the consts' doc comments above).
	if (config.memoryMb < MEMORY_MIN_MB || config.memoryMb > MEMORY_MAX_MB) {
		return fail(`MCP_VM_MEMORY must be ${MEMORY_MIN_MB}-${MEMORY_MAX_MB} (got ${config.memoryMb})`);
	}

	// 9 — display: "headless" is the 22-measured winner and the only value. The type
	// already says so; this asserts it for values that arrived without the type's help
	// (an env-sourced string through some future untyped path) — qemuBootArgs' own
	// recipe-table guard would catch it later, and preflight is the cheaper place to
	// learn it.
	if (config.display !== "headless") {
		return fail(`MCP_VM_DISPLAY must be "headless" (got "${config.display}")`);
	}

	return { ok: true };
}
