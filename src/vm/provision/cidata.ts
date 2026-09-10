/**
 * The cidata NoCloud generator (spec 26): the unattended-install file set the Omarchy
 * installer consumes (manual 51-unattended-installs.md — "the files are exactly what the
 * installer's own wizard writes"), promoted from scripts/vm-spike/cidata.ts — the code that
 * built the two real goldens (22-measured gates 2/3). The JSON shapes mirror the
 * configurator's heredocs from the pinned omarchy-4.0.3 ISO byte-for-key (verified against
 * the quattro branch too): NO invented fields, wizard key order included.
 *
 * The 22d corrections are load-bearing and promoted verbatim (22-measured finding 8): the
 * encrypted variant's `disk_config.disk_encryption` block references the ROOT partition by
 * its stable obj_id (NOT per-partition `encrypted` flags — the docs' shape is wrong) and is
 * appended AFTER device_modifications exactly as the configurator's heredoc does; and
 * `encryption_password` sits TOP-LEVEL and FIRST in user_credentials.json — archinstall
 * merges the creds file over the config and reads the top-level field; without it the whole
 * encryption block is SILENTLY ignored and the "encrypted" install comes out plain.
 *
 * The default is the UNENCRYPTED variant (resolved open question 11): no `disk_encryption`
 * key at all → fully unattended, no LUKS, boots straight to sshd. `encrypt: true` carries
 * the manual's caveat — cidata holds the passphrase in plaintext — and engages spec 24's
 * unlock chain.
 *
 * Packing (22-measured finding 7): the ISO is attached as a read-only second virtio disk,
 * found by VOLUME LABEL `cidata` via /dev/disk/by-label. The packed ISO's volume id is
 * asserted before anyone boots it — a mislabeled ISO must fail here, not 45 minutes into
 * an install. Tool resolution (spec 26 edge case — no silent fallback): genisoimage first,
 * xorriso fallback, ABSENT BOTH → the preflight error names the packages. genisoimage IS
 * mkisofs (cdrkit's fork — direct `-output/-volid/…` flags); xorriso needs the `-as mkisofs`
 * emulation wrapper — argv is built per tool below.
 *
 * Error model: process layer, not a tool — failures THROW with the child's stderr tail (the
 * session.ts / qemu/process.ts posture); spec 26c's install runner is the boundary that
 * folds these into the Result spine. The generated password is recorded on the HOST only to
 * the caller-provided recoveryPath (0600) — the one recovery path into the guest if ssh
 * fails. The cidata files themselves carry only the hash, except the encrypted variant's
 * plaintext passphrase, which is how the installer learns it (the manual's caveat).
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isToolAvailable } from "../../tools/bin.ts";
import type { VmDirs } from "../session.ts";
import type { GuestConfig } from "./guest-config.ts";

// ---- the pinned blank disk (the partition geometry's contract) ----

const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

/**
 * The blank qcow2 the installer partitions — 40 GiB exactly (qemu-img size suffixes are
 * binary, so `40G` == this constant; spec 26c's install runner must create its blank disk
 * with this size or the geometry below describes the wrong disk).
 */
export const DISK_BYTES = 40 * GIB;

export interface PartitionGeometry {
	readonly bootStart: number;
	readonly bootSize: number;
	readonly mainStart: number;
	readonly mainSize: number;
}

/**
 * The configurator's partition arithmetic for a whole-disk layout: 2 GiB ESP at 1 MiB,
 * btrfs root to the last MiB minus the GPT backup reserve, sizes in bytes with 512 B
 * sector_size. Computed for the pinned blank 40G qcow2 (promoted verbatim from the spike —
 * the shape the two real goldens installed with).
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

/** The virtio target disk as the guest names it (the installer's disk_config device path). */
const GUEST_DISK_DEVICE = "/dev/vda";

// Fixed partition identities from the configurator's heredoc (the encryption "partitions"
// list references the root one by this exact id — keep them stable even unencrypted).
const BOOT_PARTITION_OBJ_ID = "ea21d3f2-82bb-49cc-ab5d-6f81ae94e18d";
const ROOT_PARTITION_OBJ_ID = "8c2c2b92-1070-455d-b76a-56263bab24aa";

interface ByteSize {
	readonly sector_size: { readonly unit: "B"; readonly value: 512 };
	readonly unit: "B";
	readonly value: number;
}

function byteSize(value: number): ByteSize {
	return { sector_size: { unit: "B", value: 512 }, unit: "B", value };
}

// ---- the wizard's JSON shapes (byte-for-key — the golden tests pin them) ----

/** The configurator's own package set — `extraPackages` merge on top of these, never replace. */
const BASE_PACKAGES = ["base-devel", "git", "omarchy-keyring", "omarchy-settings", "omarchy"] as const;

/** Base packages first, then the extras in config order — deduped, first occurrence wins. */
function mergePackages(extra: readonly string[]): string[] {
	const seen = new Set<string>();
	const packages: string[] = [];
	for (const pkg of [...BASE_PACKAGES, ...extra]) {
		if (!seen.has(pkg)) {
			seen.add(pkg);
			packages.push(pkg);
		}
	}
	return packages;
}

/**
 * user_configuration.json — the wizard's full-disk output with the GuestConfig's hostname,
 * timezone, and keyboard. `kernel: "linux"` is what the configurator's detect_kernel()
 * picks on QEMU (linux-t2 only matches Apple T2 PCI ids). `network_config: iso` keeps the
 * live environment's own network. NO `disk_encryption` key unless `password` is passed
 * (encrypt: true): the encrypted variant appends the block AFTER device_modifications
 * exactly as the configurator's heredoc does — key order included.
 */
function userConfiguration(config: GuestConfig, password: string | undefined): Record<string, unknown> {
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
	if (password !== undefined) {
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
			encryption_password: password,
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
		hostname: config.hostname,
		kernels: ["linux"],
		network_config: { type: "iso" },
		ntp: true,
		parallel_downloads: 8,
		script: null,
		services: [],
		swap: true,
		timezone: config.timezone,
		locale_config: { kb_layout: config.keyboard, sys_enc: "UTF-8", sys_lang: "en_US.UTF-8" },
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
		packages: mergePackages(config.extraPackages),
		profile_config: { gfx_driver: null, greeter: null, profile: {} },
		version: "3.0.9",
	};
}

/**
 * user_credentials.json — the wizard's shape: the SHA-512 crypt hash in BOTH
 * root_enc_password and users[0].enc_password (the manual's `openssl passwd -6` hash), the
 * username the installer creates. The encrypted variant additionally leads with
 * `encryption_password` (the wizard writes it FIRST, before root_enc_password) — and it is
 * LOAD-BEARING: archinstall's ArchConfigHandler merges the creds file over the config, and
 * ArchConfig.from_config picks the TOP-LEVEL `encryption_password` as the DiskEncryption
 * password. Without it, DiskEncryption.parse_arg returns None and the disk_encryption block
 * is silently ignored — the "encrypted" install comes out plain.
 */
function userCredentials(
	passwordHash: string,
	username: string,
	encryptionPassword: string | undefined,
): Record<string, unknown> {
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
			username,
		},
	];
	return credentials;
}

// The sandbox placeholders for an unset git identity (defaultGuestConfig ships them filled;
// only an explicitly-empty saved doc falls back to these).
const FULL_NAME_PLACEHOLDER = "OpenHammer Sandbox";
const EMAIL_PLACEHOLDER = "sandbox@openhammer.local";

function fullNameOf(config: GuestConfig): string {
	return config.gitName.length > 0 ? config.gitName : FULL_NAME_PLACEHOLDER;
}

function emailAddressOf(config: GuestConfig): string {
	return config.gitEmail.length > 0 ? config.gitEmail : EMAIL_PLACEHOLDER;
}

// ---- the host-minted keypair ----

export interface SshKeypair {
	readonly privateKeyPath: string;
	readonly publicKey: string;
}

/**
 * Host-minted ed25519 keypair at `<vm root>/id_ed25519` (skipped when both halves already
 * exist; the private half is chmod'd 0600 on every call — a mode only applies at creation):
 * the .pub lands in the cidata `authorized_keys`, which is what makes the installer enable
 * sshd in the installed system (manual: "When authorized_keys is present ... enables sshd").
 * A half-broken pair (one file missing) re-runs ssh-keygen, which REFUSES to clobber the
 * existing half and fails loudly — the private key is the only way into every golden ever
 * built with it; it is never silently discarded.
 */
export async function ensureSshKeypair(root: string): Promise<SshKeypair> {
	const privateKeyPath = join(root, "id_ed25519");
	const publicKeyPath = `${privateKeyPath}.pub`;
	if (
		statSync(privateKeyPath, { throwIfNoEntry: false }) === undefined ||
		statSync(publicKeyPath, { throwIfNoEntry: false }) === undefined
	) {
		const made = await run("ssh-keygen", ["-t", "ed25519", "-N", "", "-C", "openhammer-vm", "-f", privateKeyPath]);
		if (made.code !== 0) {
			throw new Error(`cidata: ssh-keygen exited ${made.code ?? "spawn error"}: ${made.stderrTail.trim()}`);
		}
	}
	chmodSync(privateKeyPath, 0o600);
	return { privateKeyPath, publicKey: readFileSync(publicKeyPath, "utf8").trim() };
}

// ---- the binary seam ----

/** The spawn runner's result — the spike's proc.ts `run`/ShellResult shape: code + 4 KiB tails. */
export interface BinRunResult {
	readonly code: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
}

/** Spawn `bin args` (arg array in — never a shell string), optionally piping `stdin` then EOF. */
export type RunBin = (
	bin: string,
	args: readonly string[],
	options?: { readonly stdin?: string },
) => Promise<BinRunResult>;

const TAIL_BYTES = 4096;

/**
 * The spike's proc.ts `run`, promoted verbatim: keep the last 4 KiB of stdout+stderr, await
 * exit; a spawn failure (ENOENT) resolves with `code: null` and the error in the tail —
 * callers check the code and throw with the tail.
 */
const run: RunBin = (bin, args, options = {}): Promise<BinRunResult> =>
	new Promise<BinRunResult>((resolveRun) => {
		const child = spawn(bin, [...args], {
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const keep = (prior: string, chunk: Buffer): string => `${prior}${chunk.toString("utf8")}`.slice(-TAIL_BYTES);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = keep(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = keep(stderr, chunk);
		});
		const stdin = child.stdin; // nullable in spawn's types regardless of stdio config
		if (options.stdin !== undefined && stdin !== null) {
			stdin.write(options.stdin);
			stdin.end();
		}
		child.on("error", (error: Error) => {
			resolveRun({
				code: null,
				stdoutTail: stdout,
				stderrTail: `${stderr}\nspawn error: ${error.message}`.trim(),
			});
		});
		child.on("close", (code) => {
			resolveRun({ code, stdoutTail: stdout, stderrTail: stderr });
		});
	});

// ---- password hashing ----

/** Hash a plaintext into the SHA-512 crypt form the installer expects (`openssl passwd -6`). */
export type HashPassword = (password: string) => Promise<string>;

/**
 * The default {@link HashPassword}: `openssl passwd -6` reading the password from stdin
 * (never argv), then verify by re-hashing with the same salt — a truncated stdin capture
 * would otherwise brick the only recovery path into the guest.
 */
async function opensslPasswordHash(password: string, runBin: RunBin): Promise<string> {
	const first = await runBin("openssl", ["passwd", "-6", "-stdin"], { stdin: password });
	if (first.code !== 0) {
		throw new Error(`cidata: openssl passwd exited ${first.code ?? "spawn error"}: ${first.stderrTail.trim()}`);
	}
	const hash = first.stdoutTail.trim();
	// $6$<salt>$<digest> — re-hash with the extracted salt and compare.
	const parsed = /^\$6\$([^$]+)\$/.exec(hash);
	if (parsed === null) {
		throw new Error(`cidata: openssl passwd produced a malformed hash: ${hash}`);
	}
	const salt = parsed[1] ?? "";
	const check = await runBin("openssl", ["passwd", "-6", "-salt", salt, "-stdin"], { stdin: password });
	if (check.code !== 0 || check.stdoutTail.trim() !== hash) {
		throw new Error("cidata: password hash failed the salted re-hash verification");
	}
	return hash;
}

// ---- packing + preflight ----

/** Pack the cidata directory into the ISO at `isoPath` (volume label `cidata`). */
export type PackCidata = (dir: string, isoPath: string) => Promise<void>;

/** The PATH-presence check (default: tools/bin.ts's `isToolAvailable` — presence only, no download). */
export type LookupBin = (bin: string) => boolean;

const GENISOIMAGE_BIN = "genisoimage";
const XORRISO_BIN = "xorriso";
const ISOINFO_BIN = "isoinfo";
const VOLUME_ID = "cidata";

/** The one mkisofs flag set both tools accept; xorriso additionally needs the emulation wrapper. */
function mkisofsArgv(tool: string, isoPath: string, dir: string): string[] {
	// genisoimage IS mkisofs (cdrkit's fork — direct flags); xorriso emulates it via `-as mkisofs`.
	const emulation = tool === XORRISO_BIN ? ["-as", "mkisofs"] : [];
	return [...emulation, "-output", isoPath, "-volid", VOLUME_ID, "-joliet", "-rock", dir];
}

/**
 * The label is how the installer FINDS the drive — assert it before spending 45 min on a
 * boot. xorriso's `-indev` probe prints `Volume id : 'cidata'` (the spike's check, quoted);
 * the cdrkit side probes with `isoinfo -d` (`Volume id: cidata`, unquoted) — the value is
 * extracted after the last colon and quote-stripped so one assertion covers both.
 */
async function assertVolumeId(isoPath: string, lookup: LookupBin, runBin: RunBin): Promise<void> {
	const prober = lookup(XORRISO_BIN) ? XORRISO_BIN : ISOINFO_BIN;
	if (!lookup(prober)) {
		throw new Error(`cidata: cannot verify the packed volume id — needs ${XORRISO_BIN} or ${ISOINFO_BIN} (cdrkit)`);
	}
	const probed =
		prober === XORRISO_BIN
			? await runBin(XORRISO_BIN, ["-indev", isoPath])
			: await runBin(ISOINFO_BIN, ["-d", "-i", isoPath]);
	const volumeLine = `${probed.stdoutTail}${probed.stderrTail}`
		.split(/\r?\n/)
		.find((line) => /Volume id\b/i.test(line));
	const volumeId = volumeLine?.split(":").slice(1).join(":").trim().replaceAll("'", "");
	if (volumeId !== VOLUME_ID) {
		throw new Error(`cidata: packed ISO volume id is not '${VOLUME_ID}': ${volumeLine ?? "no Volume id line"}`);
	}
}

/**
 * The default {@link PackCidata}: preflight genisoimage, fall back to xorriso, ABSENT BOTH
 * throw the spec-26 actionable error naming the packages (no silent fallback), then pack
 * with the mkisofs flag set and assert the volume label.
 */
async function packCidataIso(dir: string, isoPath: string, lookup: LookupBin, runBin: RunBin): Promise<void> {
	const tool = lookup(GENISOIMAGE_BIN) ? GENISOIMAGE_BIN : lookup(XORRISO_BIN) ? XORRISO_BIN : undefined;
	if (tool === undefined) {
		throw new Error(`cidata packing needs genisoimage or xorriso (Arch: sudo pacman -S cdrkit or xorriso)`);
	}
	const packed = await runBin(tool, mkisofsArgv(tool, isoPath, dir));
	if (packed.code !== 0) {
		throw new Error(`cidata: ${tool} exited ${packed.code ?? "spawn error"}: ${packed.stderrTail.trim()}`);
	}
	await assertVolumeId(isoPath, lookup, runBin);
}

// ---- the generator ----

/** Everything one cidata build needs — the GuestConfig (26a's normalize output) drives every field. */
export interface CidataInput {
	readonly config: GuestConfig;
	readonly dirs: VmDirs;
	/** Build name — the cidata tree is `<vm root>/cidata/<name>/`, the ISO `<name>.iso`. */
	readonly name: string;
	/**
	 * Where the plaintext recovery password is recorded (0600) — the INSTALLER SESSION passes
	 * its own path (e.g. `<session>/luks-or-sudo-password.txt`); the host keeps no other copy.
	 */
	readonly recoveryPath: string;
}

/** What a finished cidata build produced. */
export interface CidataBuild {
	/** The generated file set (six files, 0700 dir). */
	readonly dir: string;
	readonly isoPath: string;
	readonly isoSize: number;
	/** The host keypair's private half — what the installer session ssh's in with. */
	readonly privateKeyPath: string;
	readonly publicKey: string;
	readonly recoveryPasswordPath: string;
}

/**
 * The injectable seams (the qemu/process.ts injection-arg precedent: the production call
 * shape stays clean). `hashPassword` and `pack` default to the real openssl / mkisofs
 * chains; `lookupBin`/`runBin` exist so the DEFAULT pack chain is testable without the
 * binaries; `randomPassword` exists so golden tests get stable bytes (the plaintext lands
 * verbatim in the encrypted variant's JSON).
 */
export interface CidataDeps {
	/** Override the password hasher (tests inject a deterministic `$6$…` fake). Default: openssl. */
	readonly hashPassword?: HashPassword;
	/** Override the whole pack step (tests record `(dir, isoPath)`). Default: preflight + pack + volid assert. */
	readonly pack?: PackCidata;
	/** Override the PATH-presence check the default pack preflights with. Default: `isToolAvailable`. */
	readonly lookupBin?: LookupBin;
	/** Override the binary runner the default hash/pack chains spawn through. Default: real spawn. */
	readonly runBin?: RunBin;
	/** Override the plaintext generator (tests fix it for byte-stable goldens). Default: 24 random bytes, base64url. */
	readonly randomPassword?: () => string;
}

/** Mirrors session.ts's SESSION_ID_PATTERN — the build name is a path segment we join unsanitized. */
const CIDATA_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function randomPasswordDefault(): string {
	return randomBytes(24).toString("base64url");
}

/**
 * Generate the unattended set under `<vm root>/cidata/<name>/` (0700), record the plaintext
 * password to `recoveryPath` (0600 — the only host-side copy), and pack the directory into
 * `<name>.iso` with the resolved mkisofs tool. The six files are exactly the installer's
 * wizard output (see the module header for the 22d corrections); the recovery write comes
 * after the JSON so a failed hash leaves only the empty dir.
 */
export async function buildCidata(input: CidataInput, deps: CidataDeps = {}): Promise<CidataBuild> {
	if (!CIDATA_NAME_PATTERN.test(input.name)) {
		throw new Error(
			`cidata: build name is not a safe path segment: "${input.name}" (expected /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)`,
		);
	}
	const dir = join(input.dirs.cidata, input.name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });

	const runBin = deps.runBin ?? run;
	const hashPassword = deps.hashPassword ?? ((password: string) => opensslPasswordHash(password, runBin));
	const password = (deps.randomPassword ?? randomPasswordDefault)();
	const passwordHash = await hashPassword(password);
	const encryptionPassword = input.config.encrypt ? password : undefined;

	writeFileSync(
		join(dir, "user_configuration.json"),
		`${JSON.stringify(userConfiguration(input.config, encryptionPassword), null, 4)}\n`,
	);
	writeFileSync(
		join(dir, "user_credentials.json"),
		`${JSON.stringify(userCredentials(passwordHash, input.config.username, encryptionPassword), null, 4)}\n`,
	);
	writeFileSync(join(dir, "user_full_name.txt"), `${fullNameOf(input.config)}\n`);
	writeFileSync(join(dir, "user_email_address.txt"), `${emailAddressOf(input.config)}\n`);
	// The wizard's `printf '%s\n' "$encrypt_installation"` — lowercase true/false. The file
	// gates the installer's own encrypted-install provisioning (SDDM autologin — the LUKS
	// prompt is the auth boundary), so it must be true even though the JSON blocks alone
	// drive the LUKS formatting.
	writeFileSync(join(dir, "user_encrypt_installation.txt"), `${input.config.encrypt}\n`);

	const keypair = await ensureSshKeypair(input.dirs.root);
	writeFileSync(join(dir, "authorized_keys"), `${keypair.publicKey}\n`);

	const recoveryPasswordPath = input.recoveryPath;
	mkdirSync(dirname(recoveryPasswordPath), { recursive: true, mode: 0o700 });
	writeFileSync(recoveryPasswordPath, `${password}\n`, { mode: 0o600 });
	chmodSync(recoveryPasswordPath, 0o600); // writeFileSync mode only applies at creation

	const isoPath = `${dir}.iso`;
	const lookup = deps.lookupBin ?? isToolAvailable;
	const pack =
		deps.pack ?? ((packDir: string, packIsoPath: string) => packCidataIso(packDir, packIsoPath, lookup, runBin));
	await pack(dir, isoPath);
	return {
		dir,
		isoPath,
		isoSize: statSync(isoPath).size,
		privateKeyPath: keypair.privateKeyPath,
		publicKey: keypair.publicKey,
		recoveryPasswordPath,
	};
}
