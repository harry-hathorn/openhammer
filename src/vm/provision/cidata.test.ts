import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVmDirs, type VmDirs } from "../session.ts";
import {
	buildCidata,
	type CidataDeps,
	DISK_BYTES,
	ensureSshKeypair,
	partitionGeometry,
	type RunBin,
} from "./cidata.ts";
import { type GuestConfig, normalizeGuestConfig } from "./guest-config.ts";

/** A fresh HOME per test — resolveVmDirs({homeDir}) roots the whole vm tree inside it; nothing real is touched. */
async function withTempDirs(fn: (dirs: VmDirs) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "openhammer-cidata-"));
	try {
		await fn(resolveVmDirs({ homeDir: home }));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/**
 * GuestConfig via 26a's normalize — the fixtures are literal DOCS, proving the
 * wizard-doc → normalize → generator chain the product actually runs.
 */
function configFromDoc(doc: Record<string, unknown>): GuestConfig {
	const config = normalizeGuestConfig(doc);
	if (config === null) {
		throw new Error(`fixture doc failed normalization: ${JSON.stringify(doc)}`);
	}
	return config;
}

const defaultsDoc: Record<string, unknown> = {
	hostname: "omarchy-sandbox",
	timezone: "UTC",
	keyboard: "us",
	username: "sandbox",
	gitName: "OpenHammer Sandbox",
	gitEmail: "sandbox@openhammer.local",
	encrypt: false,
	agent: "claude",
	extraPackages: [],
	bootCommands: [],
};

const encryptDoc: Record<string, unknown> = { ...defaultsDoc, encrypt: true };

const customDoc: Record<string, unknown> = {
	hostname: "build-box",
	timezone: "Europe/Berlin",
	keyboard: "de-latin1",
	username: "builder",
	gitName: "Harry Hathorn",
	gitEmail: "harry@example.invalid",
	encrypt: false,
	agent: "codex",
	// base-devel and omarchy duplicate the base set on purpose — the merge must dedupe.
	extraPackages: ["ripgrep", "fd", "base-devel", "omarchy"],
	bootCommands: ["echo provisioned"],
};

// Deterministic seam fixtures: a fixed plaintext (it lands verbatim in the encrypted
// variant's JSON, so byte-stable goldens need it fixed, not just the hash) + the box's
// example fake hash.
const FIXED_PASSWORD = "fixed-recovery-password";
const FAKE_HASH = "$6$fake$salt";

interface PackCall {
	readonly dir: string;
	readonly isoPath: string;
}

/** A recording fake pack that leaves a real file behind (buildCidata stats the ISO's size). */
function recordingPack(calls: PackCall[]): CidataDeps["pack"] {
	return async (dir, isoPath) => {
		calls.push({ dir, isoPath });
		writeFileSync(isoPath, "fake-iso");
	};
}

/** Deps with the deterministic hash/password and NO pack — callers add pack/lookupBin/runBin. */
function stableDeps(overrides: CidataDeps = {}): CidataDeps {
	return {
		hashPassword: async (password) => {
			expect(password).toBe(FIXED_PASSWORD);
			return FAKE_HASH;
		},
		randomPassword: () => FIXED_PASSWORD,
		...overrides,
	};
}

/** One recorded binary call. */
interface BinCall {
	readonly bin: string;
	readonly args: readonly string[];
}

/** A scripted RunBin: records every call, answers from `respond` (which may side-effect). */
function fakeRun(respond: (call: BinCall) => { code: number; stdout?: string; stderr?: string }): {
	run: RunBin;
	calls: BinCall[];
} {
	const calls: BinCall[] = [];
	return {
		calls,
		run: async (bin, args) => {
			const call = { bin, args: [...args] };
			calls.push(call);
			const answer = respond(call);
			return { code: answer.code, stdoutTail: answer.stdout ?? "", stderrTail: answer.stderr ?? "" };
		},
	};
}

/** The product call shape: the installer session's recovery path inside its own session dir. */
function inputFor(dirs: VmDirs, config: GuestConfig, name = "install-1") {
	return {
		config,
		dirs,
		name,
		recoveryPath: join(dirs.root, "sessions", name, "luks-or-sudo-password.txt"),
	};
}

function listFiles(root: string): string[] {
	const out: string[] = [];
	const visit = (path: string): void => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name);
			if (entry.isDirectory()) {
				visit(child);
			} else {
				out.push(child);
			}
		}
	};
	visit(root);
	return out;
}

// ---- golden snapshots (byte-exact: the wizard's own output shapes, key order included) ----
// The literals below sit at column 0 on purpose — they are the exact file bytes
// (`JSON.stringify(shape, null, 4)` + "\n"), and any indentation here would be file content.

const DEFAULTS_CONFIGURATION = `{
    "app_config": null,
    "archinstall-language": "English",
    "auth_config": {},
    "audio_config": {
        "audio": "pipewire"
    },
    "bootloader_config": {
        "bootloader": "Limine",
        "uki": false,
        "removable": false
    },
    "custom_commands": [],
    "omarchy_install": {
        "mode": "full_disk",
        "defer_provisioning": false,
        "target_mount": "/mnt",
        "boot": {
            "esp_mount": "/boot",
            "esp_path": "/EFI/limine",
            "efi_binary": "limine_x64.efi",
            "enable_fallback": true
        },
        "storage": {
            "kernel": "linux"
        }
    },
    "disk_config": {
        "config_type": "default_layout",
        "device_modifications": [
            {
                "device": "/dev/vda",
                "partitions": [
                    {
                        "btrfs": [],
                        "dev_path": null,
                        "flags": [
                            "boot",
                            "esp"
                        ],
                        "fs_type": "fat32",
                        "mount_options": [],
                        "mountpoint": "/boot",
                        "obj_id": "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2147483648
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 1048576
                        },
                        "status": "create",
                        "type": "primary"
                    },
                    {
                        "btrfs": [
                            {
                                "mountpoint": "/",
                                "name": "@"
                            },
                            {
                                "mountpoint": "/home",
                                "name": "@home"
                            },
                            {
                                "mountpoint": "/var/log",
                                "name": "@log"
                            },
                            {
                                "mountpoint": "/var/cache/pacman/pkg",
                                "name": "@pkg"
                            }
                        ],
                        "dev_path": null,
                        "flags": [],
                        "fs_type": "btrfs",
                        "mount_options": [
                            "compress=zstd"
                        ],
                        "mountpoint": null,
                        "obj_id": "8c2c2b92-1070-455d-b76a-56263bab24aa",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 40800092160
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2148532224
                        },
                        "status": "create",
                        "type": "primary"
                    }
                ],
                "wipe": true
            }
        ]
    },
    "hostname": "omarchy-sandbox",
    "kernels": [
        "linux"
    ],
    "network_config": {
        "type": "iso"
    },
    "ntp": true,
    "parallel_downloads": 8,
    "script": null,
    "services": [],
    "swap": true,
    "timezone": "UTC",
    "locale_config": {
        "kb_layout": "us",
        "sys_enc": "UTF-8",
        "sys_lang": "en_US.UTF-8"
    },
    "mirror_config": {
        "custom_repositories": [],
        "custom_servers": [
            {
                "url": "https://mirror.omarchy.org/$repo/os/$arch"
            },
            {
                "url": "https://mirror.rackspace.com/archlinux/$repo/os/$arch"
            },
            {
                "url": "https://geo.mirror.pkgbuild.com/$repo/os/$arch"
            }
        ],
        "mirror_regions": {},
        "optional_repositories": []
    },
    "packages": [
        "base-devel",
        "git",
        "omarchy-keyring",
        "omarchy-settings",
        "omarchy"
    ],
    "profile_config": {
        "gfx_driver": null,
        "greeter": null,
        "profile": {}
    },
    "version": "3.0.9"
}
`;

// DEFAULTS_CONFIGURATION + exactly the configurator's encrypt additions: the
// disk_encryption block AFTER device_modifications, root partition by obj_id.
const ENCRYPTED_CONFIGURATION = `{
    "app_config": null,
    "archinstall-language": "English",
    "auth_config": {},
    "audio_config": {
        "audio": "pipewire"
    },
    "bootloader_config": {
        "bootloader": "Limine",
        "uki": false,
        "removable": false
    },
    "custom_commands": [],
    "omarchy_install": {
        "mode": "full_disk",
        "defer_provisioning": false,
        "target_mount": "/mnt",
        "boot": {
            "esp_mount": "/boot",
            "esp_path": "/EFI/limine",
            "efi_binary": "limine_x64.efi",
            "enable_fallback": true
        },
        "storage": {
            "kernel": "linux"
        }
    },
    "disk_config": {
        "config_type": "default_layout",
        "device_modifications": [
            {
                "device": "/dev/vda",
                "partitions": [
                    {
                        "btrfs": [],
                        "dev_path": null,
                        "flags": [
                            "boot",
                            "esp"
                        ],
                        "fs_type": "fat32",
                        "mount_options": [],
                        "mountpoint": "/boot",
                        "obj_id": "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2147483648
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 1048576
                        },
                        "status": "create",
                        "type": "primary"
                    },
                    {
                        "btrfs": [
                            {
                                "mountpoint": "/",
                                "name": "@"
                            },
                            {
                                "mountpoint": "/home",
                                "name": "@home"
                            },
                            {
                                "mountpoint": "/var/log",
                                "name": "@log"
                            },
                            {
                                "mountpoint": "/var/cache/pacman/pkg",
                                "name": "@pkg"
                            }
                        ],
                        "dev_path": null,
                        "flags": [],
                        "fs_type": "btrfs",
                        "mount_options": [
                            "compress=zstd"
                        ],
                        "mountpoint": null,
                        "obj_id": "8c2c2b92-1070-455d-b76a-56263bab24aa",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 40800092160
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2148532224
                        },
                        "status": "create",
                        "type": "primary"
                    }
                ],
                "wipe": true
            }
        ],
        "disk_encryption": {
            "encryption_type": "luks",
            "lvm_volumes": [],
            "iter_time": 2000,
            "partitions": [
                "8c2c2b92-1070-455d-b76a-56263bab24aa"
            ],
            "encryption_password": "fixed-recovery-password"
        }
    },
    "hostname": "omarchy-sandbox",
    "kernels": [
        "linux"
    ],
    "network_config": {
        "type": "iso"
    },
    "ntp": true,
    "parallel_downloads": 8,
    "script": null,
    "services": [],
    "swap": true,
    "timezone": "UTC",
    "locale_config": {
        "kb_layout": "us",
        "sys_enc": "UTF-8",
        "sys_lang": "en_US.UTF-8"
    },
    "mirror_config": {
        "custom_repositories": [],
        "custom_servers": [
            {
                "url": "https://mirror.omarchy.org/$repo/os/$arch"
            },
            {
                "url": "https://mirror.rackspace.com/archlinux/$repo/os/$arch"
            },
            {
                "url": "https://geo.mirror.pkgbuild.com/$repo/os/$arch"
            }
        ],
        "mirror_regions": {},
        "optional_repositories": []
    },
    "packages": [
        "base-devel",
        "git",
        "omarchy-keyring",
        "omarchy-settings",
        "omarchy"
    ],
    "profile_config": {
        "gfx_driver": null,
        "greeter": null,
        "profile": {}
    },
    "version": "3.0.9"
}
`;

// DEFAULTS_CONFIGURATION with the custom fields swapped in and extraPackages merged:
// base always present, deduped (base-devel/omarchy from extras collapse), order preserved.
const CUSTOM_CONFIGURATION = `{
    "app_config": null,
    "archinstall-language": "English",
    "auth_config": {},
    "audio_config": {
        "audio": "pipewire"
    },
    "bootloader_config": {
        "bootloader": "Limine",
        "uki": false,
        "removable": false
    },
    "custom_commands": [],
    "omarchy_install": {
        "mode": "full_disk",
        "defer_provisioning": false,
        "target_mount": "/mnt",
        "boot": {
            "esp_mount": "/boot",
            "esp_path": "/EFI/limine",
            "efi_binary": "limine_x64.efi",
            "enable_fallback": true
        },
        "storage": {
            "kernel": "linux"
        }
    },
    "disk_config": {
        "config_type": "default_layout",
        "device_modifications": [
            {
                "device": "/dev/vda",
                "partitions": [
                    {
                        "btrfs": [],
                        "dev_path": null,
                        "flags": [
                            "boot",
                            "esp"
                        ],
                        "fs_type": "fat32",
                        "mount_options": [],
                        "mountpoint": "/boot",
                        "obj_id": "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2147483648
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 1048576
                        },
                        "status": "create",
                        "type": "primary"
                    },
                    {
                        "btrfs": [
                            {
                                "mountpoint": "/",
                                "name": "@"
                            },
                            {
                                "mountpoint": "/home",
                                "name": "@home"
                            },
                            {
                                "mountpoint": "/var/log",
                                "name": "@log"
                            },
                            {
                                "mountpoint": "/var/cache/pacman/pkg",
                                "name": "@pkg"
                            }
                        ],
                        "dev_path": null,
                        "flags": [],
                        "fs_type": "btrfs",
                        "mount_options": [
                            "compress=zstd"
                        ],
                        "mountpoint": null,
                        "obj_id": "8c2c2b92-1070-455d-b76a-56263bab24aa",
                        "size": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 40800092160
                        },
                        "start": {
                            "sector_size": {
                                "unit": "B",
                                "value": 512
                            },
                            "unit": "B",
                            "value": 2148532224
                        },
                        "status": "create",
                        "type": "primary"
                    }
                ],
                "wipe": true
            }
        ]
    },
    "hostname": "build-box",
    "kernels": [
        "linux"
    ],
    "network_config": {
        "type": "iso"
    },
    "ntp": true,
    "parallel_downloads": 8,
    "script": null,
    "services": [],
    "swap": true,
    "timezone": "Europe/Berlin",
    "locale_config": {
        "kb_layout": "de-latin1",
        "sys_enc": "UTF-8",
        "sys_lang": "en_US.UTF-8"
    },
    "mirror_config": {
        "custom_repositories": [],
        "custom_servers": [
            {
                "url": "https://mirror.omarchy.org/$repo/os/$arch"
            },
            {
                "url": "https://mirror.rackspace.com/archlinux/$repo/os/$arch"
            },
            {
                "url": "https://geo.mirror.pkgbuild.com/$repo/os/$arch"
            }
        ],
        "mirror_regions": {},
        "optional_repositories": []
    },
    "packages": [
        "base-devel",
        "git",
        "omarchy-keyring",
        "omarchy-settings",
        "omarchy",
        "ripgrep",
        "fd"
    ],
    "profile_config": {
        "gfx_driver": null,
        "greeter": null,
        "profile": {}
    },
    "version": "3.0.9"
}
`;

const DEFAULTS_CREDENTIALS = `{
    "root_enc_password": "$6$fake$salt",
    "users": [
        {
            "enc_password": "$6$fake$salt",
            "groups": [],
            "sudo": true,
            "username": "sandbox"
        }
    ]
}
`;

// 22d's load-bearing correction: encryption_password TOP-LEVEL and FIRST.
const ENCRYPTED_CREDENTIALS = `{
    "encryption_password": "fixed-recovery-password",
    "root_enc_password": "$6$fake$salt",
    "users": [
        {
            "enc_password": "$6$fake$salt",
            "groups": [],
            "sudo": true,
            "username": "sandbox"
        }
    ]
}
`;

describe("partitionGeometry", () => {
	it("computes the configurator's whole-disk layout for the pinned 40 GiB blank", () => {
		expect(DISK_BYTES).toBe(40 * 1024 * 1024 * 1024); // == qemu-img's binary "40G"
		expect(partitionGeometry(DISK_BYTES)).toEqual({
			bootStart: 1048576, // 1 MiB
			bootSize: 2147483648, // 2 GiB ESP
			mainStart: 2148532224, // 1 MiB + 2 GiB
			mainSize: 40800092160, // rest of 40 GiB minus the GPT backup MiB
		});
	});
});

describe("ensureSshKeypair", () => {
	it("mints an ed25519 pair at <root>/id_ed25519, private 0600 (real ssh-keygen)", async () => {
		await withTempDirs(async (dirs) => {
			mkdirSync(dirs.root, { recursive: true });
			const pair = await ensureSshKeypair(dirs.root);
			expect(pair.privateKeyPath).toBe(join(dirs.root, "id_ed25519"));
			expect(mode(pair.privateKeyPath)).toBe(0o600);
			expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAA[0-9A-Za-z+/]+={0,2} openhammer-vm$/);
			expect(readFileSync(`${pair.privateKeyPath}.pub`, "utf8").trim()).toBe(pair.publicKey);
		});
	});

	it("skips generation when both halves exist, re-asserting 0600", async () => {
		await withTempDirs(async (dirs) => {
			mkdirSync(dirs.root, { recursive: true });
			const first = await ensureSshKeypair(dirs.root);
			// Sentinel private key: a second ssh-keygen run would refuse/replace it.
			writeFileSync(first.privateKeyPath, "sentinel-private-key\n");
			chmodSync(first.privateKeyPath, 0o644);
			const second = await ensureSshKeypair(dirs.root);
			expect(readFileSync(second.privateKeyPath, "utf8")).toBe("sentinel-private-key\n");
			expect(mode(second.privateKeyPath)).toBe(0o600);
			expect(second.publicKey).toBe(first.publicKey);
		});
	});
});

describe("buildCidata — the golden file set", () => {
	it("defaults, unencrypted: user_configuration.json is the wizard's exact shape (no disk_encryption)", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			expect(readFileSync(join(build.dir, "user_configuration.json"), "utf8")).toBe(DEFAULTS_CONFIGURATION);
		});
	});

	it("encrypt: true: appends the disk_encryption block after device_modifications, root by obj_id", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(encryptDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			expect(readFileSync(join(build.dir, "user_configuration.json"), "utf8")).toBe(ENCRYPTED_CONFIGURATION);
			// The block order inside disk_config: device_modifications, then disk_encryption.
			const parsed = JSON.parse(readFileSync(join(build.dir, "user_configuration.json"), "utf8")) as Record<
				string,
				unknown
			>;
			const diskConfig = parsed.disk_config as Record<string, unknown>;
			expect(Object.keys(diskConfig)).toEqual(["config_type", "device_modifications", "disk_encryption"]);
			expect(readFileSync(join(build.dir, "user_encrypt_installation.txt"), "utf8")).toBe("true\n");
		});
	});

	it("custom fields + extraPackages: every field swapped in, packages merged and deduped", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(customDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			expect(readFileSync(join(build.dir, "user_configuration.json"), "utf8")).toBe(CUSTOM_CONFIGURATION);
			const parsed = JSON.parse(readFileSync(join(build.dir, "user_configuration.json"), "utf8")) as Record<
				string,
				unknown
			>;
			expect(parsed.packages).toEqual([
				"base-devel",
				"git",
				"omarchy-keyring",
				"omarchy-settings",
				"omarchy",
				"ripgrep",
				"fd",
			]);
			expect(readFileSync(join(build.dir, "user_full_name.txt"), "utf8")).toBe("Harry Hathorn\n");
			expect(readFileSync(join(build.dir, "user_email_address.txt"), "utf8")).toBe("harry@example.invalid\n");
		});
	});

	it("user_credentials.json: hash in both slots, username from config (unencrypted variant)", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(customDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			const text = readFileSync(join(build.dir, "user_credentials.json"), "utf8");
			expect(text).toBe(DEFAULTS_CREDENTIALS.replace('"username": "sandbox"', '"username": "builder"'));
			const parsed = JSON.parse(text) as Record<string, unknown>;
			expect(Object.keys(parsed)).toEqual(["root_enc_password", "users"]); // no encryption_password key
		});
	});

	it("user_credentials.json: encryption_password TOP-LEVEL and FIRST when encrypt (22d)", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(encryptDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			const text = readFileSync(join(build.dir, "user_credentials.json"), "utf8");
			expect(text).toBe(ENCRYPTED_CREDENTIALS);
			expect(Object.keys(JSON.parse(text) as Record<string, unknown>)[0]).toBe("encryption_password");
		});
	});

	it("writes the txt files (git identity, encrypt flag)", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			expect(readFileSync(join(build.dir, "user_full_name.txt"), "utf8")).toBe("OpenHammer Sandbox\n");
			expect(readFileSync(join(build.dir, "user_email_address.txt"), "utf8")).toBe("sandbox@openhammer.local\n");
			expect(readFileSync(join(build.dir, "user_encrypt_installation.txt"), "utf8")).toBe("false\n");
		});
	});

	it("falls back to the sandbox placeholders for an explicitly-empty git identity", async () => {
		await withTempDirs(async (dirs) => {
			const doc = { ...defaultsDoc, gitName: "", gitEmail: "" };
			const build = await buildCidata(inputFor(dirs, configFromDoc(doc)), stableDeps({ pack: recordingPack([]) }));
			expect(readFileSync(join(build.dir, "user_full_name.txt"), "utf8")).toBe("OpenHammer Sandbox\n");
			expect(readFileSync(join(build.dir, "user_email_address.txt"), "utf8")).toBe("sandbox@openhammer.local\n");
		});
	});

	it("authorized_keys is the host-minted pubkey, one line", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ pack: recordingPack([]) }),
			);
			expect(readFileSync(join(build.dir, "authorized_keys"), "utf8")).toBe(`${build.publicKey}\n`);
			expect(build.privateKeyPath).toBe(join(dirs.root, "id_ed25519"));
			expect(mode(build.privateKeyPath)).toBe(0o600);
		});
	});

	it("records the password ONLY at recoveryPath (0600) — no other host-side copy", async () => {
		await withTempDirs(async (dirs) => {
			const input = inputFor(dirs, configFromDoc(defaultsDoc));
			const build = await buildCidata(input, stableDeps({ pack: recordingPack([]) }));
			expect(build.recoveryPasswordPath).toBe(input.recoveryPath);
			expect(readFileSync(input.recoveryPath, "utf8")).toBe(`${FIXED_PASSWORD}\n`);
			expect(mode(input.recoveryPath)).toBe(0o600);
			// The dir holds exactly the six installer files — the plaintext is not among them.
			expect(readdirSync(build.dir).sort()).toEqual([
				"authorized_keys",
				"user_configuration.json",
				"user_credentials.json",
				"user_email_address.txt",
				"user_encrypt_installation.txt",
				"user_full_name.txt",
			]);
			// And nowhere else in the whole vm tree either.
			const carriers = listFiles(dirs.root).filter((f) => readFileSync(f, "utf8").includes(FIXED_PASSWORD));
			expect(carriers).toEqual([input.recoveryPath]);
		});
	});

	it("returns the build paths: 0700 cidata dir under <root>/cidata/<name>, ISO beside it", async () => {
		await withTempDirs(async (dirs) => {
			const calls: PackCall[] = [];
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ pack: recordingPack(calls) }),
			);
			expect(build.dir).toBe(join(dirs.cidata, "install-1"));
			expect(mode(build.dir)).toBe(0o700);
			expect(build.isoPath).toBe(`${join(dirs.cidata, "install-1")}.iso`);
			expect(calls).toEqual([{ dir: build.dir, isoPath: build.isoPath }]);
			expect(build.isoSize).toBe("fake-iso".length);
		});
	});

	it("rejects a build name that is not a safe path segment", async () => {
		await withTempDirs(async (dirs) => {
			await expect(
				buildCidata(
					inputFor(dirs, configFromDoc(defaultsDoc), "../escape"),
					stableDeps({ pack: recordingPack([]) }),
				),
			).rejects.toThrow("cidata: build name is not a safe path segment");
		});
	});
});

describe("default hashPassword (the openssl seam)", () => {
	// The ONE real-openssl round: no hashPassword injection — the default runs, and the
	// written hash is re-derived from the recovery password with the extracted salt.
	it("hashes via openssl passwd -6 and the salt verifies (real openssl)", async () => {
		await withTempDirs(async (dirs) => {
			const build = await buildCidata(inputFor(dirs, configFromDoc(defaultsDoc)), {
				randomPassword: () => FIXED_PASSWORD,
				pack: recordingPack([]),
			});
			const creds = JSON.parse(readFileSync(join(build.dir, "user_credentials.json"), "utf8")) as {
				root_enc_password: string;
				users: Array<{ enc_password: string }>;
			};
			const hash = creds.users[0]?.enc_password ?? "";
			expect(hash.startsWith("$6$")).toBe(true);
			expect(creds.root_enc_password).toBe(hash);
			const salt = hash.split("$")[2] ?? "";
			const recheck = spawnSync("openssl", ["passwd", "-6", "-salt", salt, "-stdin"], { input: FIXED_PASSWORD });
			expect(recheck.status).toBe(0);
			expect(`${recheck.stdout ?? ""}`.trim()).toBe(hash);
		});
	});

	it("throws when openssl exits non-zero", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun(() => ({ code: 1, stderr: "openssl: Error hitting" }));
			await expect(
				buildCidata(inputFor(dirs, configFromDoc(defaultsDoc)), {
					randomPassword: () => FIXED_PASSWORD,
					pack: recordingPack([]),
					runBin: runner.run,
				}),
			).rejects.toThrow("cidata: openssl passwd exited 1: openssl: Error hitting");
		});
	});

	it("throws on a malformed hash", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun(() => ({ code: 0, stdout: "garbage" }));
			await expect(
				buildCidata(inputFor(dirs, configFromDoc(defaultsDoc)), {
					randomPassword: () => FIXED_PASSWORD,
					pack: recordingPack([]),
					runBin: runner.run,
				}),
			).rejects.toThrow("cidata: openssl passwd produced a malformed hash: garbage");
		});
	});

	it("throws when the salted re-hash disagrees", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun((call) =>
				call.args.includes("-salt")
					? { code: 0, stdout: "$6$abc$different" }
					: { code: 0, stdout: "$6$abc$digest" },
			);
			await expect(
				buildCidata(inputFor(dirs, configFromDoc(defaultsDoc)), {
					randomPassword: () => FIXED_PASSWORD,
					pack: recordingPack([]),
					runBin: runner.run,
				}),
			).rejects.toThrow("cidata: password hash failed the salted re-hash verification");
		});
	});
});

describe("default pack (genisoimage/xorriso preflight)", () => {
	it("absent both → the actionable error naming the packages (no silent fallback)", async () => {
		await withTempDirs(async (dirs) => {
			await expect(
				buildCidata(inputFor(dirs, configFromDoc(defaultsDoc)), stableDeps({ lookupBin: () => false })),
			).rejects.toThrow("cidata packing needs genisoimage or xorriso (Arch: sudo pacman -S cdrkit or xorriso)");
		});
	});

	it("prefers genisoimage: direct mkisofs flags (no -as wrapper), probed via isoinfo", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun((call) => {
				if (call.bin === "genisoimage") {
					writeFileSync(call.args[call.args.indexOf("-output") + 1] ?? "/dev/null", "iso");
					return { code: 0 };
				}
				if (call.bin === "isoinfo") return { code: 0, stderr: "CD-ROM is in ISO 9660 format\nVolume id: cidata\n" };
				return { code: 1, stderr: `unexpected bin ${call.bin}` };
			});
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ lookupBin: (bin) => bin === "genisoimage" || bin === "isoinfo", runBin: runner.run }),
			);
			expect(runner.calls).toEqual([
				{ bin: "genisoimage", args: ["-output", build.isoPath, "-volid", "cidata", "-joliet", "-rock", build.dir] },
				{ bin: "isoinfo", args: ["-d", "-i", build.isoPath] },
			]);
			expect(build.isoSize).toBe(3);
		});
	});

	it("falls back to xorriso: -as mkisofs wrapper, probed via xorriso -indev", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun((call) => {
				if (call.bin === "xorriso" && call.args.includes("-as")) {
					writeFileSync(call.args[call.args.indexOf("-output") + 1] ?? "/dev/null", "iso");
					return { code: 0 };
				}
				if (call.bin === "xorriso") return { code: 0, stderr: "Volume id    : 'cidata'\n" };
				return { code: 1, stderr: `unexpected bin ${call.bin}` };
			});
			const build = await buildCidata(
				inputFor(dirs, configFromDoc(defaultsDoc)),
				stableDeps({ lookupBin: (bin) => bin === "xorriso", runBin: runner.run }),
			);
			expect(runner.calls).toEqual([
				{
					bin: "xorriso",
					args: ["-as", "mkisofs", "-output", build.isoPath, "-volid", "cidata", "-joliet", "-rock", build.dir],
				},
				{ bin: "xorriso", args: ["-indev", build.isoPath] },
			]);
		});
	});

	it("throws when the packed volume id is wrong", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun((call) => {
				if (call.bin === "xorriso" && call.args.includes("-as")) {
					writeFileSync(call.args[call.args.indexOf("-output") + 1] ?? "/dev/null", "iso");
					return { code: 0 };
				}
				return { code: 0, stderr: "Volume id    : 'wrong-label'\n" };
			});
			await expect(
				buildCidata(
					inputFor(dirs, configFromDoc(defaultsDoc)),
					stableDeps({ lookupBin: (bin) => bin === "xorriso", runBin: runner.run }),
				),
			).rejects.toThrow("cidata: packed ISO volume id is not 'cidata': Volume id    : 'wrong-label'");
		});
	});

	it("throws when the probe prints no Volume id line at all", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun((call) => {
				if (call.bin === "xorriso" && call.args.includes("-as")) {
					writeFileSync(call.args[call.args.indexOf("-output") + 1] ?? "/dev/null", "iso");
					return { code: 0 };
				}
				return { code: 0, stderr: "nothing recognizable\n" };
			});
			await expect(
				buildCidata(
					inputFor(dirs, configFromDoc(defaultsDoc)),
					stableDeps({ lookupBin: (bin) => bin === "xorriso", runBin: runner.run }),
				),
			).rejects.toThrow("no Volume id line");
		});
	});

	it("throws when the packing tool itself fails (stderr tail embedded)", async () => {
		await withTempDirs(async (dirs) => {
			const runner = fakeRun(() => ({ code: 2, stderr: "genisoimage: No such file or directory" }));
			await expect(
				buildCidata(
					inputFor(dirs, configFromDoc(defaultsDoc)),
					stableDeps({ lookupBin: (bin) => bin === "genisoimage", runBin: runner.run }),
				),
			).rejects.toThrow("cidata: genisoimage exited 2: genisoimage: No such file or directory");
		});
	});

	it("throws when neither prober is available to verify the label", async () => {
		await withTempDirs(async (dirs) => {
			// genisoimage present, xorriso absent, isoinfo (its cdrkit sibling) also absent.
			const runner = fakeRun((call) => {
				if (call.bin === "genisoimage") {
					writeFileSync(call.args[call.args.indexOf("-output") + 1] ?? "/dev/null", "iso");
					return { code: 0 };
				}
				return { code: 1 };
			});
			await expect(
				buildCidata(
					inputFor(dirs, configFromDoc(defaultsDoc)),
					stableDeps({ lookupBin: (bin) => bin === "genisoimage", runBin: runner.run }),
				),
			).rejects.toThrow("cidata: cannot verify the packed volume id — needs xorriso or isoinfo (cdrkit)");
		});
	});
});
