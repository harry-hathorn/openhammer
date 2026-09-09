// cidata NoCloud generator (spec 22 gate 2): the unattended-install file set the Omarchy
// installer consumes (manual 51-unattended-installs.md — "the files are exactly what the
// installer's own wizard writes"). The JSON shapes below mirror the configurator's heredocs
// from the pinned omarchy-4.0.3 ISO byte-for-key (verified against the quattro branch too):
// NO invented fields. The default is the UNENCRYPTED variant; `encrypt: true` (spec 22 gate 3)
// adds exactly the three things the configurator's own encrypt path writes — the
// `disk_config.disk_encryption` block, the `encryption_password` FIRST in
// user_credentials.json, and `user_encrypt_installation.txt` = true.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DISK_BYTES } from "./args.ts";
import { run } from "./proc.ts";
import type { SpikeDirs } from "./scratch.ts";

export const GUEST_USERNAME = "sandbox";
export const GUEST_HOSTNAME = "omarchy-sandbox";
export const GUEST_TIMEZONE = "UTC";
export const GUEST_KEYBOARD = "us";
export const GUEST_FULL_NAME = "OpenHammer Sandbox";
export const GUEST_EMAIL = "sandbox@openhammer.local";

// The virtio target disk as the guest names it (installer disk_config device path).
export const GUEST_DISK_DEVICE = "/dev/vda";

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

// Fixed partition identities from the configurator's heredoc (the encryption "partitions"
// list references the root one by this exact id — keep it stable even unencrypted).
const BOOT_PARTITION_OBJ_ID = "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d";
const ROOT_PARTITION_OBJ_ID = "8c2c2b92-1070-455d-b76a-56263bab24aa";

export interface PartitionGeometry {
	readonly bootStart: number;
	readonly bootSize: number;
	readonly mainStart: number;
	readonly mainSize: number;
}

/**
 * The configurator's partition arithmetic for a whole-disk layout: 2 GiB ESP at 1 MiB,
 * btrfs root to the last MiB minus the GPT backup reserve, sizes in bytes with 512 B
 * sector_size. Computed for the pinned blank 40G qcow2 (40 GiB exactly).
 */
export function partitionGeometry(diskBytes: number): PartitionGeometry {
	const diskSizeInMib = Math.floor(diskBytes / MIB) * MIB; // rounds to nearest MiB
	const gptBackupReserve = MIB;
	const bootStart = MIB;
	const bootSize = 2 * GIB;
	const mainStart = bootSize + bootStart;
	const mainSize = diskSizeInMib - mainStart - gptBackupReserve;
	return { bootStart, bootSize, mainStart, mainSize };
}

interface ByteSize {
	readonly sector_size: { readonly unit: "B"; readonly value: 512 };
	readonly unit: "B";
	readonly value: number;
}

function byteSize(value: number): ByteSize {
	return { sector_size: { unit: "B", value: 512 }, unit: "B", value };
}

/** The LUKS passphrase for the encrypted variant (spec 22 gate 3). */
export interface DiskEncryption {
	readonly password: string;
}

/**
 * user_configuration.json — the wizard's full-disk output with the spike's hostname,
 * timezone, and keyboard. `kernel: "linux"` is what the configurator's detect_kernel()
 * picks on QEMU (linux-t2 only matches Apple T2 PCI ids). `network_config: iso` keeps the
 * live environment's own network. No `disk_encryption` key unless `encryption` is passed:
 * the encrypted variant (the gate-3 `--encrypt` path) appends the block AFTER
 * device_modifications exactly as the configurator's heredoc does — key order included.
 */
export function userConfiguration(encryption?: DiskEncryption): Record<string, unknown> {
	const geometry = partitionGeometry(DISK_BYTES);
	const diskConfig: Record<string, unknown> = {
		config_type: "default_layout",
		device_modifications: [
			{
				device: GUEST_DISK_DEVICE,
				partitions: [
					{
						btrfs: [],
						dev_path: null,
						flags: ["boot", "esp"],
						fs_type: "fat32",
						mount_options: [],
						mountpoint: "/boot",
						obj_id: BOOT_PARTITION_OBJ_ID,
						size: byteSize(geometry.bootSize),
						start: byteSize(geometry.bootStart),
						status: "create",
						type: "primary",
					},
					{
						btrfs: [
							{ mountpoint: "/", name: "@" },
							{ mountpoint: "/home", name: "@home" },
							{ mountpoint: "/var/log", name: "@log" },
							{ mountpoint: "/var/cache/pacman/pkg", name: "@pkg" },
						],
						dev_path: null,
						flags: [],
						fs_type: "btrfs",
						mount_options: ["compress=zstd"],
						mountpoint: null,
						obj_id: ROOT_PARTITION_OBJ_ID,
						size: byteSize(geometry.mainSize),
						start: byteSize(geometry.mainStart),
						status: "create",
						type: "primary",
					},
				],
				wipe: true,
			},
		],
	};
	if (encryption !== undefined) {
		// The configurator's exact encrypted shape (verified against its heredoc + the quattro
		// branch): partitions reference the ROOT partition by obj_id (NOT `encrypted: true` flags
		// on the partition entries — the docs' shape is wrong), lvm_volumes empty, iter_time 2000.
		// The in-block encryption_password mirrors the wizard's own output; archinstall itself
		// parses the password from the TOP-LEVEL field (see userCredentials).
		diskConfig.disk_encryption = {
			encryption_type: "luks",
			lvm_volumes: [],
			iter_time: 2000,
			partitions: [ROOT_PARTITION_OBJ_ID],
			encryption_password: encryption.password,
		};
	}
	return {
		app_config: null,
		"archinstall-language": "English",
		auth_config: {},
		audio_config: { audio: "pipewire" },
		bootloader_config: { bootloader: "Limine", uki: false, removable: false },
		custom_commands: [],
		omarchy_install: {
			mode: "full_disk",
			defer_provisioning: false,
			target_mount: "/mnt",
			boot: {
				esp_mount: "/boot",
				esp_path: "/EFI/limine",
				efi_binary: "limine_x64.efi",
				enable_fallback: true,
			},
			storage: { kernel: "linux" },
		},
		disk_config: diskConfig,
		hostname: GUEST_HOSTNAME,
		kernels: ["linux"],
		network_config: { type: "iso" },
		ntp: true,
		parallel_downloads: 8,
		script: null,
		services: [],
		swap: true,
		timezone: GUEST_TIMEZONE,
		locale_config: { kb_layout: GUEST_KEYBOARD, sys_enc: "UTF-8", sys_lang: "en_US.UTF-8" },
		mirror_config: {
			custom_repositories: [],
			custom_servers: [
				{ url: "https://mirror.omarchy.org/$repo/os/$arch" },
				{ url: "https://mirror.rackspace.com/archlinux/$repo/os/$arch" },
				{ url: "https://geo.mirror.pkgbuild.com/$repo/os/$arch" },
			],
			mirror_regions: {},
			optional_repositories: [],
		},
		packages: ["base-devel", "git", "omarchy-keyring", "omarchy-settings", "omarchy"],
		profile_config: { gfx_driver: null, greeter: null, profile: {} },
		version: "3.0.9",
	};
}

/**
 * user_credentials.json — the wizard's shape: the SHA-512 crypt hash in BOTH
 * root_enc_password and users[0].enc_password (the manual's `openssl passwd -6` hash), the
 * username the installer creates. The orchestrator reads users[0].username. The encrypted
 * variant additionally leads with `encryption_password` (the wizard writes it FIRST, before
 * root_enc_password) — and it is LOAD-BEARING: archinstall's ArchConfigHandler merges the
 * creds file over the config, and ArchConfig.from_config picks the TOP-LEVEL
 * `encryption_password` as the DiskEncryption password. Without it, DiskEncryption.parse_arg
 * returns None and the disk_encryption block is silently ignored — the "encrypted" install
 * comes out plain.
 */
export function userCredentials(passwordHash: string, encryptionPassword?: string): Record<string, unknown> {
	const credentials: Record<string, unknown> = {};
	if (encryptionPassword !== undefined) {
		credentials.encryption_password = encryptionPassword;
	}
	credentials.root_enc_password = passwordHash;
	credentials.users = [
		{
			enc_password: passwordHash,
			groups: [],
			sudo: true,
			username: GUEST_USERNAME,
		},
	];
	return credentials;
}

/**
 * Hash with `openssl passwd -6` reading the password from stdin (never argv), then
 * verify by re-hashing with the same salt — a truncated stdin capture would otherwise
 * brick the only recovery path into the guest.
 */
async function sha512CryptHash(password: string): Promise<string> {
	const first = await run("openssl", ["passwd", "-6", "-stdin"], { stdin: password });
	if (first.code !== 0) {
		throw new Error(`cidata: openssl passwd exited ${first.code}: ${first.stderrTail.trim()}`);
	}
	const hash = first.stdoutTail.trim();
	// $6$<salt>$<digest> — re-hash with the extracted salt and compare.
	const salt = hash.split("$")[2];
	if (salt === undefined || !hash.startsWith("$6$")) {
		throw new Error(`cidata: openssl passwd produced a malformed hash: ${hash}`);
	}
	const check = await run("openssl", ["passwd", "-6", "-salt", salt, "-stdin"], { stdin: password });
	if (check.code !== 0 || check.stdoutTail.trim() !== hash) {
		throw new Error("cidata: password hash failed the salted re-hash verification");
	}
	return hash;
}

export interface SshKeypair {
	readonly privateKeyPath: string;
	readonly publicKey: string;
}

/**
 * Host-minted ed25519 keypair at `<SPIKE_DIR>/id_ed25519` (skipped when it already exists):
 * the .pub lands in the cidata `authorized_keys`, which is what makes the installer enable
 * sshd in the installed system (manual: "When authorized_keys is present ... enables sshd").
 */
export async function ensureSshKeypair(spikeRoot: string): Promise<SshKeypair> {
	const privateKeyPath = join(spikeRoot, "id_ed25519");
	const publicKeyPath = `${privateKeyPath}.pub`;
	if (
		statSync(privateKeyPath, { throwIfNoEntry: false }) === undefined ||
		statSync(publicKeyPath, { throwIfNoEntry: false }) === undefined
	) {
		const made = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "openhammer-spike", "-f", privateKeyPath]);
		if (made.code !== 0) {
			throw new Error(`cidata: ssh-keygen exited ${made.code}: ${made.stderrTail.trim()}`);
		}
	}
	chmodSync(privateKeyPath, 0o600);
	return { privateKeyPath, publicKey: readFileSync(publicKeyPath, "utf8").trim() };
}

export interface CidataInput {
	readonly dirs: SpikeDirs;
	/** Session name — the cidata tree and ISO are `<SPIKE_DIR>/cidata/<name>`(.iso). */
	readonly name: string;
	/** Session dir: the plaintext recovery password lands here as luks-or-sudo-password.txt. */
	readonly recoveryDir: string;
	/** Spec 22 gate 3: bake the LUKS variant. The passphrase IS the recovery password. */
	readonly encrypt: boolean;
}

export interface CidataBuild {
	readonly dir: string;
	readonly isoPath: string;
	readonly isoSize: number;
	readonly privateKeyPath: string;
	readonly publicKey: string;
	readonly recoveryPasswordPath: string;
}

/**
 * Generate the unattended set under `<SPIKE_DIR>/cidata/<name>/`, record the plaintext
 * password into the session dir (0600 — the only recovery path into the guest if ssh
 * fails), and pack the directory into `<SPIKE_DIR>/cidata/<name>.iso` with xorriso in
 * mkisofs mode: volume label `cidata` per the manual (the installer looks the drive up
 * by that label, `cidata` or `CIDATA`, via /dev/disk/by-label).
 */
export async function buildCidata(input: CidataInput): Promise<CidataBuild> {
	const dir = join(input.dirs.root, "cidata", input.name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const password = randomBytes(24).toString("base64url");
	const passwordHash = await sha512CryptHash(password);
	writeFileSync(
		join(dir, "user_configuration.json"),
		`${JSON.stringify(userConfiguration(input.encrypt ? { password } : undefined), null, 4)}\n`,
	);
	writeFileSync(
		join(dir, "user_credentials.json"),
		`${JSON.stringify(userCredentials(passwordHash, input.encrypt ? password : undefined), null, 4)}\n`,
	);
	writeFileSync(join(dir, "user_full_name.txt"), `${GUEST_FULL_NAME}\n`);
	writeFileSync(join(dir, "user_email_address.txt"), `${GUEST_EMAIL}\n`);
	// The wizard's `printf '%s\n' "$encrypt_installation"` — lowercase true/false. ctx.encrypt
	// gates the orchestrator's encrypted-install provisioning (SDDM autologin — the LUKS prompt
	// is the auth boundary — and the cryptdevice= sanity check), so the file must be true even
	// though the JSON blocks alone drive the LUKS formatting.
	writeFileSync(join(dir, "user_encrypt_installation.txt"), `${input.encrypt}\n`);

	const keypair = await ensureSshKeypair(input.dirs.root);
	writeFileSync(join(dir, "authorized_keys"), `${keypair.publicKey}\n`);

	const recoveryPasswordPath = join(input.recoveryDir, "luks-or-sudo-password.txt");
	writeFileSync(recoveryPasswordPath, `${password}\n`, { mode: 0o600 });
	chmodSync(recoveryPasswordPath, 0o600); // writeFileSync mode only applies at creation

	const isoPath = `${dir}.iso`;
	const packed = await run("xorriso", [
		"-as",
		"mkisofs",
		"-output",
		isoPath,
		"-volid",
		"cidata",
		"-joliet",
		"-rock",
		dir,
	]);
	if (packed.code !== 0) {
		throw new Error(`cidata: xorriso exited ${packed.code}: ${packed.stderrTail.trim()}`);
	}
	// The label is how the installer FINDS the drive — assert it before spending 45 min on a boot.
	const probed = await run("xorriso", ["-indev", isoPath]);
	const volumeLine = `${probed.stdoutTail}${probed.stderrTail}`.split(/\r?\n/).find((line) => /Volume id/i.test(line));
	if (volumeLine === undefined || !volumeLine.includes("'cidata'")) {
		throw new Error(`cidata: packed ISO volume id is not 'cidata': ${volumeLine ?? "no Volume id line"}`);
	}
	return {
		dir,
		isoPath,
		isoSize: statSync(isoPath).size,
		privateKeyPath: keypair.privateKeyPath,
		publicKey: keypair.publicKey,
		recoveryPasswordPath,
	};
}
