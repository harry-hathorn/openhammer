// Pure QEMU argv builder — spec 24's src/vm/qemu/args.ts. Generalizes the spec-22 vm-spike's
// three proven builders (qemuArgs/installQemuArgs/matrixQemuArgs) into ONE configurable shape
// covering the product's two boot kinds: a session boot (the golden's overlay as the only
// disk) and an install boot (blank target disk + Omarchy ISO cdrom + read-only cidata disk).
// Every default is a measured spec-22 constant (specs/22-measured.md, "Chosen defaults"), and
// byte-shape parity with the spike's argv is the contract — its run logs are the evidence
// these exact flags boot, install, and screendump. Pure data in, argv out: disk and OVMF_VARS
// preparation (qemu-img create, the template copy) belongs to the session/boot layer; this
// module only points at paths the caller has already made real.

import { join } from "node:path";

/**
 * Display configuration. `"headless"` is the only product config — 22-measured gate 1: the
 * only one where QMP `screendump` works (gl/egl-headless errors "no surface" on every console
 * form), with identical Hyprland/grim outcomes, for 2 GiB less RAM. The type stays open for
 * a future `"gl"` if a reason ever appears; anything absent from the recipe table fails
 * loudly inside `qemuBootArgs` instead of emitting a half-wired display.
 */
export type DisplayConfig = "headless";

/** 22-measured "Chosen defaults": memory couples to the headless winner — desktop + grim + the omarchy agent chain measured comfortably inside 4096M (GL would need 6144M for zero readback benefit). */
export const MEMORY_DEFAULT_MB = 4096;

/** The chassis every 22-measured run booted (`-smp 4` on the 24-thread host). */
export const CPUS_DEFAULT = 4;

/** 22-measured host fact: this host's split-OVMF CODE image (edk2 x64 4m path) — mapped read-only pflash below. */
export const OVMF_CODE = "/usr/share/edk2/x64/OVMF_CODE.4m.fd";

/** The pristine VARS template the CALLER copies to `<sessionDir>/OVMF_VARS.4m.fd` per session; the builder only points the writable pflash at that copy. */
export const OVMF_VARS = "/usr/share/edk2/x64/OVMF_VARS.4m.fd";

/** 22-measured monitor pin: EDID-forced 1280x720 so the desktop, the QMP screendump, and grim all see the same single mode. */
export const MONITOR_EDID = "edid=on,xres=1280,yres=720";

/** 22-measured: the stable device id lets QMP `screendump` address this device's scanout console explicitly. */
export const DISPLAY_DEVICE_ID = "vgpu0";

/** 22-measured gate 1 winner and the only shipped recipe: `virtio-vga` + `-display none`. */
export const DISPLAY_DEFAULT: DisplayConfig = "headless";

// The display device and its `-display` value are one unit — a GL device stranded without its
// display (or virtio-vga paired with a GL display) is a wiring bug, not a config. The recipe
// table is the only way the pair enters argv, so the two can never drift apart.
interface DisplayRecipe {
	readonly device: string;
	readonly display: string;
}

const DISPLAY_RECIPES: Record<DisplayConfig, DisplayRecipe> = {
	headless: { device: "virtio-vga", display: "none" },
};

// Dev-time guard: `display` arrives typed as DisplayConfig, but the union is kept open for a
// future "gl" — an unknown or unvalidated value must fail here, before any argv exists.
// hasOwn (not `in`) so prototype-chain names like "constructor" can't sneak through either.
function displayRecipe(display: DisplayConfig): DisplayRecipe {
	if (!Object.hasOwn(DISPLAY_RECIPES, display)) {
		throw new Error(`unknown display config: "${display}" (known: ${Object.keys(DISPLAY_RECIPES).join(", ")})`);
	}
	return DISPLAY_RECIPES[display];
}

/**
 * One QEMU boot, fully described. `sessionDir` is where every per-session artifact lives
 * (the writable OVMF_VARS copy, QMP socket, serial log, pidfile); each of those has a path
 * knob so odd layouts and tests don't have to fight the defaults.
 */
export interface QemuBootSpec {
	/** Session name — `-name openhammer-vm-<name>` (also the session dir's basename). */
	readonly name: string;
	/** All per-session artifacts live here (OVMF_VARS copy, qmp.sock, serial.log, qemu.pid). */
	readonly sessionDir: string;
	/**
	 * Disk wiring: the session overlay (boot the installed system) OR the install triple
	 * (blank target disk + Omarchy ISO + cidata). Mutually exclusive boot shapes.
	 */
	readonly disks:
		| {
				/** The golden's qcow2 overlay — the only disk, bootindex=0, no cdrom. */
				readonly overlayPath: string;
		  }
		| {
				/** Install target: blank qcow2, bootindex=0 (the disk-first boot order). */
				readonly targetDiskPath: string;
				/** The Omarchy ISO as the cdrom — the fall-through boot on the first boot. */
				readonly isoPath: string;
				/** Read-only second virtio disk, volume label `cidata` — NOT a second cdrom (the q35 two-cdrom collision). */
				readonly cidataIsoPath: string;
		  };
	/** Guest RAM in MiB — default 4096, the 22-measured headless winner. */
	readonly memoryMb?: number;
	/** vCPUs — default 4. */
	readonly cpus?: number;
	/** Display config — default "headless", the only product config. */
	readonly display?: DisplayConfig;
	/** QMP unix socket path (default `<sessionDir>/qmp.sock`). */
	readonly qemuSockPath?: string;
	/** Serial-to-file path (default `<sessionDir>/serial.log`). */
	readonly serialPath?: string;
	/** pidfile path (default `<sessionDir>/qemu.pid`). */
	readonly pidfilePath?: string;
}

/**
 * Build the full QEMU argv (flags only — the binary is the spawner's concern) for either
 * product boot shape. The chassis is the 22-measured session model: q35 + host CPU + KVM,
 * split OVMF (read-only CODE, per-session writable VARS the caller already copied), the
 * headless display pair carrying the pinned 1280x720 EDID (one mode for desktop + screendump
 * + grim), qemu-xhci + usb-tablet (the absolute pointer a headless display needs), QMP
 * control monitor on a unix socket (`server=on,wait=off` — the client connects after spawn),
 * serial to a file (the installed system's console=ttyS0 lands there), slirp networking with
 * an ephemeral loopback-only ssh hostfwd (`tcp:127.0.0.1:0-:22` — the assigned port is
 * learned later via `info usernet`), and a pidfile (the stale sweep's evidence).
 */
export function qemuBootArgs(spec: QemuBootSpec): string[] {
	const recipe = displayRecipe(spec.display ?? DISPLAY_DEFAULT);
	const sessionDir = spec.sessionDir;
	return [
		"-name",
		`openhammer-vm-${spec.name}`,
		"-machine",
		"q35",
		"-cpu",
		"host",
		"-accel",
		"kvm",
		"-smp",
		String(spec.cpus ?? CPUS_DEFAULT),
		"-m",
		`${spec.memoryMb ?? MEMORY_DEFAULT_MB}M`,
		"-device",
		`${recipe.device},${MONITOR_EDID},id=${DISPLAY_DEVICE_ID}`,
		"-display",
		recipe.display,
		"-drive",
		`if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`,
		"-drive",
		// The per-session writable VARS copy (the caller copied the pristine OVMF_VARS
		// template here) — no `readonly=on` on this drive: writing it is how the install's
		// Boot entries persist and the installed Limine ESP keeps winning every boot after.
		`if=pflash,format=raw,file=${join(sessionDir, "OVMF_VARS.4m.fd")}`,
		"-device",
		"qemu-xhci",
		"-device",
		"usb-tablet",
		"-chardev",
		`socket,id=qmp,path=${spec.qemuSockPath ?? join(sessionDir, "qmp.sock")},server=on,wait=off`,
		"-mon",
		"chardev=qmp,mode=control",
		"-serial",
		`file:${spec.serialPath ?? join(sessionDir, "serial.log")}`,
		"-netdev",
		"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
		"-device",
		"virtio-net-pci,netdev=n0",
		...diskArgs(spec.disks),
		"-pidfile",
		spec.pidfilePath ?? join(sessionDir, "qemu.pid"),
	];
}

/** The disk block, per the boot shape — everything after the netdev device, before -pidfile. */
function diskArgs(disks: QemuBootSpec["disks"]): string[] {
	if ("overlayPath" in disks) {
		// Session boot (the spike's matrixQemuArgs shape): the overlay is the only disk —
		// virtio with an explicit bootindex=0 and no cdrom, since there is nothing else to boot.
		return [
			"-drive",
			`file=${disks.overlayPath},if=none,id=hd0,format=qcow2`,
			"-device",
			"virtio-blk-pci,drive=hd0,bootindex=0",
		];
	}
	// Install boot (the spike's installQemuArgs shape): the blank target disk carries the one
	// bootindex (disk-first order — the blank disk fails and falls through to the installer
	// ISO on the first boot, and the installed disk wins every self-reboot after). cidata is
	// a read-only second virtio disk found by volume label, NOT a second cdrom: q35's two
	// IDE cdroms collide ("drive with bus=2, unit=0 (index=2) exists"). The cdrom and the
	// cidata disk carry no bootindex, so both sort after the target disk.
	return [
		"-drive",
		`file=${disks.targetDiskPath},if=none,id=hd0,format=qcow2`,
		"-device",
		"virtio-blk-pci,drive=hd0,bootindex=0",
		"-drive",
		`file=${disks.cidataIsoPath},if=none,id=hd-cidata,format=raw,readonly=on`,
		"-device",
		"virtio-blk-pci,drive=hd-cidata",
		"-cdrom",
		disks.isoPath,
	];
}
