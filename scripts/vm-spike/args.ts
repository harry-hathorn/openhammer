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
