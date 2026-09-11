/**
 * The `openhammer vm snapshot` runner (spec 26e): promote the provisioned build session
 * into the golden image tree — move its disk + installed OVMF VARS under `images/<id>/`,
 * copy the host-key pin beside them, and write the manifest, the durable record of what was
 * actually baked (the spec's edge case: guest.json edits after a golden exists apply to the
 * NEXT build — this doc is the truth about the existing one).
 *
 * THE PROMOTE SEMANTICS — what moves and what copies (every landed file 0600; the dir 0700):
 * - `disk.qcow2` → `images/<id>/golden.qcow2` — MOVED, then chmod 0600 (rename preserves the
 *   source's umask-default 0644; spec 26's every-artifact perms are enforced at the promote).
 *   After promotion the build session is no longer bootable, and that is the point: the
 *   golden is the ONE true copy of the disk, and a direct `vm provision` boot of it is
 *   exactly what the overlay discipline (spec 27) forbids. Every later session boots an
 *   overlay backed onto this file.
 * - `OVMF_VARS.4m.fd` → `images/<id>/OVMF_VARS.4m.fd` — MOVED, chmod 0600 likewise. The
 *   INSTALLED VARS carry the Limine boot entry (spike-proven: the pristine template VARS
 *   find no boot option); every later session copies THESE as its writable pflash (24a's
 *   prepareSession).
 * - `known_hosts` → `images/<id>/known_hosts` — COPIED, 0600. The 26d keyscan output is the
 *   pin source: future pinned sessions verify against the golden's copy, while the session
 *   dir keeps its own evidence (install.log, provision.log, the recovery password).
 *
 * GOLDEN ID: `golden-<isoVersion>-<YYYYMMDD-HHMMSS>` (`omarchy-4.0.3.iso` → `4.0.3`, the
 * {@link isoVersionOf} derivation; one pin, one name), the stamp UTC to match install's
 * `build-<ISO>` session names. An id collision (the same second) is REFUSED, never
 * overwritten — a golden is never an id to recycle.
 *
 * THE ENCRYPT FLAG COMES FROM THE CURRENT guest.json (documented limitation): the session
 * dir does not record the config it was built with, so snapshot reads the live doc — the
 * cidata build that made the session used the same config unless it was edited mid-build.
 * When `encrypt` is true a WARNING line says exactly that. Encrypted manifests additionally
 * record `luksPassphrase` (the session's luks-or-sudo-password.txt — the SAME generated
 * password is the LUKS passphrase and the sudo recovery path, 26b's cidata) and
 * `unlockPrompt` (22-measured gate 3's greppable serial string — spec 24's unlock chain
 * keys on it).
 *
 * THE ENCRYPTED-ARTIFACT POSTURE: an encrypted manifest is a guest-root-credential
 * artifact — written 0600 beside the golden, NEVER logged, never copied into any settings
 * doc; {@link readManifest} is the one sanctioned reader (later boxes: 27c preflight, 28c
 * guards). The unencrypted default records NO passphrase fields at all, and normalize
 * rejects a manifest that claims unencrypted while carrying them.
 *
 * LICENSING (spec 26): one log line — the golden is a personal artifact; Omarchy's ISO
 * license terms apply to redistributed images, not personal use.
 *
 * THE SPEC-29 FLAVOR/AGENT FIELDS: the manifest also records the golden's FLAVOR
 * (`options.flavor`, default "base" — `vm provision`'s agent flavor bakes pre-warmed
 * caches and asserts the agent binary) and the baked AGENT (guest.json's `agent` at
 * build time — the file `omarchy default agent` reads). The agent field closes 28d's
 * drift gap: manage's note now compares config.agent vs manifest.agent. LEGACY manifests
 * (26e goldens, written before the field existed) normalize with the documented
 * {@link LEGACY_AGENT_DEFAULT} — 26d's guest-config default "claude" is the only agent
 * any legacy golden could have baked; new writes always record it explicitly.
 *
 * Error model: process layer, not a tool. Expected failures THROW actionable errors naming
 * the missing file and the next command; the CLI boundary maps them to exit 1. SINGLE-FLIGHT
 * is 26c's guard (refuse when any qemu.pid under `<sessions>/` names a live verified-ours
 * QEMU): moving the disk out from under a running boot is the one unrecoverable mistake
 * available to a promoter.
 */
import {
	chmodSync,
	copyFileSync,
	type Dirent,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	type Stats,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { QEMU_IMG_BIN } from "../qemu/process.ts";
import { type RunQemuImg, resolveVmDirs } from "../session.ts";
import { loadGuestConfig } from "./guest-config.ts";
import { type ScanActiveSessions, scanActiveVmSessions } from "./install.ts";
import { ISO_NAME, ISO_SHA256, ISO_URL, runBinDefault, sha256OfFile } from "./iso.ts";

// ---- the fixed names (26c/26d's session shape, restated: the session this promotes) ----

const DISK_FILE = "disk.qcow2";
const VARS_FILE = "OVMF_VARS.4m.fd";
const KNOWN_HOSTS_FILE = "known_hosts";
const RECOVERY_FILE = "luks-or-sudo-password.txt";
const BUILD_PREFIX = "build-";

/** The promoted disk's name under `images/<id>/` — the file every later session overlays. */
export const GOLDEN_DISK_FILE = "golden.qcow2";
const MANIFEST_FILE = "manifest.json";

/** The operator's free-form escape hatch, host-side (26d streams it into the guest). */
const PROVISION_SCRIPT = "provision.sh";

/**
 * 22-measured gate 3's greppable unlock string — what systemd-cryptsetup prints on serial
 * when the LUKS root asks for its passphrase. Spec 24's unlock chain greps for it; the
 * manifest records it so the chain never carries a second hardcoded copy.
 */
export const UNLOCK_PROMPT = "A password is required to access the root volume:";

// The session id guard (session.ts's SESSION_ID_PATTERN posture — the name is a path
// segment joined unsanitized).
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ---- the manifest (the record of what was actually baked) ----

/** The golden's flavor: `base` (this box's product) or `agent` (a later pre-warmed variant). */
export type ManifestFlavor = "base" | "agent";

/**
 * The manifest `agent` default for LEGACY manifests (spec 29): 26e goldens predate the
 * field, and 26d's guest-config default — the only agent such a golden could have baked —
 * was "claude". New writes always record the agent explicitly.
 */
export const LEGACY_AGENT_DEFAULT = "claude";

/**
 * `images/<id>/manifest.json` (0600) — the golden's provenance: which pinned ISO built it,
 * which guest user it owns, how big the disk is, and (encrypted builds only) the LUKS
 * passphrase + unlock prompt. Hand-validated at the {@link readManifest} boundary; unknown
 * extra keys are ignored (the settings.ts forward-compatibility posture).
 */
export interface Manifest {
	/** The golden dir's name (`golden-<isoVersion>-<stamp>` — a single safe path segment). */
	readonly id: string;
	readonly flavor: ManifestFlavor;
	/**
	 * The agent baked into the golden (guest.json's `agent` at build time — the file
	 * `omarchy default agent` reads). Spec 29 added the field; LEGACY manifests predate
	 * it and normalize to {@link LEGACY_AGENT_DEFAULT}.
	 */
	readonly agent: string;
	/** The Linux user the installer created (26a's guest.json at build time). */
	readonly guestUser: string;
	/** The guest home — `MCP_ROOT_DIR` in vm modes (spec 27: `/home/<guestUser>`). */
	readonly rootDir: string;
	/** The pinned ISO's version token (`omarchy-4.0.3.iso` → `4.0.3`). */
	readonly isoVersion: string;
	readonly isoUrl: string;
	readonly isoSha256: string;
	/** qemu-img info's `virtual-size` of the promoted disk, captured BEFORE the move. */
	readonly diskVirtualSizeBytes: number;
	/** sha256 of the provision.sh that ran, or null when the operator had none. */
	readonly provisionScriptHashes: string | null;
	/** When the golden was minted (ISO-8601 UTC). */
	readonly builtAt: string;
	/** LUKS-disk-encryption toggle of the build (the CURRENT guest.json's — see header). */
	readonly encrypt: boolean;
	/** Encrypted builds only: the serial string spec 24's unlock chain greps for. */
	readonly unlockPrompt?: string;
	/** Encrypted builds only: the guest-root-credential artifact — 0600, never logged. */
	readonly luksPassphrase?: string;
}

// ---- the external seams ----

/** A `rename(2)` seam — the promote's two moves (tests record them). */
export type RenamePath = (from: string, to: string) => void;

/** A stat with `throwIfNoEntry` semantics — every existence check here (tests script hits). */
export type StatPath = (path: string) => Stats | undefined;

/**
 * Injection seams for EVERYTHING external (the box contract: defaults = the real ones).
 * `scanActiveSessions` is 26c's single-flight scan (the provision.ts seam posture) so the
 * refusal is scriptable without a live QEMU.
 */
export interface SnapshotDeps {
	/** Override the HOME the vm tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the qemu-img runner (default: runBinDefault over QEMU_IMG_BIN). */
	readonly runQemuImg?: RunQemuImg;
	/** Override the promote's renames (default: renameSync). */
	readonly rename?: RenamePath;
	/** Override the existence stat (default: statSync with throwIfNoEntry). */
	readonly stat?: StatPath;
	/** The progress line sink (the CLI passes its stdout). Default: console.log. */
	readonly log?: (line: string) => void;
	/** Override the single-flight pid scan (tests script a hit or a miss). */
	readonly scanActiveSessions?: ScanActiveSessions;
}

export interface SnapshotOptions {
	/** The provisioned session to promote (default: the most recent complete `build-*`). */
	readonly sessionName?: string;
	/**
	 * The golden's flavor to record (spec 29; default "base"). The operator passes
	 * "agent" when promoting a provision run whose asserted agent pre-warm passed.
	 */
	readonly flavor?: ManifestFlavor;
}

export interface SnapshotResult {
	/** The minted golden id (`golden-<isoVersion>-<YYYYMMDD-HHMMSS>`). */
	readonly goldenId: string;
	/** `<images>/<goldenId>/manifest.json` (0600). */
	readonly manifestPath: string;
	readonly diskVirtualSizeBytes: number;
}

const renameDefault: RenamePath = (from, to) => renameSync(from, to);
const statDefault: StatPath = (path) => statSync(path, { throwIfNoEntry: false });

/** Narrow an unknown throw/catch value to its message string. */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

// ---- the pure derivations (the id format is a contract later boxes parse) ----

/** `omarchy-4.0.3.iso` → `4.0.3` — strip the distro prefix and extension (one pin, one name). */
export function isoVersionOf(isoName: string): string {
	const withoutExtension = isoName.replace(/\.iso$/, "");
	const dash = withoutExtension.indexOf("-");
	return dash === -1 ? withoutExtension : withoutExtension.slice(dash + 1);
}

/** The golden id: `golden-<isoVersion>-<YYYYMMDD-HHMMSS>`, the stamp UTC (install's clock). */
export function goldenIdFor(isoVersion: string, at: Date): string {
	const pad = (value: number, width = 2): string => String(value).padStart(width, "0");
	const stamp =
		`${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}` +
		`-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
	return `golden-${isoVersion}-${stamp}`;
}

/** The most recent complete provisioned `build-*` session, or the named one when given. */
function findProvisionedSession(
	sessionsDir: string,
	name: string | undefined,
	stat: StatPath,
): {
	readonly sessionDir: string;
	readonly missing: string[];
} {
	const complete = (dir: string): string[] => {
		const missing: string[] = [];
		for (const file of [DISK_FILE, VARS_FILE, KNOWN_HOSTS_FILE]) {
			if (stat(join(dir, file)) === undefined) {
				missing.push(file);
			}
		}
		return missing;
	};
	if (name !== undefined) {
		const dir = join(sessionsDir, name);
		return { sessionDir: dir, missing: complete(dir) };
	}
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(sessionsDir, { withFileTypes: true });
	} catch {
		return { sessionDir: join(sessionsDir, BUILD_PREFIX), missing: [DISK_FILE] };
	}
	const names = entries
		.filter((entry) => entry.isDirectory() && entry.name.startsWith(BUILD_PREFIX))
		.map((entry) => entry.name)
		.sort();
	for (let i = names.length - 1; i >= 0; i--) {
		const dir = join(sessionsDir, names[i] ?? "");
		if (complete(dir).length === 0) {
			return { sessionDir: dir, missing: [] };
		}
	}
	const newest = names.at(-1);
	return {
		sessionDir: newest === undefined ? join(sessionsDir, BUILD_PREFIX) : join(sessionsDir, newest),
		missing: newest === undefined ? [DISK_FILE] : complete(join(sessionsDir, newest)),
	};
}

/** Pull qemu-img info's `virtual-size` out of its JSON, or throw the actionable error. */
function virtualSizeOf(stdout: string): number {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		throw new Error(`vm snapshot: qemu-img info printed unparseable JSON: ${stdout.trim()}`);
	}
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error(`vm snapshot: qemu-img info JSON is not an object: ${stdout.trim()}`);
	}
	const virtualSize = (parsed as Record<string, unknown>)["virtual-size"];
	if (typeof virtualSize !== "number" || !Number.isInteger(virtualSize) || virtualSize <= 0) {
		throw new Error(`vm snapshot: qemu-img info JSON has no usable virtual-size: ${stdout.trim()}`);
	}
	return virtualSize;
}

/**
 * `openhammer vm snapshot` (spec 26e) — locate the most recent provisioned build session
 * (disk + installed VARS + the 26d host-key pin), measure the disk, then promote it into
 * `images/golden-<isoVersion>-<stamp>/` (moves + the 0600 pin copy + the 0600 manifest).
 * See the module header for the promote semantics, the encrypt-from-current-config
 * limitation, and the encrypted-artifact posture. Throws with the actionable
 * next-command error before ANY side effect when the session is incomplete, a VM is
 * active, the minted id collides, or qemu-img cannot measure the disk.
 */
export async function runSnapshot(deps: SnapshotDeps = {}, options: SnapshotOptions = {}): Promise<SnapshotResult> {
	if (options.sessionName !== undefined && !SESSION_NAME_PATTERN.test(options.sessionName)) {
		throw new Error(
			`vm snapshot: session name is not a safe path segment: "${options.sessionName}" ` +
				`(expected /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)`,
		);
	}

	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const log = deps.log ?? ((line: string) => console.log(line));
	const stat = deps.stat ?? statDefault;
	const rename = deps.rename ?? renameDefault;

	// Single-flight (26c's guard): moving the disk out from under a running boot is the one
	// unrecoverable mistake available to a promoter.
	const scan = deps.scanActiveSessions ?? (() => scanActiveVmSessions(dirs));
	const active = (await scan())[0];
	if (active !== undefined) {
		throw new Error(
			`vm snapshot: a VM session is active — stop it first (openhammer vm status) — ` +
				`${active.sessionDir} holds qemu pid ${active.pid}`,
		);
	}

	const found = findProvisionedSession(dirs.sessions, options.sessionName, stat);
	if (found.missing.length > 0) {
		// disk.qcow2 missing → nothing was ever installed; otherwise the session exists but
		// never reached a complete provision pass (no pin to record, or no installed VARS).
		const remedy = found.missing.includes(DISK_FILE)
			? "run `openhammer vm install` first"
			: "run `openhammer vm provision` first";
		throw new Error(
			`vm snapshot: no provisioned build session to promote — ${found.sessionDir} is missing ` +
				`${found.missing.join(", ")} — ${remedy}`,
		);
	}
	const sessionDir = found.sessionDir;
	log(`snapshot: session ${sessionDir} (the provisioned build — promoting it to the golden)`);

	const config = loadGuestConfig(dirs);
	const flavor = options.flavor ?? "base";
	log(`snapshot: flavor ${flavor}, agent ${config.agent} (both recorded in the manifest — spec 29)`);
	if (config.encrypt) {
		// The documented limitation (see the module header): the session does not record its
		// build config, so the flag comes from the CURRENT doc — say so, loudly.
		log(
			`snapshot: WARNING encrypt flag taken from the CURRENT guest.json (the session does not ` +
				`record its build config) — if guest.json was edited since the build, rebuild with ` +
				"`openhammer vm install` + `openhammer vm provision`",
		);
	}
	let passphrase: string | undefined;
	if (config.encrypt) {
		const recoveryPath = join(sessionDir, RECOVERY_FILE);
		if (stat(recoveryPath) === undefined) {
			throw new Error(
				`vm snapshot: guest.json says encrypt=true but ${recoveryPath} is missing — ` +
					"run `openhammer vm install` first",
			);
		}
		try {
			passphrase = readFileSync(recoveryPath, "utf8").trim();
		} catch (error) {
			throw new Error(`vm snapshot: cannot read ${recoveryPath}: ${messageOf(error)}`);
		}
	}

	// Measure BEFORE the move (the manifest's diskVirtualSizeBytes describes the file while
	// it is still the session's disk; -U force-shares past any leftover lock, 26c's argv).
	const runQemuImgFn = deps.runQemuImg ?? ((args: readonly string[]) => runBinDefault(QEMU_IMG_BIN, args));
	const diskPath = join(sessionDir, DISK_FILE);
	const info = await runQemuImgFn(["info", "-U", "--output=json", diskPath]);
	if (info.code !== 0) {
		throw new Error(
			`vm snapshot: qemu-img info exited ${info.code ?? "spawn error"}: ${info.stderrTail.trim()} — ` +
				`cannot record diskVirtualSizeBytes for ${diskPath}`,
		);
	}
	const diskVirtualSizeBytes = virtualSizeOf(info.stdoutTail);
	log(`snapshot: disk virtual size ${diskVirtualSizeBytes} B (${diskPath})`);

	const scriptPath = join(dirs.root, PROVISION_SCRIPT);
	let provisionScriptHashes: string | null = null;
	if (stat(scriptPath) !== undefined) {
		try {
			provisionScriptHashes = await sha256OfFile(scriptPath);
		} catch (error) {
			throw new Error(`vm snapshot: cannot hash ${scriptPath}: ${messageOf(error)}`);
		}
		log(`snapshot: provision.sh sha256 ${provisionScriptHashes}`);
	}

	// Mint the id at the last moment (closest to the write), then refuse a collision — a
	// golden is never an id to recycle.
	const isoVersion = isoVersionOf(ISO_NAME);
	const builtAt = new Date();
	const goldenId = goldenIdFor(isoVersion, builtAt);
	const goldenDir = join(dirs.images, goldenId);
	if (stat(goldenDir) !== undefined) {
		throw new Error(
			`vm snapshot: golden ${goldenId} already exists at ${goldenDir} — refusing to overwrite ` +
				"(ids are minted per second; wait a moment and rerun, or remove the stale golden first)",
		);
	}
	mkdirSync(goldenDir, { recursive: true, mode: 0o700 });

	// ---- the promote: two moves + one 0600 copy (the module header's table). Each moved
	// file is chmod'd 0600 AFTER the move: rename(2) preserves the source mode, and the
	// session's disk/VARS were created at umask default (0644) — spec 26's every-artifact
	// 0600/0700 rule is enforced HERE, at the boundary where they become golden artifacts. ----
	const promote = (from: string, to: string, what: string): void => {
		try {
			rename(from, to);
			chmodSync(to, 0o600);
		} catch (error) {
			throw new Error(`vm snapshot: promote failed moving ${from} → ${to} (${what}): ${messageOf(error)}`);
		}
		log(`snapshot: moved ${what} (0600)`);
	};
	promote(diskPath, join(goldenDir, GOLDEN_DISK_FILE), `${DISK_FILE} → ${GOLDEN_DISK_FILE}`);
	promote(join(sessionDir, VARS_FILE), join(goldenDir, VARS_FILE), `${VARS_FILE} (the installed VARS)`);
	const goldenKnownHosts = join(goldenDir, KNOWN_HOSTS_FILE);
	try {
		copyFileSync(join(sessionDir, KNOWN_HOSTS_FILE), goldenKnownHosts);
		chmodSync(goldenKnownHosts, 0o600); // the pin copy is 0600 whatever the source's mode was
	} catch (error) {
		throw new Error(
			`vm snapshot: promote failed copying ${join(sessionDir, KNOWN_HOSTS_FILE)} → ${goldenKnownHosts}: ` +
				messageOf(error),
		);
	}
	log(`snapshot: copied ${KNOWN_HOSTS_FILE} → ${goldenKnownHosts} (0600, the pin source)`);

	// ---- the manifest: the encrypted-only fields ride ONLY the encrypted build (the
	// unencrypted doc has no passphrase keys at all; readManifest enforces the same
	// invariant coming back). ----
	const core: Omit<Manifest, "unlockPrompt" | "luksPassphrase"> = {
		id: goldenId,
		flavor,
		agent: config.agent,
		guestUser: config.username,
		rootDir: `/home/${config.username}`,
		isoVersion,
		isoUrl: ISO_URL,
		isoSha256: ISO_SHA256,
		diskVirtualSizeBytes,
		provisionScriptHashes,
		builtAt: builtAt.toISOString(),
		encrypt: config.encrypt,
	};
	const manifest: Manifest =
		passphrase === undefined ? core : { ...core, unlockPrompt: UNLOCK_PROMPT, luksPassphrase: passphrase };
	const manifestPath = join(goldenDir, MANIFEST_FILE);
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	chmodSync(manifestPath, 0o600); // writeFileSync mode only applies at creation
	log(`snapshot: manifest ${manifestPath} (0600)`);

	log(`snapshot: golden ${goldenId} at ${goldenDir}`);
	log(
		"snapshot: Note: the golden image is a personal artifact (Omarchy's ISO license terms apply to " +
			"redistributed images, not personal use).",
	);
	return { goldenId, manifestPath, diskVirtualSizeBytes };
}

// ---- the read boundary (the guest-config idiom: strict hand-validation, null on any miss) ----

const GOLDEN_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const USER_SEGMENT_PATTERN = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/; // guest-config's segment shape
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ISO_STAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function isNonEmptyString(v: unknown): v is string {
	return typeof v === "string" && v.length > 0;
}

function isSha256(v: unknown): v is string {
	return typeof v === "string" && SHA256_PATTERN.test(v);
}

function isManifestFlavor(v: unknown): v is ManifestFlavor {
	return v === "base" || v === "agent";
}

/**
 * Validate a parsed value as a full {@link Manifest} and return it canonically; `null` when
 * it is structurally off (wrong shape, unknown flavor, a non-hex digest, a non-stamp
 * builtAt, an encrypted doc missing its passphrase fields, or — the deliberate strictness —
 * an "unencrypted" doc carrying them: that is a contradiction, not a config to trust).
 * Unknown extra keys are ignored (the settings.ts posture).
 */
export function normalizeManifest(v: unknown): Manifest | null {
	if (typeof v !== "object" || v === null) return null;
	const o = v;
	if (!("id" in o) || typeof o.id !== "string" || !GOLDEN_ID_PATTERN.test(o.id)) return null;
	if (!("flavor" in o) || !isManifestFlavor(o.flavor)) return null;
	// The agent field (spec 29): LEGACY manifests predate it — absent normalizes to the
	// documented {@link LEGACY_AGENT_DEFAULT} (26d's guest-config default, the only agent
	// such a golden could have baked). A PRESENT-but-invalid agent is corruption, not
	// legacy — the guest-config segment shape keeps it a single safe token in every
	// surface it is printed to (the drift note).
	const rawAgent: unknown = "agent" in o ? o.agent : undefined;
	const agent =
		rawAgent === undefined
			? LEGACY_AGENT_DEFAULT
			: typeof rawAgent === "string" && USER_SEGMENT_PATTERN.test(rawAgent)
				? rawAgent
				: null;
	if (agent === null) return null;
	if (!("guestUser" in o) || typeof o.guestUser !== "string" || !USER_SEGMENT_PATTERN.test(o.guestUser)) return null;
	if (!("rootDir" in o) || typeof o.rootDir !== "string" || !o.rootDir.startsWith("/home/")) return null;
	if (!("isoVersion" in o) || !isNonEmptyString(o.isoVersion)) return null;
	if (!("isoUrl" in o) || !isNonEmptyString(o.isoUrl)) return null;
	if (!("isoSha256" in o) || !isSha256(o.isoSha256)) return null;
	if (
		!("diskVirtualSizeBytes" in o) ||
		typeof o.diskVirtualSizeBytes !== "number" ||
		!Number.isInteger(o.diskVirtualSizeBytes) ||
		o.diskVirtualSizeBytes <= 0
	) {
		return null;
	}
	const hashes: unknown = "provisionScriptHashes" in o ? o.provisionScriptHashes : undefined;
	let provisionScriptHashes: string | null;
	if (hashes === null || isSha256(hashes)) {
		provisionScriptHashes = hashes;
	} else {
		return null;
	}
	if (!("builtAt" in o) || typeof o.builtAt !== "string" || !ISO_STAMP_PATTERN.test(o.builtAt)) return null;
	if (!("encrypt" in o) || typeof o.encrypt !== "boolean") return null;
	const core = {
		id: o.id,
		flavor: o.flavor,
		agent,
		guestUser: o.guestUser,
		rootDir: o.rootDir,
		isoVersion: o.isoVersion,
		isoUrl: o.isoUrl,
		isoSha256: o.isoSha256,
		diskVirtualSizeBytes: o.diskVirtualSizeBytes,
		provisionScriptHashes,
		builtAt: o.builtAt,
		encrypt: o.encrypt,
	};
	if (o.encrypt) {
		const unlockPrompt: unknown = "unlockPrompt" in o ? o.unlockPrompt : undefined;
		const luksPassphrase: unknown = "luksPassphrase" in o ? o.luksPassphrase : undefined;
		if (!isNonEmptyString(unlockPrompt) || !isNonEmptyString(luksPassphrase)) return null;
		return { ...core, unlockPrompt, luksPassphrase };
	}
	if ("unlockPrompt" in o || "luksPassphrase" in o) return null;
	return core;
}

/**
 * Read + validate a golden manifest. Absent, unreadable, or structurally corrupt → `null`
 * (the `loadGuestConfig` posture quoted in the module header): 27c's preflight turns that
 * into its own "golden manifest invalid — rebuild with vm install" failure, and nothing
 * downstream ever trusts a half-shaped doc.
 */
export function readManifest(path: string): Manifest | null {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return null; // absent or unreadable — not a golden this boundary can vouch for
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	return normalizeManifest(parsed);
}
