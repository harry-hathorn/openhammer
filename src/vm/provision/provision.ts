/**
 * The `openhammer vm provision` runner (spec 26d): the idempotent ssh provisioning pass
 * over the installed build session — the pass that turns 26c's fresh install into the
 * disk `vm snapshot` will promote to golden. Every step is RE-RUNNABLE: rerunning the
 * whole command is the documented recovery for a partial pass (the spec's edge case).
 *
 * THE THREE SPIKE AMENDMENTS (22-measured, overriding spec 26's prose):
 * - SDDM autologin is a REQUIRED step (finding 3): nothing starts a desktop session for
 *   the cidata user without `/etc/sddm.conf.d/99-openhammer-autologin.conf` + the
 *   `autologin` group + an sddm restart — the greeter's own Hyprland owns tty1 otherwise.
 * - The default agent is set by WRITING `~/.config/omarchy/defaults/agent` directly
 *   (finding 12): `omarchy default agent <x>` is a Wayland PICKER — rc 0 headless but
 *   nothing persists. The getter (`omarchy default agent`) reads the file, so the verify
 *   step still goes through Omarchy's own surface.
 * - The env-source line goes in BOTH `~/.bashrc` AND `~/.zshrc` (finding 11): the guest
 *   shell is BASH (zsh not even installed in the cidata image) — bashrc is load-bearing,
 *   zshrc is belt-and-braces for images that ship zsh.
 * - The monitor pin SUPERSEDES the spec's "pin the Hyprland monitor" line: it lives at the
 *   QEMU layer (24c's `MONITOR_EDID` on the display device, in every qemuBootArgs argv),
 *   NOT in a guest hyprland conf — there is no guest-side monitor step here, by design.
 *
 * THE 27K SHIP-GATE AMENDMENT: the pass also writes the logind drop-in
 * `/etc/systemd/logind.conf.d/99-openhammer-powerkey.conf` =
 * `[Login]\nHandlePowerKey=poweroff\n`. Omarchy ships `HandlePowerKey=ignore`, which made
 * the ACPI power button — QMP `system_powerdown`'s only guest lever — a no-op, so the
 * service's 180 s clean-poweroff budget expired into the stop ladder on every session
 * teardown. The drop-in is read at EVERY boot; logind is deliberately NOT restarted at
 * provision time (restarting it can kill our own ssh session) — the next boot is all the
 * gate and the product need.
 *
 * DIRECT BOOT, NOT AN OVERLAY: provision boots the install session's disk.qcow2 DIRECTLY
 * (qemuBootArgs's session-boot shape pointing at `<session>/disk.qcow2`). This is the one
 * product boot that mutates a base disk ON PURPOSE — the session is a BUILD, not a golden,
 * and preparing that disk IS this command's job. Every later boot (spec 27's sessions)
 * overlays the promoted golden and never mutates it; the overlay discipline starts at
 * snapshot, not here.
 *
 * THE SSH STYLE IS PRE-PIN (26c's posture): there is still no host key to pin — the
 * installed system's key is only CAPTURED mid-pass (the keyscan step writes
 * `<session>/known_hosts`, the file future pinned sessions verify against). Until then the
 * default exec uses the install-time unpinned options (`-F /dev/null`,
 * StrictHostKeyChecking=no, UserKnownHostsFile=/dev/null, BatchMode, ConnectTimeout) on
 * loopback only — and keeps 25a's one-pre-joined-command-element discipline: ssh joins
 * trailing command argv with spaces and the remote shell evaluates the result, so the
 * command travels as exactly one authored element, never split.
 *
 * THE SPEC-29 FLAVOR AMENDMENT: the pass takes `options.flavor` (default DERIVED from the
 * resolved VM mode — `MCP_VM_MODE` > `settings.vm.mode` via config.ts's own resolution,
 * injected as {@link ProvisionDeps.resolveVmMode}). The AGENT flavor adds exactly ONE
 * behavior to the base pass: the agent pre-warm step (i) becomes AUTHORITATIVE — the
 * golden must resolve the agent binary (`~/.local/bin/<agent> --version` rc 0 is
 * asserted; that run IS the mise install, so asserting it asserts the pre-warmed cache's
 * seed). The flavor is recorded in the result + the log lines. The base flavor's pass is
 * byte-identical to 26d's.
 *
 * TEARDOWN (finding 2, the corrupt-golden lesson — doubly load-bearing here: this boot
 * writes to the real disk): clean guest poweroff (`sudo -S systemctl poweroff`, recovery
 * password on stdin) waited out ≤180 s; the stop ladder only as the fallback, and a ladder
 * that ends in SIGKILL is a FAILURE — a disk cut mid-write cannot be trusted as a golden.
 *
 * NEVER WRITTEN HERE: `~/.openhammer/env` and any credential (spec 29 pushes secrets at
 * session start); only the DIR `~/.openhammer` is created, so the rc line's own
 * `[ -f … ]` guard stays cheap. The full mise/npm cache warming is the operator's
 * `provision.sh` territory — this pass only resolves the agent stub (one `--version`).
 *
 * SINGLE-FLIGHT (26c's guard, reused): refuse when any qemu.pid under `<sessions>/` names
 * a live verified-ours QEMU.
 */

import type { Dirent } from "node:fs";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { loadSettings } from "../../config/settings.ts";
import { resolveConfig } from "../../config.ts";
import { captureOnTeardown } from "../capture.ts";
import { qemuBootArgs } from "../qemu/args.ts";
import {
	type QemuHandle,
	type StartQemuOptions,
	type StopOutcome,
	type StopQemuOptions,
	startQemu as startQemuReal,
	stopQemu as stopQemuReal,
} from "../qemu/process.ts";
import type { QmpClient } from "../qmp/client.ts";
import { resolveVmDirs } from "../session.ts";
import { discoverSshPort as discoverSshPortReal } from "../usernet.ts";
import type { BinRunResult } from "./cidata.ts";
import { loadGuestConfig } from "./guest-config.ts";
import {
	CONFIRM_GAP_MS,
	POWEROFF_POLL_MS,
	POWEROFF_WAIT_MS,
	type ScanActiveSessions,
	SSH_POLL_MS,
	scanActiveVmSessions,
} from "./install.ts";
import { runBinDefault } from "./iso.ts";
import type { ManifestFlavor } from "./snapshot.ts";

// ---- tunables (26c's constants, reused; the boot is a proven ~31 s to ssh) ----

/**
 * The boot budget, minutes. The measured reality is ~31 s from power-on to confirmed ssh
 * on the installed disk (22-measured gate 2's overlay boots); 10 bounds a cold cache or a
 * loaded host without inviting an hour-long hang.
 */
export const DEFAULT_BUDGET_MINUTES = 10;

// ---- the pass's fixed shapes (the spike's proven paths + content) ----

/** The tool packages the product's own tooling needs present in every golden (spec 26). */
export const PROVISION_PACKAGES = ["ripgrep", "fd", "tmux"] as const;

/** Finding 3's recipe: the drop-in that makes SDDM autologin the guest user into Hyprland. */
export const SDDM_CONF_DEST = "/etc/sddm.conf.d/99-openhammer-autologin.conf";

/** The staging path the conf rides through (stdin over the wire, then `sudo install`). */
const SDDM_CONF_STAGING = "/tmp/openhammer-sddm-autologin.conf";

/**
 * The logind power-key drop-in (27k ship gate): Omarchy ships `HandlePowerKey=ignore`,
 * which makes the ACPI power button — QMP `system_powerdown`'s only guest lever — a
 * no-op, so every later session's clean-poweroff budget expired into the stop ladder.
 */
export const LOGIND_POWERKEY_DEST = "/etc/systemd/logind.conf.d/99-openhammer-powerkey.conf";

/** The staging path the drop-in rides through (stdin over the wire, then `sudo install`). */
const LOGIND_POWERKEY_STAGING = "/tmp/openhammer-logind-powerkey.conf";

/** The drop-in's exact content — read at every boot (no logind restart at provision time). */
export const LOGIND_POWERKEY_CONF = "[Login]\nHandlePowerKey=poweroff\n";

/** Finding 12's file: what `omarchy default agent` (the getter) reads. */
export const AGENT_DEFAULTS_PATH = "~/.config/omarchy/defaults/agent";

/** Omarchy's own hook system — where guest-config's bootCommands land (spec 26). */
export const BOOT_HOOK_PATH = "~/.config/omarchy/hooks/post-boot.d/openhammer.sh";

/** Finding 11's line — POSIX-sh compatible so the one literal serves bashrc and zshrc. */
export const ENV_SOURCE_LINE = "[ -f ~/.openhammer/env ] && . ~/.openhammer/env";

/** The rc files that carry the env-source line (bash load-bearing, zsh belt-and-braces). */
const RC_FILES = [".bashrc", ".zshrc"] as const;

/** The operator's free-form escape hatch, host-side (spec 26: streamed + run if present). */
const PROVISION_SCRIPT = "provision.sh";

/** What the provision boot names its own evidence files (the install boot's are kept intact). */
const SERIAL_FILE = "provision-serial.log";
const STDERR_FILE = "provision-qemu.stderr";
const LOG_FILE = "provision.log";
const KNOWN_HOSTS_FILE = "known_hosts";
const DEBUG_DIR = "debug";

// 26c's install-session shape (install.ts's private names, restated: the session this
// pass consumes is exactly what `vm install` leaves behind).
const DISK_FILE = "disk.qcow2";
const VARS_FILE = "OVMF_VARS.4m.fd";
const RECOVERY_FILE = "luks-or-sudo-password.txt";
const BUILD_PREFIX = "build-";

// The session id guard (session.ts's SESSION_ID_PATTERN posture — the name is a path
// segment joined unsanitized).
const SESSION_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// ---- the external seams ----

/**
 * The guest-side exec: ONE authored remote command string (+ optional stdin), the 26c
 * InstallSshExec posture minus the per-call user/port/key (constant for the whole pass).
 * Non-zero guest exits RESOLVE — each step judges its own rc (the process-layer rule).
 */
export type ProvisionExec = (command: string, options?: { readonly stdin?: string }) => Promise<BinRunResult>;

/** The host-key capture: `ssh-keyscan` over the discovered hostfwd port (default: the real argv). */
export type KeyscanPort = (port: number) => Promise<BinRunResult>;

/** What `ssh-keyscan` prints when it found the guest's keys (non-comment, non-empty lines). */
export function keyscanKeyLines(stdout: string): string[] {
	return stdout.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
}

/**
 * Injection seams for EVERYTHING external (the box contract: defaults = the real ones).
 * `exec` defaults to the unpinned install-time ssh (see the module header — the pin only
 * exists after this pass captures it); `keyscan` defaults to the real `ssh-keyscan -p
 * <port> 127.0.0.1` arg array; the rest default to 24d/25d/26c's real implementations.
 */
export interface ProvisionDeps {
	/** Override the HOME the vm tree roots at (tests: temp dir; default: os.homedir). */
	readonly homeDir?: string;
	/** Override the QEMU spawn+connect (default: 24d's startQemu). */
	readonly startQemu?: (argv: readonly string[], opts: StartQemuOptions) => Promise<QemuHandle>;
	/** Override the stop ladder (default: 24d's stopQemu). */
	readonly stopQemu?: (handle: QemuHandle, opts?: StopQemuOptions) => Promise<StopOutcome>;
	/** Override the hostfwd port discovery (default: 25d's discoverSshPort, own retries). */
	readonly discoverSshPort?: (qmp: Pick<QmpClient, "humanMonitorCommand">) => Promise<number>;
	/** Override every guest-side command (default: the unpinned install-time ssh). */
	readonly exec?: ProvisionExec;
	/** Override the host-key capture (default: real ssh-keyscan via arg array). */
	readonly keyscan?: KeyscanPort;
	/** The progress line sink (the CLI passes its stdout). Default: console.log. */
	readonly log?: (line: string) => void;
	/** Override every sleep (tests: clock-advancing). Default: real setTimeout. */
	readonly sleep?: (ms: number) => Promise<void>;
	/** Override the clock (tests script the budget). Default: Date.now. */
	readonly now?: () => number;
	/** Override the single-flight pid scan (tests script a hit or a miss). */
	readonly scanActiveSessions?: ScanActiveSessions;
	/**
	 * The resolved VM mode the spec-29 flavor derives from (default: config.ts's own
	 * resolution — `MCP_VM_MODE` > `settings.vm.mode`, the TUI's mode select included,
	 * fail-fatal on an invalid value). Tests inject. `agent` derives the agent flavor
	 * ({@link flavorForMode}); `vm`/`off` derive base.
	 */
	readonly resolveVmMode?: () => "off" | "vm" | "agent";
}

export interface ProvisionOptions {
	/** The install session to provision (default: the most recent complete `build-*`). */
	readonly sessionName?: string;
	/** The boot budget in minutes (default {@link DEFAULT_BUDGET_MINUTES}; must be finite > 0). */
	readonly budgetMinutes?: number;
	/**
	 * The golden flavor this pass bakes (spec 29). `"agent"` makes the pre-warm step
	 * authoritative — the agent binary MUST resolve (`~/.local/bin/<agent> --version`
	 * rc 0) or the pass fails. Default: derived from the resolved VM mode
	 * ({@link ProvisionDeps.resolveVmMode}); an explicit value wins over the derivation.
	 */
	readonly flavor?: ManifestFlavor;
}

/** One in-pass verification assertion (the spec's manual gate, promoted to a check). */
export interface ProvisionCheck {
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export interface ProvisionResult {
	/** The install session dir that was booted (directly) and provisioned. */
	readonly sessionDir: string;
	readonly wallClockSeconds: number;
	/** Every verify assertion, in run order — all ok on a resolving run. */
	readonly checks: readonly ProvisionCheck[];
	/** The pre-warm step's outcome (a summary string; best-effort on base, asserted on agent). */
	readonly agentPrewarm: string;
	/** The flavor this pass baked (spec 29) — the explicit option or the mode derivation. */
	readonly flavor: ManifestFlavor;
}

// ---- the spec-29 flavor ----

/**
 * Spec 29's flavor derivation: the resolved VM mode chooses the golden's flavor.
 * `agent` mode provisions the agent flavor (the pre-warm asserted); `vm` and `off`
 * provision base — the operator-facing workspace flavor.
 */
export function flavorForMode(mode: "off" | "vm" | "agent"): ManifestFlavor {
	return mode === "agent" ? "agent" : "base";
}

/**
 * The default {@link ProvisionDeps.resolveVmMode} — SHARED with snapshot.ts, whose flavor
 * must derive IDENTICALLY (an agent-provisioned build must snapshot into an agent-flavored
 * manifest, never a silent "base"): the product's OWN config resolution (config.ts's
 * `resolveConfig` — `MCP_VM_MODE` > `settings.vm.mode`, so the TUI's mode select
 * participates, and an invalid value throws the config layer's fail-fatal error) with no
 * CLI flags — neither vm command has any.
 */
export const resolveVmModeDefault = (): "off" | "vm" | "agent" =>
	resolveConfig({}, process.env, loadSettings()).vm.mode;

/** Finding 3's conf, verbatim shape: `[Autologin]\nUser=<user>\nSession=hyprland\n`. */
export function sddmAutologinConf(username: string): string {
	return `[Autologin]\nUser=${username}\nSession=hyprland\n`;
}

/** The boot hook's content: a bash script of the operator's commands, one per line. */
export function bootHookScript(commands: readonly string[]): string {
	return `#!/bin/bash\n${commands.map((command) => `${command}\n`).join("")}`;
}

/** The most recent complete `build-*` session (26c's shape), or the named one when given. */
function findInstallSession(
	sessionsDir: string,
	name: string | undefined,
): {
	readonly sessionDir: string;
	readonly missing: string[];
} {
	const complete = (dir: string): string[] => {
		const missing: string[] = [];
		for (const file of [DISK_FILE, VARS_FILE, RECOVERY_FILE]) {
			if (statSync(join(dir, file), { throwIfNoEntry: false }) === undefined) {
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
		const missing = complete(dir);
		if (missing.length === 0) {
			return { sessionDir: dir, missing: [] };
		}
	}
	const newest = names.at(-1);
	return {
		sessionDir: newest === undefined ? join(sessionsDir, BUILD_PREFIX) : join(sessionsDir, newest),
		missing: newest === undefined ? [DISK_FILE] : complete(join(sessionsDir, newest)),
	};
}

const sleepDefault = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/** Bounded exit wait on the injected clock (26c's waitQemuExit, local: it is private there). */
async function waitQemuExit(
	handle: QemuHandle,
	now: () => number,
	sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
	const deadline = now() + POWEROFF_WAIT_MS;
	while (handle.exitInfo() === undefined) {
		if (now() >= deadline) {
			return false;
		}
		await sleep(POWEROFF_POLL_MS);
	}
	return true;
}

/**
 * `openhammer vm provision` (spec 26d) — boot the newest complete install session DIRECTLY
 * (headless, its own serial/stderr evidence files), gate on ssh, run the idempotent pass
 * (packages → SDDM autologin → agent defaults file → rc env lines → logind power-key
 * drop-in → boot hook → `~/.openhammer` dir → host-key capture → agent pre-warm → the
 * operator's provision.sh),
 * verify the spec's manual-gate assertions in-pass, then power the guest down cleanly.
 * Throws with actionable evidence on any failure (the session dir is kept — it is the
 * thing being fixed, and `vm provision` reruns idempotently).
 */
export async function runProvision(deps: ProvisionDeps = {}, options: ProvisionOptions = {}): Promise<ProvisionResult> {
	const budgetMinutes = options.budgetMinutes ?? DEFAULT_BUDGET_MINUTES;
	if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
		throw new Error(`vm provision: budgetMinutes must be a positive number (got ${options.budgetMinutes})`);
	}
	if (options.sessionName !== undefined && !SESSION_NAME_PATTERN.test(options.sessionName)) {
		throw new Error(
			`vm provision: session name is not a safe path segment: "${options.sessionName}" ` +
				`(expected /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/)`,
		);
	}

	const dirs = resolveVmDirs({ homeDir: deps.homeDir });
	const log = deps.log ?? ((line: string) => console.log(line));
	const sleep = deps.sleep ?? sleepDefault;
	const now = deps.now ?? Date.now;
	const config = loadGuestConfig(dirs);

	// The spec-29 flavor: an explicit option wins; otherwise the resolved VM mode derives
	// it. Resolved EARLY (before anything boots) so a malformed MCP_VM_MODE fails the
	// config layer's fail-fatal way — before QEMU, before a single guest command.
	const resolveVmMode = deps.resolveVmMode ?? resolveVmModeDefault;
	const flavorDerived = options.flavor === undefined;
	const flavor: ManifestFlavor = options.flavor ?? flavorForMode(resolveVmMode());
	log(`provision: flavor ${flavor}${flavorDerived ? " (derived from the resolved VM mode)" : ""}`);

	// Single-flight (26c's guard): a live session and a provisioning boot would fight over
	// the same disk — the one thing this pass must never race.
	const scan = deps.scanActiveSessions ?? (() => scanActiveVmSessions(dirs));
	const active = (await scan())[0];
	if (active !== undefined) {
		throw new Error(
			`vm provision: a VM session is active — stop it first (openhammer vm status) — ` +
				`${active.sessionDir} holds qemu pid ${active.pid}`,
		);
	}

	const found = findInstallSession(dirs.sessions, options.sessionName);
	if (found.missing.length > 0) {
		throw new Error(
			`vm provision: no complete install session to provision — ${found.sessionDir} is missing ` +
				`${found.missing.join(", ")} — run \`openhammer vm install\` first`,
		);
	}
	const sessionDir = found.sessionDir;
	const diskPath = join(sessionDir, DISK_FILE);
	const serialPath = join(sessionDir, SERIAL_FILE);
	const stderrPath = join(sessionDir, STDERR_FILE);
	const debugDir = join(sessionDir, DEBUG_DIR);
	const runLogPath = join(sessionDir, LOG_FILE);
	const knownHostsPath = join(sessionDir, KNOWN_HOSTS_FILE);
	const password = readFileSync(join(sessionDir, RECOVERY_FILE), "utf8").trim();
	const keyPath = join(dirs.root, "id_ed25519");

	// The DIRECT boot: the session-boot disk shape pointed at the install session's real
	// disk (see the module header — mutating this disk is the point). The provision boot
	// keeps its own serial/stderr files so the install boot's evidence survives; the
	// pidfile stays at the session default `qemu.pid` (the single-flight scan's key).
	const sessionName = basename(sessionDir);
	const argv = qemuBootArgs({
		name: sessionName,
		sessionDir,
		serialPath: serialPath,
		disks: { overlayPath: diskPath },
	});
	log(`provision: session ${sessionDir} (booting the install disk directly — the build becomes the golden)`);
	log(`provision: qemu ${JSON.stringify(argv)}`);
	const startQemuFn = deps.startQemu ?? ((a: readonly string[], o: StartQemuOptions) => startQemuReal(a, o));
	const handle = await startQemuFn(argv, { sessionDir, stderrPath });
	log(`provision: qemu pid ${handle.pid}`);

	const startedAt = now();
	const stepLines: string[] = [];
	const sshEvents: string[] = [];
	const checks: ProvisionCheck[] = [];
	let agentPrewarm = "not attempted";
	let hostPort: number | undefined;
	let ready = false;
	let phaseError: unknown;

	// One exec wrapper per remote call: never log stdin (the sudo password rides it), and
	// every command lands in the run log with its rc — the rerun story depends on it.
	const record = (command: string, result: BinRunResult, stdinBytes: number): void => {
		const stdinNote = stdinBytes > 0 ? ` [${stdinBytes} B stdin]` : "";
		const line = `${command}${stdinNote} → rc ${result.code}`;
		stepLines.push(line);
		log(`provision: ${line}`);
	};
	const evidence = (): string =>
		`evidence: serial log ${serialPath}, qemu stderr ${stderrPath}, run log ${runLogPath}, session ${sessionDir}`;

	// The exec seam: the injected fake when present, else the unpinned install-time ssh
	// built once the port exists (25a's one-pre-joined-command-element discipline — the
	// command string is the whole remote payload, authored here, never split).
	const rawExec = deps.exec;
	const exec = async (command: string, execOptions?: { readonly stdin?: string }): Promise<BinRunResult> => {
		if (hostPort === undefined) {
			throw new Error("vm provision: exec before the hostfwd port was discovered — impossible state");
		}
		const fn: ProvisionExec =
			rawExec ??
			((guestCommand, opts) =>
				runBinDefault(
					"ssh",
					[
						"-F",
						"/dev/null",
						"-i",
						keyPath,
						"-p",
						String(hostPort),
						"-o",
						"StrictHostKeyChecking=no",
						"-o",
						"UserKnownHostsFile=/dev/null",
						"-o",
						"ConnectTimeout=5",
						"-o",
						"BatchMode=yes",
						`${config.username}@127.0.0.1`,
						guestCommand,
					],
					opts,
				));
		const result = await fn(command, execOptions);
		record(command, result, execOptions?.stdin?.length ?? 0);
		return result;
	};
	// sudo over ssh: the password rides stdin (`-S`), never argv and never a log line;
	// `-p ''` keeps the prompt out of the captured output (the spike's sudoCapture).
	const sudo = (command: string): Promise<BinRunResult> =>
		exec(`sudo -S -p '' ${command}`, { stdin: `${password}\n` });
	const must = (result: BinRunResult, what: string): void => {
		if (result.code !== 0) {
			throw new Error(
				`vm provision: ${what} exited ${result.code ?? "spawn error"}: ${result.stderrTail.trim()} — ${evidence()}`,
			);
		}
	};

	try {
		// ---- readiness: usernet port + ssh `true`, double round-trips (26c's gate) ----
		// The installed system answers; no self-reboot is expected mid-provision, but the
		// 10 s confirm gap is kept — it is what distinguishes a dying sshd from a live one.
		const deadline = startedAt + budgetMinutes * 60_000;
		let lastNote = "not-run";
		while (now() < deadline) {
			const exit = handle.exitInfo();
			if (exit !== undefined) {
				throw new Error(
					`vm provision: qemu exited during the provisioning boot (exitCode=${exit.code} signalCode=${exit.signal}) — ${evidence()}`,
				);
			}
			if (hostPort === undefined) {
				const discoverFn =
					deps.discoverSshPort ?? ((qmp: Pick<QmpClient, "humanMonitorCommand">) => discoverSshPortReal(qmp));
				try {
					hostPort = await discoverFn(handle.qmp);
					sshEvents.push(`usernet: host port ${hostPort}`);
					log(`provision: usernet host port ${hostPort}`);
				} catch (error) {
					lastNote = `usernet: ${error instanceof Error ? error.message : String(error)}`;
				}
			}
			if (hostPort !== undefined && !ready) {
				const probe = await exec("true");
				if (probe.code === 0) {
					sshEvents.push(`ssh: first answer user=${config.username} port=${hostPort}`);
					log(`provision: ssh first answer user=${config.username} port=${hostPort}`);
					await sleep(CONFIRM_GAP_MS);
					const gapExit = handle.exitInfo();
					if (gapExit !== undefined) {
						throw new Error(
							`vm provision: qemu exited during the confirm gap (exitCode=${gapExit.code}) — ${evidence()}`,
						);
					}
					const confirm = await exec("true");
					if (confirm.code === 0) {
						ready = true;
						sshEvents.push(
							`ssh: CONFIRMED user=${config.username} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart)`,
						);
						log(`provision: ssh CONFIRMED user=${config.username} — gate passed`);
						break;
					}
					lastNote = `ssh confirm exit ${confirm.code}`;
				} else {
					lastNote = `ssh exit ${probe.code}`;
				}
			}
			await sleep(SSH_POLL_MS);
		}
		if (!ready) {
			throw new Error(
				`vm provision: no ssh gate within the ${budgetMinutes} min budget (port ${hostPort ?? "never learned"}, last ${lastNote}) — ${evidence()}`,
			);
		}
		if (hostPort === undefined) {
			throw new Error("vm provision: ready without a host port — impossible state");
		}

		// ---- (a) packages: `-y` refreshes the sync databases (the fresh install from the
		// offline-mirror ISO has NONE — 26g's manual gate: bare -S fails "database file for
		// 'core' does not exist"; the spike's 22c grim install hit the same and retried with
		// -Sy), and `--needed` skips what is already installed — both idempotent. ----
		const packagesCommand = `pacman -Sy --needed --noconfirm ${PROVISION_PACKAGES.join(" ")}`;
		must(await sudo(packagesCommand), packagesCommand);

		// ---- (b) SDDM autologin (finding 3 — REQUIRED): conf via stdin + `sudo install`,
		// the autologin group, the restart. Rerunning rewrites identical bytes; `groupadd
		// -f` and a re-`usermod -aG` are no-ops; the restart is idempotent in effect. ----
		const conf = sddmAutologinConf(config.username);
		must(await exec(`cat > ${SDDM_CONF_STAGING}`, { stdin: conf }), `cat > ${SDDM_CONF_STAGING}`);
		const installConf = `install -D -m 644 ${SDDM_CONF_STAGING} ${SDDM_CONF_DEST}`;
		must(await sudo(installConf), installConf);
		const autologinGroup = `sh -c 'groupadd -f autologin && usermod -aG autologin ${config.username}'`;
		must(await sudo(autologinGroup), autologinGroup);
		must(await sudo("systemctl restart sddm.service"), "systemctl restart sddm.service");

		// ---- (c) default agent: DIRECT WRITE (finding 12 — the setter is a Wayland picker) ----
		await exec("mkdir -p ~/.config/omarchy/defaults");
		must(await exec(`cat > ${AGENT_DEFAULTS_PATH}`, { stdin: `${config.agent}\n` }), `cat > ${AGENT_DEFAULTS_PATH}`);

		// ---- (d) env lines: append-if-absent in BOTH rc files (finding 11 — bash is
		// load-bearing, zsh is belt-and-braces). The grep guard IS the idempotency. ----
		for (const rcFile of RC_FILES) {
			const guard = await exec(`grep -q openhammer/env ~/${rcFile}`);
			if (guard.code === 0) {
				stepLines.push(`~/${rcFile} already sources ~/.openhammer/env`);
				log(`provision: ~/${rcFile} already sources ~/.openhammer/env`);
			} else {
				must(await exec(`cat >> ~/${rcFile}`, { stdin: `${ENV_SOURCE_LINE}\n` }), `cat >> ~/${rcFile}`);
			}
		}

		// ---- (e) logind power-key drop-in (27k ship gate): Omarchy ships
		// `HandlePowerKey=ignore`, so the ACPI power button — QMP `system_powerdown`'s
		// only guest lever — is a no-op and every session teardown expires into the stop
		// ladder. The drop-in is read at every boot; NO logind restart here (restarting
		// logind can kill our own ssh session). Rerun rewrites identical bytes; the
		// `install -D` creates the conf.d directory. ----
		must(
			await exec(`cat > ${LOGIND_POWERKEY_STAGING}`, { stdin: LOGIND_POWERKEY_CONF }),
			`cat > ${LOGIND_POWERKEY_STAGING}`,
		);
		const installPowerkey = `install -D -m 644 ${LOGIND_POWERKEY_STAGING} ${LOGIND_POWERKEY_DEST}`;
		must(await sudo(installPowerkey), installPowerkey);

		// ---- (f) bootCommands as Omarchy's own post-boot hook; EMPTY means SKIP — no
		// empty hook file for a future boot to execute. The rewrite is identical bytes. ----
		if (config.bootCommands.length > 0) {
			await exec("mkdir -p ~/.config/omarchy/hooks/post-boot.d");
			must(
				await exec(`cat > ${BOOT_HOOK_PATH}`, { stdin: bootHookScript(config.bootCommands) }),
				`cat > ${BOOT_HOOK_PATH}`,
			);
			must(await exec(`chmod +x ${BOOT_HOOK_PATH}`), `chmod +x ${BOOT_HOOK_PATH}`);
		} else {
			stepLines.push("bootCommands empty — hook step skipped");
			log("provision: bootCommands empty — no boot hook written");
		}

		// ---- (g) the dir only: `~/.openhammer/env` itself is spec 29's session-start
		// secret push — creating the dir now keeps the rc line's own guard cheap. ----
		await exec("mkdir -p ~/.openhammer");

		// ---- (h) host-key capture: THE pin source — future pinned sessions verify
		// against this file (spec 26). The installed system's keys are stable across
		// boots, so a rerun rewrites the same bytes. ----
		const keyscanFn =
			deps.keyscan ?? ((port: number) => runBinDefault("ssh-keyscan", ["-p", String(port), "127.0.0.1"]));
		const scanned = await keyscanFn(hostPort);
		stepLines.push(`ssh-keyscan -p ${hostPort} 127.0.0.1 → rc ${scanned.code}`);
		log(`provision: ssh-keyscan -p ${hostPort} 127.0.0.1 → rc ${scanned.code}`);
		if (scanned.code !== 0) {
			throw new Error(
				`vm provision: ssh-keyscan exited ${scanned.code ?? "spawn error"}: ${scanned.stderrTail.trim()} — ${evidence()}`,
			);
		}
		if (keyscanKeyLines(scanned.stdoutTail).length === 0) {
			throw new Error(
				`vm provision: ssh-keyscan captured no host keys for 127.0.0.1:${hostPort} — ` +
					`an empty pin would fail every future pinned session — ${evidence()}`,
			);
		}
		writeFileSync(knownHostsPath, scanned.stdoutTail, { mode: 0o600 });
		chmodSync(knownHostsPath, 0o600); // writeFileSync mode only applies at creation
		log(`provision: host key captured → ${knownHostsPath} (0600)`);

		// ---- (i) agent pre-warm: resolve the mise stub once so the first real invocation
		// does not pay the stub setup — the `--version` run IS the mise install (22e's
		// first-launch growth). BASE flavor: BEST-EFFORT, exactly 26d's pass — full cache
		// warming (the measured ~206 MB) is the operator's provision.sh territory. AGENT
		// flavor (spec 29): the pre-warm is the one behavior the flavor adds, so it is
		// ASSERTED — a non-zero rc fails the pass (an agent golden whose binary does not
		// resolve is not an agent golden), before the operator's provision.sh runs. ----
		const prewarmVersion = `~/.local/bin/${config.agent} --version`;
		const prewarmCommand = flavor === "agent" ? prewarmVersion : `${prewarmVersion} || true`;
		const prewarmed = await exec(prewarmCommand);
		if (flavor === "agent" && prewarmed.code !== 0) {
			throw new Error(
				`vm provision: agent-flavor pre-warm failed: '${prewarmVersion}' exited ` +
					`${prewarmed.code ?? "spawn error"}: ${prewarmed.stderrTail.trim()} — the agent golden must ` +
					`resolve ${config.agent} — ${evidence()} — rerun \`openhammer vm provision\` (idempotent)`,
			);
		}
		agentPrewarm =
			prewarmed.code === 0
				? `'${prewarmCommand}' exited 0 (${prewarmed.stdoutTail.trim().split(/\r?\n/)[0] ?? ""})` +
					(flavor === "agent" ? " — asserted (agent flavor)" : "")
				: `'${prewarmCommand}' exited ${prewarmed.code} (best-effort, logged): ${prewarmed.stderrTail.trim()}`;

		// ---- (j) the operator's provision.sh: streamed to the guest and run with bash;
		// NON-ZERO = provision FAILURE — the operator's script is authoritative. ----
		const scriptPath = join(dirs.root, PROVISION_SCRIPT);
		if (existsSync(scriptPath)) {
			let script: string;
			try {
				script = readFileSync(scriptPath, "utf8");
			} catch (error) {
				throw new Error(
					`vm provision: cannot read ${scriptPath}: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			must(
				await exec("cat > /tmp/openhammer-provision.sh", { stdin: script }),
				"cat > /tmp/openhammer-provision.sh",
			);
			const ran = await exec("bash /tmp/openhammer-provision.sh");
			const output = `${ran.stdoutTail}${ran.stderrTail}`.trim();
			if (output !== "") {
				log(`provision: provision.sh output: ${output}`);
			}
			stepLines.push(`provision.sh exited ${ran.code}${output === "" ? "" : `: ${output}`}`);
			if (ran.code !== 0) {
				throw new Error(
					`vm provision: provision.sh exited ${ran.code ?? "spawn error"} (the operator's script is ` +
						`authoritative): ${ran.stderrTail.trim() || ran.stdoutTail.trim()} — ${evidence()}`,
				);
			}
		} else {
			stepLines.push(`no ${PROVISION_SCRIPT} at ${scriptPath} — escape hatch skipped`);
			log(`provision: no ${PROVISION_SCRIPT} — escape hatch skipped`);
		}

		// ---- verify: the spec's manual gate, in-pass. `test -f ~/.openhammer/env` is
		// DELIBERATELY absent — spec 29 pushes secrets at session start, so it is allowed
		// to be false here. Any failed check throws naming what missed. ----
		const addCheck = (name: string, ok: boolean, detail: string): void => {
			checks.push({ name, ok, detail });
			log(`provision: check ${name}: ${ok ? "ok" : "FAILED"} — ${detail}`);
		};
		for (const bin of ["rg", "fd", "tmux"]) {
			const found = await exec(`command -v ${bin}`);
			const path = found.stdoutTail.trim();
			addCheck(
				bin,
				found.code === 0 && path !== "",
				found.code === 0 ? path : `command -v ${bin} exited ${found.code}`,
			);
		}
		const agentGet = await exec("omarchy default agent");
		const printed = agentGet.stdoutTail.trim();
		addCheck(
			"default-agent",
			printed === config.agent,
			`omarchy default agent printed "${printed}" (want "${config.agent}")`,
		);
		if (config.bootCommands.length > 0) {
			const executable = await exec(`test -x ${BOOT_HOOK_PATH}`);
			addCheck("hook-executable", executable.code === 0, `test -x ${BOOT_HOOK_PATH} exited ${executable.code}`);
		}
		for (const rcFile of RC_FILES) {
			const present = await exec(`grep -q openhammer/env ~/${rcFile}`);
			addCheck(
				`${rcFile}-env-line`,
				present.code === 0,
				`grep -q openhammer/env ~/${rcFile} exited ${present.code}`,
			);
		}
		const powerkey = await exec(`grep -q HandlePowerKey=poweroff ${LOGIND_POWERKEY_DEST}`);
		addCheck(
			"powerkey-dropin",
			powerkey.code === 0,
			`grep -q HandlePowerKey=poweroff ${LOGIND_POWERKEY_DEST} exited ${powerkey.code}`,
		);
		const failed = checks.filter((check) => !check.ok);
		if (failed.length > 0) {
			throw new Error(
				`vm provision: verify failed: ${failed.map((c) => `${c.name} (${c.detail})`).join("; ")} — ` +
					`${evidence()} — rerun \`openhammer vm provision\` (the pass is idempotent)`,
			);
		}
	} catch (error) {
		phaseError = error;
	}

	// ---- teardown: clean guest poweroff first (the module header's rule — this boot
	// writes the real disk), the ladder only as the fallback, capture before any kill. ----
	const wallClockSeconds = (now() - startedAt) / 1000;
	let shutdownPath = "not attempted";
	let shutdownDetail = "";
	try {
		if (ready && hostPort !== undefined) {
			const poweroff = await exec("sudo -S -p '' systemctl poweroff", { stdin: `${password}\n` });
			// rc is recorded, not trusted: poweroff DROPS the connection mid-command (ssh
			// exits 255) — the exit-wait below is the truth.
			shutdownDetail = `ssh sudo systemctl poweroff rc=${poweroff.code} ${poweroff.stderrTail.trim()}`;
		}
		if (await waitQemuExit(handle, now, sleep)) {
			shutdownPath = "guest-poweroff";
		} else {
			try {
				await captureOnTeardown({ serialPath, debugDir }, handle);
			} catch (error) {
				log(
					`provision: debug capture failed (continuing to the stop ladder): ` +
						`${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const stopQemuFn = deps.stopQemu ?? ((h: QemuHandle, o?: StopQemuOptions) => stopQemuReal(h, o));
			const ladder = await stopQemuFn(handle);
			shutdownPath = ladder.path;
			shutdownDetail = `${shutdownDetail} ${ladder.detail}`.trim();
		}
		log(`provision: shutdown path ${shutdownPath}`);
	} catch (error) {
		// Never mask the phase error with a teardown error — but surface it when it IS the story.
		if (phaseError === undefined) {
			phaseError = error;
		} else {
			log(`provision: teardown error swallowed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (shutdownPath === "sigkill" && phaseError === undefined) {
		phaseError = new Error(
			`vm provision: qemu only died to SIGKILL — the disk cannot be trusted as a golden (rerun vm provision) — ${evidence()}`,
		);
	}

	const logLines = [
		`# ${sessionName} (direct boot of ${sessionDir})`,
		`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
		`flavor: ${flavor}`,
		`guest user: ${config.username}  agent: ${config.agent}  bootCommands: ${config.bootCommands.length}`,
		`argv: ${JSON.stringify(argv)}`,
		...sshEvents.map((line) => `ssh| ${line}`),
		...stepLines.map((line) => `step| ${line}`),
		`known_hosts: ${knownHostsPath} (${statSync(knownHostsPath, { throwIfNoEntry: false })?.size ?? "not written"} bytes)`,
		`agent prewarm: ${agentPrewarm}`,
		...checks.map((check) => `check| ${check.name}: ${check.ok ? "ok" : "FAILED"} — ${check.detail}`),
		`shutdown: ${shutdownPath} (${shutdownDetail || "clean"})`,
		`qemu.stderr tail: ${(await handle.stderrTail()).trim()}`,
		`result: ${phaseError === undefined ? "PASS" : "FAIL"}`,
	];
	writeFileSync(runLogPath, `${logLines.join("\n")}\n`);
	log(`provision: run log ${runLogPath}`);

	if (phaseError !== undefined) {
		throw phaseError;
	}
	log(
		`provision: pass complete — wall-clock ${wallClockSeconds.toFixed(1)} s, ${checks.length} checks passed, ` +
			`host key pinned at ${knownHostsPath}; session left intact at ${sessionDir}`,
	);
	return { sessionDir, wallClockSeconds, checks, agentPrewarm, flavor };
}
