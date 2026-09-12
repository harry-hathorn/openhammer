/**
 * Host-environment detection + per-environment setup advice (28k, tier 1): the
 * READ-ONLY half of "the TUI facilitates installs". It probes nothing the boot
 * doesn't already gate on — the same single sources as the preflight
 * (qemu/process.ts's availability fns, qemu/args.ts's OVMF consts, the
 * `/dev/kvm` device) — and turns the result into the exact remedy lines the
 * detected distro needs. It installs NOTHING: every line is either a copyable
 * command or a firmware/group directive only the operator can perform.
 *
 * **Distro matrix (tier 1):** the family comes from `/etc/os-release` (ID,
 * then ID_LIKE), and the install-command table covers the four main families
 * with a generic fallback. No network, no package-manager spawns: two file
 * reads, one directory stat, and the same two PATH probes a boot already runs.
 * Any read failure degrades to "unknown family"/absent — advice, never a
 * crash (the `vmRoot` unresolvable-env posture).
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { OVMF_CODE, OVMF_VARS } from "./qemu/args.ts";
import { qemuAvailable, qemuImgAvailable } from "./qemu/process.ts";

/** The accel device (preflight.ts's KVM_DEVICE, restated — not exported there). */
const KVM_DEVICE = "/dev/kvm";

/** Distro families the advice table knows (derived from /etc/os-release). */
export type DistroFamily = "arch" | "debian" | "fedora" | "suse" | "unknown";

/** The family → install-command table: one line covers the whole VM stack. */
const INSTALL_LINES: Record<DistroFamily, string> = {
	arch: "sudo pacman -S --needed qemu-desktop qemu-img edk2",
	debian: "sudo apt-get install -y qemu-system-x86 qemu-utils ovmf",
	fedora: "sudo dnf install -y qemu-kvm edk2-ovmf",
	suse: "sudo zypper install -y qemu-x86 ovmf",
	unknown: "install qemu-system-x86_64 + OVMF firmware with your distro's package manager",
};

/** os-release ids (ID, then ID_LIKE tokens) each family claims, in claim order. */
const FAMILY_IDS: ReadonlyArray<readonly [DistroFamily, readonly string[]]> = [
	["arch", ["arch", "manjaro", "endeavouros", "cachyos", "artix"]],
	["debian", ["debian", "ubuntu", "pop", "pop_os", "linuxmint", "mint", "raspbian", "neon"]],
	["fedora", ["fedora", "rhel", "centos", "rocky", "almalinux", "ol"]],
	["suse", ["opensuse-leap", "opensuse-tumbleweed", "opensuse", "suse", "sles"]],
];

/** Strip surrounding quotes + lowercase an os-release value. */
function releaseValue(raw: string): string {
	return raw.replace(/^"|"$/g, "").trim().toLowerCase();
}

/**
 * Map `/etc/os-release` text to a {@link DistroFamily}: the ID token wins,
 * then ID_LIKE tokens. Pure — the fs read is the caller's, so every family is
 * unit-testable from a fixture string.
 */
export function familyFromOsRelease(text: string): DistroFamily {
	const id = /^ID=(.*)$/m.exec(text)?.[1];
	const like = /^ID_LIKE=(.*)$/m.exec(text)?.[1];
	const tokens = [...(id ? [releaseValue(id)] : []), ...(like ? like.split(" ").map(releaseValue) : [])].filter(
		(token) => token !== "",
	);
	for (const [family, names] of FAMILY_IDS) {
		if (tokens.some((token) => names.includes(token))) return family;
	}
	return "unknown";
}

/** Injection seams — every probe is injectable so tests stay hermetic (the preflight box contract). */
export interface HostEnvDeps {
	/** Default: process.platform. */
	platform?: NodeJS.Platform;
	/** `/etc/os-release` contents. Default: the real read; absent → unknown family. */
	osRelease?: () => string | null;
	/** `/proc/version` contents. Default: the real read; absent → no WSL note. */
	procVersion?: () => string | null;
	/** Default: qemu/process.ts's {@link qemuAvailable}. */
	qemuOnPath?: () => boolean;
	/** Default: qemu/process.ts's {@link qemuImgAvailable}. */
	qemuImgOnPath?: () => boolean;
	/** Default: existsSync. */
	ovmfPresent?: (path: string) => boolean;
	/** Default: existsSync on /dev/kvm. */
	kvmPresent?: () => boolean;
	/** Default: accessSync R|W on /dev/kvm. */
	kvmReadWrite?: () => boolean;
}

/** Read a file or `null` — a missing/foreign host degrades, never throws. */
function readOrNull(path: string): string | null {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return null;
	}
}

/** R|W access probe that collapses every failure to `false`. */
function canReadWrite(path: string): boolean {
	try {
		accessSync(path, constants.R_OK | constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * The Sandbox screen's per-environment remedy lines (28k, tier 1). Empty when
 * the host can already boot (or nothing actionable was detectable — e.g. a
 * non-Linux platform gets ONE honest line, not a wall of Linux commands).
 * Order: the platform gate (it voids everything else), then the install
 * command (qemu/qemu-img/OVMF are ONE stack per family), then the KVM device
 * (absent = firmware/nested directive — on WSL, the honest WSL note; present
 * but unwritable = the kvm-group command).
 */
export function hostSandboxAdvice(deps: HostEnvDeps = {}): string[] {
	const platform = deps.platform ?? process.platform;
	if (platform !== "linux") {
		return [`VM modes need Linux with KVM — this host is ${platform}; deploy on Linux to use the sandbox`];
	}

	const family = familyFromOsRelease(deps.osRelease?.() ?? readOrNull("/etc/os-release") ?? "");
	const qemuOk = deps.qemuOnPath?.() ?? qemuAvailable();
	const qemuImgOk = deps.qemuImgOnPath?.() ?? qemuImgAvailable();
	const ovmfPresent = deps.ovmfPresent ?? ((path: string) => existsSync(path));
	const lines: string[] = [];
	if (!qemuOk || !qemuImgOk || !ovmfPresent(OVMF_CODE) || !ovmfPresent(OVMF_VARS)) {
		lines.push(`install the VM stack — ${INSTALL_LINES[family]}`);
	}

	const kvmPresent = deps.kvmPresent?.() ?? existsSync(KVM_DEVICE);
	const procVersion = deps.procVersion?.() ?? readOrNull("/proc/version");
	const onWsl = procVersion?.toLowerCase().includes("microsoft") === true;
	if (!kvmPresent) {
		lines.push(
			onWsl
				? "/dev/kvm is absent — WSL2 needs nested virtualization and often cannot provide it; prefer native Linux for the sandbox"
				: "/dev/kvm is absent — enable VT-x/AMD-V in your firmware (or nested virtualization if this host is itself a VM)",
		);
	} else if (!(deps.kvmReadWrite?.() ?? canReadWrite(KVM_DEVICE))) {
		lines.push(
			"/dev/kvm exists but is not writable by you — run: sudo usermod -aG kvm $USER, then log out and back in",
		);
	}
	return lines;
}
