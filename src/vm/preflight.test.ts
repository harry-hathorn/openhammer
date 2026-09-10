// vmPreflight units — every row is the exact one-liner (the fail-fatal contract is
// message-shaped: main prints the line verbatim, so the string IS the interface).
// The fake world: a real temp HOME with seeded golden dirs whose manifest.json files
// are REAL (the happy path exercises the REAL readManifest default over them), plus
// every other external seam faked to its passing value — the hermetic trio never
// requires KVM/QEMU/OVMF.
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedVmConfig } from "../config.ts";
import { type PreflightDeps, vmPreflight } from "./preflight.ts";
import { ISO_SHA256, ISO_URL } from "./provision/iso.ts";
import type { Manifest } from "./provision/snapshot.ts";
import { OVMF_CODE, OVMF_VARS } from "./qemu/args.ts";
import { missingBinaryHint, QEMU_BIN, QEMU_IMG_BIN } from "./qemu/process.ts";

const GUEST_ROOT = "/home/sandbox";
const NEWEST_GOLDEN = "golden-4.0.3-20260102-000000";
const OLDER_GOLDEN = "golden-4.0.3-20260101-000000";
const GIB = 1024 ** 3;
const KVM_DEVICE = "/dev/kvm";
const KVM_LINE =
	"KVM unavailable: /dev/kvm is not readable/writable — enable the kvm module and add yourself to the kvm group";

/** A full ResolvedVmConfig, vm-mode, every knob valid (override per test). */
function vmConfig(overrides: Partial<ResolvedVmConfig> = {}): ResolvedVmConfig {
	return {
		mode: "vm",
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
		agentCmd: "claude",
		secretsDir: null,
		...overrides,
	};
}

/** A valid unencrypted manifest (the snapshot.ts shape) — the real readManifest must accept it. */
function manifestOf(id: string): Manifest {
	return {
		id,
		flavor: "base",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: ISO_URL,
		isoSha256: ISO_SHA256,
		diskVirtualSizeBytes: 42_949_672_960,
		provisionScriptHashes: null,
		builtAt: builtAtOf(id),
		encrypt: false,
	};
}

/** Derive the manifest builtAt from the golden id's trailing stamp (ordering determinism). */
function builtAtOf(id: string): string {
	const stamp = /(\d{8})-(\d{6})$/.exec(id);
	if (stamp === null) throw new Error(`test bug: golden id without a stamp: ${id}`);
	const date = stamp[1] ?? "";
	const time = stamp[2] ?? "";
	return (
		`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` +
		`T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
	);
}

/** Which golden dirs the temp HOME seeds (default: one — the newest). */
interface HarnessOptions {
	readonly goldens?: readonly string[];
	/** Write garbage instead of a valid manifest.json into these ids (corruption rows). */
	readonly corrupt?: readonly string[];
}

/**
 * The fake world: temp HOME + seeded golden dirs + every seam at its passing value.
 * `readManifest` is deliberately NOT injected — the default real reader runs over the
 * seeded files, so the golden rows exercise the real validation path.
 */
function harness(options: HarnessOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "openhammer-preflight-"));
	const images = join(home, ".openhammer", "vm", "images");
	for (const id of options.goldens ?? [NEWEST_GOLDEN]) {
		const dir = join(images, id);
		mkdirSync(dir, { recursive: true });
		const body = options.corrupt?.includes(id) ? "{ not json" : `${JSON.stringify(manifestOf(id), null, 2)}\n`;
		writeFileSync(join(dir, "manifest.json"), body);
	}
	// A real Stats from a path that always exists — the faked stat()'s return shape.
	const anyStats = statSync(home);
	const deps: PreflightDeps = {
		platform: "linux",
		qemuOnPath: () => true,
		qemuImgOnPath: () => true,
		stat: () => anyStats,
		access: () => undefined,
		homeDir: home,
		freeBytes: () => 100 * GIB,
	};
	return {
		home,
		images,
		deps,
		anyStats,
		cleanup: (): void => rmSync(home, { recursive: true, force: true }),
	};
}

type Harness = ReturnType<typeof harness>;

/** One failure row: the world it needs, the one seam/config it breaks, the exact line. */
interface FailureRow {
	readonly name: string;
	readonly world?: HarnessOptions;
	readonly config?: Partial<ResolvedVmConfig>;
	readonly rootDir?: string;
	readonly patch?: (h: Harness) => PreflightDeps;
	readonly message: string;
}

const FAILURE_ROWS: readonly FailureRow[] = [
	{
		name: "platform is not linux",
		patch: (h) => ({ ...h.deps, platform: "win32" }),
		message: "VM modes need Linux with KVM (platform: win32) — see docs",
	},
	{
		name: "qemu-system-x86_64 is not on PATH",
		patch: (h) => ({ ...h.deps, qemuOnPath: () => false }),
		message: `${QEMU_BIN} is not on PATH — install the VM stack (Arch: sudo pacman -S qemu-desktop qemu-img edk2)`,
	},
	{
		name: "qemu-img is not on PATH",
		patch: (h) => ({ ...h.deps, qemuImgOnPath: () => false }),
		message: `${QEMU_IMG_BIN} is not on PATH — install the VM stack (Arch: sudo pacman -S qemu-desktop qemu-img edk2)`,
	},
	{
		name: "OVMF CODE is absent",
		patch: (h) => ({ ...h.deps, stat: (path) => (path === OVMF_CODE ? undefined : h.anyStats) }),
		message: `OVMF firmware missing: ${OVMF_CODE} — install edk2 (Arch: sudo pacman -S edk2)`,
	},
	{
		name: "OVMF VARS is unreadable",
		patch: (h) => ({
			...h.deps,
			access: (path) => {
				if (path === OVMF_VARS) throw new Error("EACCES: permission denied");
			},
		}),
		message: `OVMF firmware missing: ${OVMF_VARS} — install edk2 (Arch: sudo pacman -S edk2)`,
	},
	{
		name: "/dev/kvm is absent",
		patch: (h) => ({ ...h.deps, stat: (path) => (path === KVM_DEVICE ? undefined : h.anyStats) }),
		message: KVM_LINE,
	},
	{
		name: "/dev/kvm is not writable",
		patch: (h) => ({
			...h.deps,
			access: (path, mode) => {
				if (path === KVM_DEVICE && (mode & 2) !== 0) throw new Error("EACCES: permission denied");
			},
		}),
		message: KVM_LINE,
	},
	{
		name: "no golden tree at all",
		world: { goldens: [] },
		message:
			"no valid golden image — run: openhammer vm install && openhammer vm provision && openhammer vm snapshot",
	},
	{
		name: "the newest golden's manifest is corrupt (the id is named)",
		world: { corrupt: [NEWEST_GOLDEN] },
		message:
			`no valid golden image (corrupt manifest: ${NEWEST_GOLDEN}) — ` +
			"run: openhammer vm install && openhammer vm provision && openhammer vm snapshot",
	},
	{
		name: "the guest root is relative",
		rootDir: "work/sandbox",
		message: 'MCP_ROOT_DIR must be an absolute guest path in vm modes (got "work/sandbox")',
	},
	{
		name: "free disk under the cap",
		patch: (h) => ({ ...h.deps, freeBytes: () => 10 * GIB }),
		message: "low disk space: 10G free, VM modes want 45G+ headroom — free space or lower MCP_VM_DISK_CAP_GB",
	},
	{
		name: "memory below the floor",
		config: { memoryMb: 1024 },
		message: "MCP_VM_MEMORY must be 2048-16384 (got 1024)",
	},
	{
		name: "memory above the cap",
		config: { memoryMb: 32768 },
		message: "MCP_VM_MEMORY must be 2048-16384 (got 32768)",
	},
	{
		name: "display is not the literal headless",
		// "gl" bypasses the "headless" type the way an env-sourced string would — the
		// runtime assert is the code under test, so the cast is the test's injection point.
		config: { display: "gl" as ResolvedVmConfig["display"] },
		message: 'MCP_VM_DISPLAY must be "headless" (got "gl")',
	},
];

describe("vmPreflight — failure rows (each the exact one-liner)", () => {
	for (const row of FAILURE_ROWS) {
		it(row.name, () => {
			const h = harness(row.world);
			try {
				const deps = row.patch === undefined ? h.deps : row.patch(h);
				const result = vmPreflight(vmConfig(row.config), row.rootDir ?? GUEST_ROOT, deps);
				expect(result).toEqual({ ok: false, message: row.message });
			} finally {
				h.cleanup();
			}
		});
	}
});

describe("vmPreflight — the happy paths", () => {
	it("vm mode: every seam real-shaped (real manifest.json through the REAL readManifest default) → ok", () => {
		const h = harness();
		try {
			expect(vmPreflight(vmConfig(), GUEST_ROOT, h.deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});

	it("agent mode runs the same gate (both VM modes, one posture)", () => {
		const h = harness();
		try {
			expect(vmPreflight(vmConfig({ mode: "agent" }), GUEST_ROOT, h.deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});

	it("memory bounds are inclusive (2048 and 16384 both pass)", () => {
		const h = harness();
		try {
			expect(vmPreflight(vmConfig({ memoryMb: 2048 }), GUEST_ROOT, h.deps)).toEqual({ ok: true });
			expect(vmPreflight(vmConfig({ memoryMb: 16384 }), GUEST_ROOT, h.deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});
});

describe("vmPreflight — off mode (the zero-VM-code pin)", () => {
	it("returns ok without calling a single dep, hostile values and all", () => {
		const calls: string[] = [];
		const deps: PreflightDeps = {
			// platform and homeDir are inert DATA (no call to count — the reads that
			// would use them never run); every callable seam below records + lies.
			platform: "win32",
			homeDir: "/nonexistent",
			qemuOnPath: () => {
				calls.push("qemuOnPath");
				return false;
			},
			qemuImgOnPath: () => {
				calls.push("qemuImgOnPath");
				return false;
			},
			stat: () => {
				calls.push("stat");
				return undefined;
			},
			access: () => {
				calls.push("access");
				throw new Error("EACCES: permission denied");
			},
			readManifest: () => {
				calls.push("readManifest");
				return null;
			},
			freeBytes: () => {
				calls.push("freeBytes");
				return undefined;
			},
		};
		// A relative root and hostile knobs too: off mode judges nothing but the mode.
		expect(vmPreflight(vmConfig({ mode: "off" }), "relative/is/fine", deps)).toEqual({ ok: true });
		expect(calls).toEqual([]);
	});
});

describe("vmPreflight — check order", () => {
	it("the platform gate wins over every later failure", () => {
		const h = harness({ goldens: [] });
		try {
			const deps: PreflightDeps = {
				...h.deps,
				platform: "darwin",
				qemuOnPath: () => false,
				stat: () => undefined,
				access: () => {
					throw new Error("EACCES: permission denied");
				},
			};
			expect(vmPreflight(vmConfig({ memoryMb: 1 }), "relative", deps)).toEqual({
				ok: false,
				message: "VM modes need Linux with KVM (platform: darwin) — see docs",
			});
		} finally {
			h.cleanup();
		}
	});

	it("the earlier of two stacked failures wins (OVMF before KVM)", () => {
		const h = harness();
		try {
			const deps: PreflightDeps = {
				...h.deps,
				stat: (path) => (path === OVMF_CODE || path === KVM_DEVICE ? undefined : h.anyStats),
			};
			expect(vmPreflight(vmConfig(), GUEST_ROOT, deps)).toEqual({
				ok: false,
				message: `OVMF firmware missing: ${OVMF_CODE} — install edk2 (Arch: sudo pacman -S edk2)`,
			});
		} finally {
			h.cleanup();
		}
	});

	it("the binary lines ARE missingBinaryHint's — doctor and preflight cannot drift apart", () => {
		const h = harness();
		try {
			const qemuRow = vmPreflight(vmConfig(), GUEST_ROOT, { ...h.deps, qemuOnPath: () => false });
			const imgRow = vmPreflight(vmConfig(), GUEST_ROOT, { ...h.deps, qemuImgOnPath: () => false });
			expect(qemuRow).toEqual({ ok: false, message: missingBinaryHint(QEMU_BIN) });
			expect(imgRow).toEqual({ ok: false, message: missingBinaryHint(QEMU_IMG_BIN) });
		} finally {
			h.cleanup();
		}
	});
});

describe("vmPreflight — the newest-golden rule", () => {
	it("names the NEWEST corrupt id even when an older golden is valid (no fallback)", () => {
		const h = harness({ goldens: [OLDER_GOLDEN, NEWEST_GOLDEN], corrupt: [NEWEST_GOLDEN] });
		try {
			expect(vmPreflight(vmConfig(), GUEST_ROOT, h.deps)).toEqual({
				ok: false,
				message:
					`no valid golden image (corrupt manifest: ${NEWEST_GOLDEN}) — ` +
					"run: openhammer vm install && openhammer vm provision && openhammer vm snapshot",
			});
		} finally {
			h.cleanup();
		}
	});

	it("passes when the newest is valid and only an OLDER golden is corrupt (the active one is what boots)", () => {
		const h = harness({ goldens: [OLDER_GOLDEN, NEWEST_GOLDEN], corrupt: [OLDER_GOLDEN] });
		try {
			expect(vmPreflight(vmConfig(), GUEST_ROOT, h.deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});
});

describe("vmPreflight — the disk decision (the one warning-shaped pass)", () => {
	it("an unmeasurable disk (statfs seam fails) is NOT a preflight failure", () => {
		const h = harness();
		try {
			const deps: PreflightDeps = { ...h.deps, freeBytes: () => undefined };
			expect(vmPreflight(vmConfig(), GUEST_ROOT, deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});

	it("exactly cap×GiB passes (>=, not >)", () => {
		const h = harness();
		try {
			const deps: PreflightDeps = { ...h.deps, freeBytes: () => 45 * GIB };
			expect(vmPreflight(vmConfig({ diskCapGb: 45 }), GUEST_ROOT, deps)).toEqual({ ok: true });
		} finally {
			h.cleanup();
		}
	});

	it("the free figure floors to whole G (10.9 GiB reports 10G, conservative)", () => {
		const h = harness();
		try {
			const deps: PreflightDeps = { ...h.deps, freeBytes: () => Math.floor(10.9 * GIB) };
			expect(vmPreflight(vmConfig(), GUEST_ROOT, deps)).toEqual({
				ok: false,
				message: "low disk space: 10G free, VM modes want 45G+ headroom — free space or lower MCP_VM_DISK_CAP_GB",
			});
		} finally {
			h.cleanup();
		}
	});
});
