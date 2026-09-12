import { describe, expect, it } from "vitest";
import { familyFromOsRelease, hostSandboxAdvice } from "./environment.ts";

/** A fully-healthy Linux host's seams — each test overrides only what it breaks. */
function healthy(over: Parameters<typeof hostSandboxAdvice>[0] = {}): Parameters<typeof hostSandboxAdvice>[0] {
	return {
		osRelease: () => 'ID=arch\nID_LIKE=""\nNAME="Arch Linux"\n',
		procVersion: () => "Linux version 7.2.3-arch1-3 (gcc) #1 SMP PREEMPT_DYNAMIC\n",
		qemuOnPath: () => true,
		qemuImgOnPath: () => true,
		ovmfPresent: () => true,
		kvmPresent: () => true,
		kvmReadWrite: () => true,
		...over,
	};
}

describe("familyFromOsRelease", () => {
	it("maps ID directly (arch, ubuntu)", () => {
		expect(familyFromOsRelease('ID=arch\nNAME="Arch Linux"')).toBe("arch");
		expect(familyFromOsRelease('ID=ubuntu\nNAME="Ubuntu"')).toBe("debian");
	});

	it("falls back to ID_LIKE tokens when the id is unknown (centos → fedora family)", () => {
		expect(familyFromOsRelease('ID="rocky"\nID_LIKE="rhel centos fedora"')).toBe("fedora");
		expect(familyFromOsRelease("ID=manjaro\nID_LIKE=arch")).toBe("arch");
	});

	it("matches suse ids and returns unknown for a foreign release", () => {
		expect(familyFromOsRelease("ID=opensuse-leap")).toBe("suse");
		expect(familyFromOsRelease('ID=asteroidos\nNAME="AsteroidOS"')).toBe("unknown");
		expect(familyFromOsRelease("")).toBe("unknown");
	});
});

describe("hostSandboxAdvice (28k, tier 1 — read-only remedies)", () => {
	it("a healthy Linux host needs no advice", () => {
		expect(hostSandboxAdvice(healthy())).toEqual([]);
	});

	it("a non-Linux platform gets ONE honest line and no Linux command wall", () => {
		const lines = hostSandboxAdvice(healthy({ platform: "darwin" }));
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("darwin");
		expect(lines.join("\n")).not.toContain("pacman");
	});

	it("a missing qemu/ovmf stack yields the family's install command (arch)", () => {
		const lines = hostSandboxAdvice(healthy({ qemuOnPath: () => false }));
		expect(lines).toEqual(["install the VM stack — sudo pacman -S --needed qemu-desktop qemu-img edk2"]);
	});

	it("the same gap on a debian family names apt (the environment decides the advice)", () => {
		const lines = hostSandboxAdvice(
			healthy({
				osRelease: () => "ID=ubuntu\nID_LIKE=debian\n",
				ovmfPresent: () => false,
			}),
		);
		expect(lines).toEqual(["install the VM stack — sudo apt-get install -y qemu-system-x86 qemu-utils ovmf"]);
	});

	it("an unknown family degrades to a generic install line", () => {
		const lines = hostSandboxAdvice(healthy({ osRelease: () => "ID=asteroidos", qemuImgOnPath: () => false }));
		expect(lines).toEqual([
			"install the VM stack — install qemu-system-x86_64 + OVMF firmware with your distro's package manager",
		]);
	});

	it("an absent /dev/kvm is a firmware/nested-virt directive, never an install command", () => {
		const lines = hostSandboxAdvice(healthy({ kvmPresent: () => false }));
		expect(lines).toEqual([
			"/dev/kvm is absent — enable VT-x/AMD-V in your firmware (or nested virtualization if this host is itself a VM)",
		]);
	});

	it("on WSL the absent-KVM line says the honest WSL thing", () => {
		const lines = hostSandboxAdvice(
			healthy({
				kvmPresent: () => false,
				procVersion: () => "Linux version 5.15.153.1-microsoft-standard-WSL2 (buildd)",
			}),
		);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("WSL2 needs nested virtualization");
	});

	it("a kvm device you cannot write is a group-membership command", () => {
		const lines = hostSandboxAdvice(healthy({ kvmReadWrite: () => false }));
		expect(lines).toEqual([
			"/dev/kvm exists but is not writable by you — run: sudo usermod -aG kvm $USER, then log out and back in",
		]);
	});

	it("advice accumulates: a broken stack AND kvm group issues list together", () => {
		const lines = hostSandboxAdvice(healthy({ qemuOnPath: () => false, kvmReadWrite: () => false }));
		expect(lines).toHaveLength(2);
		expect(lines[0]).toContain("install the VM stack");
		expect(lines[1]).toContain("usermod");
	});
});
