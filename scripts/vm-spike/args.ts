// Pure QEMU argv builder — data in, string[] out, no side effects (disk/VARS prep lives in boot.ts).
import { join } from "node:path";

export type DisplayConfig = "gl" | "headless";

export const QEMU_BIN = "qemu-system-x86_64";
export const QEMU_IMG = "qemu-img";
export const DISK_SIZE = "40G";

// Split pflash on this host (spec 22 edge cases): the scratchpad's `OVMF_CODE.fd` literals are stale.
export const OVMF_CODE = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";
export const OVMF_VARS = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";

export function isDisplayConfig(value: string): value is DisplayConfig {
	return value === "gl" || value === "headless";
}

// qemu-img size suffixes are binary: 40G == 40 GiB == 42949672960 B exactly. The cidata
// partition geometry in cidata.ts is computed from this constant and must stay in lockstep
// with DISK_SIZE — the installer partitions whatever virtio block device it finds.
export const DISK_BYTES = 40 * 1024 * 1024 * 1024;

// The display recipe and the memory default couple (spec 22 gate 1): GL gets 6G, plain gets 4G.
interface DisplayRecipe {
	readonly device: string;
	readonly display: string;
	readonly memory: string;
}

const DISPLAY_RECIPES: Record<DisplayConfig, DisplayRecipe> = {
	gl: { device: "virtio-vga-gl", display: "egl-headless", memory: "6144M" },
	headless: { device: "virtio-vga", display: "none", memory: "4096M" },
};

export interface QemuArgsInput {
	/** Session name — `-name openhammer-spike-<name>` (also the session dir basename). */
	readonly name: string;
	readonly sessionDir: string;
	readonly isoPath: string;
	readonly config: DisplayConfig;
}

/**
 * Boot the LIVE ISO (installing is a later box): split OVMF (CODE readonly, per-session
 * VARS copy), QMP chardev with `server=on,wait=off` (we connect after spawn), serial to a
 * file, slirp networking with an ephemeral hostfwd ssh port (`127.0.0.1:0-:22` — the
 * assigned port is learned later via `info usernet`), blank virtio disk + cdrom.
 */
export function qemuArgs(input: QemuArgsInput): string[] {
	const recipe = DISPLAY_RECIPES[input.config];
	const session = input.sessionDir;
	return [
		"-name",
		`openhammer-spike-${input.name}`,
		"-machine",
		"q35",
		"-cpu",
		"host",
		"-accel",
		"kvm",
		"-smp",
		"4",
		"-m",
		recipe.memory,
		"-device",
		recipe.device,
		"-display",
		recipe.display,
		"-drive",
		`if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
		"-drive",
		`if=pflash,format=raw,file=${join(session, "OVMF_VARS.4m.fd")}`,
		"-device",
		"qemu-xhci",
		"-device",
		"usb-tablet",
		"-chardev",
		`socket,id=qmp,path=${join(session, "qmp.sock")},server=on,wait=off`,
		"-mon",
		"chardev=qmp,mode=control",
		"-serial",
		`file:${join(session, "serial.log")}`,
		"-netdev",
		"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
		"-device",
		"virtio-net-pci,netdev=n0",
		"-drive",
		`file=${join(session, "disk.qcow2")},if=virtio,format=qcow2`,
		"-cdrom",
		input.isoPath,
		"-pidfile",
		join(session, "qemu.pid"),
	];
}

export interface InstallQemuArgsInput {
	/** Session name — `-name openhammer-spike-<name>` (also the session dir basename). */
	readonly name: string;
	readonly sessionDir: string;
	readonly isoPath: string;
	readonly cidataIsoPath: string;
}

// The virtual monitor the matrix pins for both configs (spec 22 gate 6's grim reference
// resolution): EDID-forced 1280x720, so the desktop, the QMP screendump, and grim all see
// the same single mode instead of whatever QEMU's default EDID advertises. The stable
// device id lets QMP `screendump` address THIS device explicitly — under egl-headless the
// default console pick errors "no surface" (a matrix-gl finding), and naming the device
// is the documented way to select its scanout console.
const MONITOR_EDID = "edid=on,xres=1280,yres=720";
export const MATRIX_DISPLAY_DEVICE_ID = "vgpu0";

/**
 * Unattended-install argv (spec 22 gate 2): the live chassis with the headless recipe
 * FIXED (4G / virtio-vga / `-display none` — no desktop is driven during install), the
 * blank qcow2 as the install TARGET disk, the Omarchy ISO as the boot cdrom, and the
 * cidata NoCloud ISO as a read-only second virtio disk (/dev/vdb). The installer finds
 * the cidata drive by volume label — "any filesystem with the right label works", the
 * manual says — so the device type is our choice; a second virtio disk avoids the q35
 * two-`-cdrom` IDE-indexing collision ("drive with bus=2, unit=0 (index=2) exists" — a
 * 22b finding) and the implicit AHCI's unaddressable bus name. bootindex=0 on the target
 * disk encodes the manual's disk-first order (its Proxmox example: `order='scsi0;ide2'`):
 * the blank disk fails and falls through to the installer ISO on the first boot, and the
 * installed disk wins every boot after — the installer reboots by itself and must not
 * land back in the ISO. The cdrom and the cidata disk carry no bootindex, so both sort
 * after the target disk; neither can displace it once it holds a Limine ESP.
 */
export function installQemuArgs(input: InstallQemuArgsInput): string[] {
	const session = input.sessionDir;
	const recipe = DISPLAY_RECIPES.headless;
	return [
		"-name",
		`openhammer-spike-${input.name}`,
		"-machine",
		"q35",
		"-cpu",
		"host",
		"-accel",
		"kvm",
		"-smp",
		"4",
		"-m",
		recipe.memory,
		"-device",
		recipe.device,
		"-display",
		recipe.display,
		"-drive",
		`if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
		"-drive",
		`if=pflash,format=raw,file=${join(session, "OVMF_VARS.4m.fd")}`,
		"-device",
		"qemu-xhci",
		"-device",
		"usb-tablet",
		"-chardev",
		`socket,id=qmp,path=${join(session, "qmp.sock")},server=on,wait=off`,
		"-mon",
		"chardev=qmp,mode=control",
		"-serial",
		`file:${join(session, "serial.log")}`,
		"-netdev",
		"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
		"-device",
		"virtio-net-pci,netdev=n0",
		"-drive",
		`file=${join(session, "disk.qcow2")},if=none,id=hd0,format=qcow2`,
		"-device",
		"virtio-blk-pci,drive=hd0,bootindex=0",
		"-drive",
		`file=${input.cidataIsoPath},if=none,id=hd-cidata,format=raw,readonly=on`,
		"-device",
		"virtio-blk-pci,drive=hd-cidata",
		"-cdrom",
		input.isoPath,
		"-pidfile",
		join(session, "qemu.pid"),
	];
}

export interface MatrixQemuArgsInput {
	/** Session name — `-name openhammer-spike-<name>` (also the session dir basename). */
	readonly name: string;
	readonly sessionDir: string;
	readonly config: DisplayConfig;
}

/**
 * Display-matrix argv (spec 22 gate 1, desktop half): the 22a chassis under either
 * display recipe by flag, booting the INSTALLED system — the session's overlay qcow2 as
 * the only disk (virtio, bootindex=0), NO cdrom, NO cidata. The session's OVMF_VARS copy
 * (taken from the install session, which holds the Boot0004 "Limine" entry) is what makes
 * it boot; the display device carries the pinned 1280x720 EDID. Everything else — QMP
 * socket, serial-to-file (console=ttyS0 is baked into the installed kernel cmdline, so
 * serial.log carries the full boot), ephemeral hostfwd, pidfile — is identical to 22a.
 */
export function matrixQemuArgs(input: MatrixQemuArgsInput): string[] {
	const recipe = DISPLAY_RECIPES[input.config];
	const session = input.sessionDir;
	return [
		"-name",
		`openhammer-spike-${input.name}`,
		"-machine",
		"q35",
		"-cpu",
		"host",
		"-accel",
		"kvm",
		"-smp",
		"4",
		"-m",
		recipe.memory,
		"-device",
		`${recipe.device},${MONITOR_EDID},id=${MATRIX_DISPLAY_DEVICE_ID}`,
		"-display",
		recipe.display,
		"-drive",
		`if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
		"-drive",
		`if=pflash,format=raw,file=${join(session, "OVMF_VARS.4m.fd")}`,
		"-device",
		"qemu-xhci",
		"-device",
		"usb-tablet",
		"-chardev",
		`socket,id=qmp,path=${join(session, "qmp.sock")},server=on,wait=off`,
		"-mon",
		"chardev=qmp,mode=control",
		"-serial",
		`file:${join(session, "serial.log")}`,
		"-netdev",
		"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
		"-device",
		"virtio-net-pci,netdev=n0",
		"-drive",
		`file=${join(session, "disk.qcow2")},if=none,id=hd0,format=qcow2`,
		"-device",
		"virtio-blk-pci,drive=hd0,bootindex=0",
		"-pidfile",
		join(session, "qemu.pid"),
	];
}
