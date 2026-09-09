import { describe, expect, it } from "vitest";
import {
	CPUS_DEFAULT,
	DISPLAY_DEFAULT,
	DISPLAY_DEVICE_ID,
	MEMORY_DEFAULT_MB,
	MONITOR_EDID,
	OVMF_CODE,
	OVMF_VARS,
	type QemuBootSpec,
	qemuBootArgs,
} from "./args.ts";

// The two product boot shapes at their spec-22 defaults, plus an everything-overridden
// variant. Paths are plain absolute strings: the builder must treat them opaquely.
const SESSION_DIR = "/vm/sessions/s1";
const INSTALL_DIR = "/vm/sessions/i1";

const sessionSpec: QemuBootSpec = {
	name: "sandbox",
	sessionDir: SESSION_DIR,
	disks: { overlayPath: `${SESSION_DIR}/overlay.qcow2` },
};

const installSpec: QemuBootSpec = {
	name: "install-1",
	sessionDir: INSTALL_DIR,
	disks: {
		targetDiskPath: `${INSTALL_DIR}/target.qcow2`,
		isoPath: "/vm/isos/omarchy-4.0.3.iso",
		cidataIsoPath: "/vm/cidata/install-1/cidata.iso",
	},
};

const overrideSpec: QemuBootSpec = {
	name: "tuned",
	sessionDir: "/vm/sessions/t1",
	disks: { overlayPath: "/vm/golden/overlays/t1.qcow2" },
	memoryMb: 8192,
	cpus: 2,
	display: "headless",
	qemuSockPath: "/vm/custom/qmp.sock",
	serialPath: "/vm/custom/serial.log",
	pidfilePath: "/vm/custom/qemu.pid",
};

const sessionArgv = qemuBootArgs(sessionSpec);
const installArgv = qemuBootArgs(installSpec);
const overrideArgv = qemuBootArgs(overrideSpec);

describe("qemuBootArgs", () => {
	it("session boot: golden overlay, every default", () => {
		expect(sessionArgv).toEqual([
			"-name",
			"openhammer-vm-sandbox",
			"-machine",
			"q35",
			"-cpu",
			"host",
			"-accel",
			"kvm",
			"-smp",
			"4",
			"-m",
			"4096M",
			"-device",
			"virtio-vga,edid=on,xres=1280,yres=720,id=vgpu0",
			"-display",
			"none",
			"-drive",
			"if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd",
			"-drive",
			"if=pflash,format=raw,file=/vm/sessions/s1/OVMF_VARS.4m.fd",
			"-device",
			"qemu-xhci",
			"-device",
			"usb-tablet",
			"-chardev",
			"socket,id=qmp,path=/vm/sessions/s1/qmp.sock,server=on,wait=off",
			"-mon",
			"chardev=qmp,mode=control",
			"-serial",
			"file:/vm/sessions/s1/serial.log",
			"-netdev",
			"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
			"-device",
			"virtio-net-pci,netdev=n0",
			"-drive",
			"file=/vm/sessions/s1/overlay.qcow2,if=none,id=hd0,format=qcow2",
			"-device",
			"virtio-blk-pci,drive=hd0,bootindex=0",
			"-pidfile",
			"/vm/sessions/s1/qemu.pid",
		]);
	});

	it("install boot: blank target disk + ISO cdrom + read-only cidata disk", () => {
		expect(installArgv).toEqual([
			"-name",
			"openhammer-vm-install-1",
			"-machine",
			"q35",
			"-cpu",
			"host",
			"-accel",
			"kvm",
			"-smp",
			"4",
			"-m",
			"4096M",
			"-device",
			"virtio-vga,edid=on,xres=1280,yres=720,id=vgpu0",
			"-display",
			"none",
			"-drive",
			"if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd",
			"-drive",
			"if=pflash,format=raw,file=/vm/sessions/i1/OVMF_VARS.4m.fd",
			"-device",
			"qemu-xhci",
			"-device",
			"usb-tablet",
			"-chardev",
			"socket,id=qmp,path=/vm/sessions/i1/qmp.sock,server=on,wait=off",
			"-mon",
			"chardev=qmp,mode=control",
			"-serial",
			"file:/vm/sessions/i1/serial.log",
			"-netdev",
			"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
			"-device",
			"virtio-net-pci,netdev=n0",
			"-drive",
			"file=/vm/sessions/i1/target.qcow2,if=none,id=hd0,format=qcow2",
			"-device",
			"virtio-blk-pci,drive=hd0,bootindex=0",
			"-drive",
			"file=/vm/cidata/install-1/cidata.iso,if=none,id=hd-cidata,format=raw,readonly=on",
			"-device",
			"virtio-blk-pci,drive=hd-cidata",
			"-cdrom",
			"/vm/isos/omarchy-4.0.3.iso",
			"-pidfile",
			"/vm/sessions/i1/qemu.pid",
		]);
	});

	it("overrides: memory, cpus, explicit headless display, and all three path knobs", () => {
		expect(overrideArgv).toEqual([
			"-name",
			"openhammer-vm-tuned",
			"-machine",
			"q35",
			"-cpu",
			"host",
			"-accel",
			"kvm",
			"-smp",
			"2",
			"-m",
			"8192M",
			"-device",
			"virtio-vga,edid=on,xres=1280,yres=720,id=vgpu0",
			"-display",
			"none",
			"-drive",
			"if=pflash,format=raw,readonly=on,file=/usr/share/edk2/x64/OVMF_CODE.4m.fd",
			"-drive",
			"if=pflash,format=raw,file=/vm/sessions/t1/OVMF_VARS.4m.fd",
			"-device",
			"qemu-xhci",
			"-device",
			"usb-tablet",
			"-chardev",
			"socket,id=qmp,path=/vm/custom/qmp.sock,server=on,wait=off",
			"-mon",
			"chardev=qmp,mode=control",
			"-serial",
			"file:/vm/custom/serial.log",
			"-netdev",
			"user,id=n0,hostfwd=tcp:127.0.0.1:0-:22",
			"-device",
			"virtio-net-pci,netdev=n0",
			"-drive",
			"file=/vm/golden/overlays/t1.qcow2,if=none,id=hd0,format=qcow2",
			"-device",
			"virtio-blk-pci,drive=hd0,bootindex=0",
			"-pidfile",
			"/vm/custom/qemu.pid",
		]);
	});

	it("ships the spec-22 constants it defaults to", () => {
		expect(MEMORY_DEFAULT_MB).toBe(4096);
		expect(CPUS_DEFAULT).toBe(4);
		expect(OVMF_CODE).toBe("/usr/share/edk2/x64/OVMF_CODE.4m.fd");
		expect(OVMF_VARS).toBe("/usr/share/edk2/x64/OVMF_VARS.4m.fd");
		expect(MONITOR_EDID).toBe("edid=on,xres=1280,yres=720");
		expect(DISPLAY_DEFAULT).toBe("headless");
	});
});

describe("argv invariants (every boot shape)", () => {
	const allArgv = [
		["session", sessionArgv],
		["install", installArgv],
		["override", overrideArgv],
	] as const;

	it("returns an argv array — every element a non-empty string, never a shell command line", () => {
		for (const [, argv] of allArgv) {
			expect(Array.isArray(argv)).toBe(true);
			for (const arg of argv) {
				expect(typeof arg).toBe("string");
				expect(arg.length).toBeGreaterThan(0);
			}
		}
	});

	it("wires at most one cdrom — the install ISO; the session boot has none", () => {
		expect(sessionArgv.filter((arg) => arg === "-cdrom")).toEqual([]);
		expect(overrideArgv.filter((arg) => arg === "-cdrom")).toEqual([]);
		const cdromFlags = installArgv.filter((arg) => arg === "-cdrom");
		expect(cdromFlags).toEqual(["-cdrom"]);
		expect(installArgv[installArgv.indexOf("-cdrom") + 1]).toBe("/vm/isos/omarchy-4.0.3.iso");
	});

	it("the display device carries the pinned EDID and stable id, paired with -display none", () => {
		for (const [, argv] of allArgv) {
			const displayFlag = argv.indexOf("-display");
			expect(displayFlag).toBeGreaterThan(0);
			expect(argv[displayFlag + 1]).toBe("none");
			expect(argv[displayFlag - 1]).toBe(`virtio-vga,${MONITOR_EDID},id=${DISPLAY_DEVICE_ID}`);
		}
	});

	it("hostfwd is loopback-only and ephemeral — tcp:127.0.0.1:0 to guest ssh :22", () => {
		for (const [, argv] of allArgv) {
			expect(argv[argv.indexOf("-netdev") + 1]).toBe("user,id=n0,hostfwd=tcp:127.0.0.1:0-:22");
		}
	});

	it("maps OVMF CODE read-only and the per-session VARS copy writable", () => {
		// Exactly two pflash drives, in CODE-then-VARS order, in every shape.
		for (const [, argv] of allArgv) {
			expect(argv.filter((arg) => arg.startsWith("if=pflash"))).toHaveLength(2);
			expect(argv).toContain(`if=pflash,format=raw,readonly=on,file=${OVMF_CODE}`);
		}
		// Exact matches are the assertion: the VARS option string admits no readonly=on.
		expect(sessionArgv).toContain(`if=pflash,format=raw,file=${SESSION_DIR}/OVMF_VARS.4m.fd`);
		expect(installArgv).toContain(`if=pflash,format=raw,file=${INSTALL_DIR}/OVMF_VARS.4m.fd`);
		expect(overrideArgv).toContain("if=pflash,format=raw,file=/vm/sessions/t1/OVMF_VARS.4m.fd");
	});

	it("carries bootindex=0 on the boot disk only — never on the cdrom or the cidata disk", () => {
		expect(sessionArgv.filter((arg) => arg.includes("bootindex"))).toEqual(["virtio-blk-pci,drive=hd0,bootindex=0"]);
		expect(overrideArgv.filter((arg) => arg.includes("bootindex"))).toEqual(["virtio-blk-pci,drive=hd0,bootindex=0"]);
		expect(installArgv.filter((arg) => arg.includes("bootindex"))).toEqual(["virtio-blk-pci,drive=hd0,bootindex=0"]);
	});

	it("throws on an unknown display value (dev-time guard)", () => {
		// The type admits only "headless", so only an out-of-type value can reach the guard.
		// Model it the way it would really arrive — an unparsed `string` from config or a
		// future "gl" added to the union without a recipe — so the widening is the boundary
		// (the documented-exception use of `as`, not a test-only trick).
		const gl = { ...sessionSpec, display: "gl" as string } as QemuBootSpec;
		expect(() => qemuBootArgs(gl)).toThrow('unknown display config: "gl" (known: headless)');
		// Prototype-chain names must not sneak past the hasOwn lookup either.
		const junk = { ...sessionSpec, display: "constructor" as string } as QemuBootSpec;
		expect(() => qemuBootArgs(junk)).toThrow('unknown display config: "constructor"');
	});
});
