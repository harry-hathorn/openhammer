import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { qemuBootArgs } from "../qemu/args.ts";
import type { QemuExit, QemuHandle } from "../qemu/process.ts";
import type { QmpClient } from "../qmp/client.ts";
import { resolveVmDirs } from "../session.ts";
import type { BinRunResult } from "./cidata.ts";
import { defaultGuestConfig, saveGuestConfig } from "./guest-config.ts";
import type { ActiveSession } from "./install.ts";
import {
	AGENT_DEFAULTS_PATH,
	BOOT_HOOK_PATH,
	LOGIND_POWERKEY_CONF,
	LOGIND_POWERKEY_DEST,
	type ProvisionDeps,
	type ProvisionExec,
	runProvision,
} from "./provision.ts";

const PORT = 41733;
const PASSWORD = "test-recovery-password";
const HOST_KEY = `[127.0.0.1]:${PORT} ssh-ed25519 AAAAFAKEOPENHAMMERTESTKEY== fake\n`;
const SESSION = "build-2026-09-09T07-18-29-884Z";
const OLDER_SESSION = "build-2026-09-09T06-00-00-000Z";
const ENV_LINE = "[ -f ~/.openhammer/env ] && . ~/.openhammer/env";

/** One guest-side call, as the exec seam sees it. */
interface GuestCall {
	readonly command: string;
	readonly stdin?: string;
}

/** The per-test guest behavior knobs; every default produces the full happy path. */
interface GuestOptions {
	/** The pacman step "succeeds" but ripgrep never lands → the rg verify check fails. */
	readonly skipRipgrep?: boolean;
	/** The `bash /tmp/openhammer-provision.sh` outcome (default: rc 0 with output). */
	readonly scriptResult?: BinRunResult;
}

/**
 * A STATEFUL fake guest: a tiny filesystem (path → content), an executable-bit set, and an
 * installed-package set — the grep guards, `cat >`/`cat >>` writes, `command -v` lookups,
 * `omarchy default agent` (the getter reads the file), and `test -x` all consult it, so a
 * second provision run over the same fake exercises the REAL idempotency semantics. Any
 * command the pass did not author is an error — the exact-command contract, enforced.
 */
function statefulGuest(options: GuestOptions = {}) {
	const files = new Map<string, string>();
	const executable = new Set<string>();
	const installed = new Set<string>();
	const calls: GuestCall[] = [];
	const poweroffHolder: { current?: QemuExit } = { current: undefined };

	const exec: ProvisionExec = async (command, opts) => {
		calls.push({ command, stdin: opts?.stdin });
		const stdin = opts?.stdin ?? "";
		const ok = (stdoutTail = ""): BinRunResult => ({ code: 0, stdoutTail, stderrTail: "" });
		const miss = (stderrTail = ""): BinRunResult => ({ code: 1, stdoutTail: "", stderrTail });
		if (command === "true") return ok();
		if (command === "sudo -S -p '' systemctl poweroff") {
			poweroffHolder.current = { code: 0, signal: null }; // the guest powers off when told
			return ok();
		}
		if (command === "sudo -S -p '' pacman -Sy --needed --noconfirm ripgrep fd tmux") {
			if (!options.skipRipgrep) installed.add("ripgrep");
			installed.add("fd");
			installed.add("tmux");
			return ok();
		}
		const cat = /^cat (>>|>) (.+)$/.exec(command);
		if (cat !== null) {
			const path = cat[2] ?? "";
			files.set(path, cat[1] === ">>" ? `${files.get(path) ?? ""}${stdin}` : stdin);
			return ok();
		}
		if (
			command ===
			"sudo -S -p '' install -D -m 644 /tmp/openhammer-sddm-autologin.conf /etc/sddm.conf.d/99-openhammer-autologin.conf"
		) {
			const staged = files.get("/tmp/openhammer-sddm-autologin.conf");
			if (staged === undefined) return miss("staging file missing");
			files.set("/etc/sddm.conf.d/99-openhammer-autologin.conf", staged);
			return ok();
		}
		if (command === `sudo -S -p '' install -D -m 644 /tmp/openhammer-logind-powerkey.conf ${LOGIND_POWERKEY_DEST}`) {
			const staged = files.get("/tmp/openhammer-logind-powerkey.conf");
			if (staged === undefined) return miss("staging file missing");
			files.set(LOGIND_POWERKEY_DEST, staged);
			return ok();
		}
		if (command === "sudo -S -p '' sh -c 'groupadd -f autologin && usermod -aG autologin sandbox'") return ok();
		if (command === "sudo -S -p '' systemctl restart sddm.service") return ok();
		if (command.startsWith("mkdir -p ~/")) return ok();
		const grep = /^grep -q openhammer\/env (~\/\.(?:bash|zsh)rc)$/.exec(command);
		if (grep !== null) {
			return (files.get(grep[1] ?? "") ?? "").includes("openhammer/env") ? ok() : miss();
		}
		if (command === `grep -q HandlePowerKey=poweroff ${LOGIND_POWERKEY_DEST}`) {
			return (files.get(LOGIND_POWERKEY_DEST) ?? "").includes("HandlePowerKey=poweroff") ? ok() : miss();
		}
		if (command === `chmod +x ${BOOT_HOOK_PATH}`) {
			executable.add(BOOT_HOOK_PATH);
			return ok();
		}
		if (command === "~/.local/bin/claude --version || true") return ok("1.0.99");
		const which = /^command -v (rg|fd|tmux)$/.exec(command);
		if (which !== null) {
			const bin = which[1] ?? "";
			return installed.has(bin === "rg" ? "ripgrep" : bin) ? ok(`/usr/bin/${bin}`) : miss(`no ${bin}`);
		}
		if (command === "omarchy default agent") return ok(files.get(AGENT_DEFAULTS_PATH) ?? "");
		if (command === `test -x ${BOOT_HOOK_PATH}`) return executable.has(BOOT_HOOK_PATH) ? ok() : miss();
		if (command === "bash /tmp/openhammer-provision.sh") {
			return options.scriptResult ?? ok("custom-provision-output");
		}
		throw new Error(`test guest: unexpected command: ${JSON.stringify(command)}`);
	};
	return { exec, calls, files, poweroffHolder };
}

/** The per-test harness knobs; every default produces the full happy path. */
interface HarnessOptions {
	readonly guest?: GuestOptions;
	/** guest-config's bootCommands (default: two lines, so the hook step runs). */
	readonly bootCommands?: readonly string[];
	/** The single-flight scan result (default: no active sessions). */
	readonly scan?: ActiveSession[];
	/** Seed NO install session at all (default: one complete session). */
	readonly noSession?: boolean;
	/** Seed the newest session WITHOUT the recovery password file. */
	readonly incomplete?: boolean;
	/** Seed an older complete session too (the "most recent complete" pick). */
	readonly olderSession?: boolean;
	/** The keyscan result's stdout (default: one host-key line). */
	readonly keyscanStdout?: string;
}

/**
 * The full fake provision world: every external seam injected, a fake clock that only
 * moves when the runner sleeps, and the stateful guest above. ZERO real binaries/network.
 */
function harness(options: HarnessOptions = {}) {
	const home = mkdtempSync(join(tmpdir(), "openhammer-provision-"));
	const dirs = resolveVmDirs({ homeDir: home });
	const logs: string[] = [];
	const clock = { now: 1_700_000_000_000 };
	const guest = statefulGuest(options.guest ?? {});
	const keyscanPorts: number[] = [];
	const stopCalls: QemuHandle[] = [];
	let qemuArgv: readonly string[] | undefined;
	let qemuStderrPath: string | undefined;

	saveGuestConfig(dirs, {
		...defaultGuestConfig(),
		bootCommands: options.bootCommands ?? ["echo one", "echo two"],
	});

	const sessionDir = join(dirs.sessions, SESSION);
	if (!options.noSession) {
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "disk.qcow2"), "fake-installed-disk");
		writeFileSync(join(sessionDir, "OVMF_VARS.4m.fd"), "fake-vars");
		if (!options.incomplete) {
			writeFileSync(join(sessionDir, "luks-or-sudo-password.txt"), `${PASSWORD}\n`, { mode: 0o600 });
		}
	}
	if (options.olderSession) {
		const older = join(dirs.sessions, OLDER_SESSION);
		mkdirSync(older, { recursive: true });
		writeFileSync(join(older, "disk.qcow2"), "older-disk");
		writeFileSync(join(older, "OVMF_VARS.4m.fd"), "older-vars");
		writeFileSync(join(older, "luks-or-sudo-password.txt"), "older-password\n", { mode: 0o600 });
	}

	const qmp: QmpClient = {
		greetingLine: '{"QMP": {"version": {"qemu": {"major": 11}}}}',
		capabilitiesReturn: {},
		execute: async () => ({}),
		humanMonitorCommand: async () => "",
		close: () => {},
		closed: new Promise<string>(() => {}),
	};
	const handle: QemuHandle = {
		pid: 424242,
		qmp,
		exited: new Promise<QemuExit>(() => {}),
		exitInfo: () => guest.poweroffHolder.current,
		kill: () => true,
		stderrTail: async () => "fake-qemu-stderr-tail",
	};

	const deps: ProvisionDeps = {
		homeDir: home,
		log: (line) => logs.push(line),
		now: () => clock.now,
		sleep: async (ms) => {
			clock.now += ms;
		},
		scanActiveSessions: async () => options.scan ?? [],
		discoverSshPort: async () => PORT,
		exec: guest.exec,
		keyscan: async (port) => {
			keyscanPorts.push(port);
			return { code: 0, stdoutTail: options.keyscanStdout ?? HOST_KEY, stderrTail: "" };
		},
		startQemu: async (argv, opts) => {
			qemuArgv = [...argv];
			qemuStderrPath = opts.stderrPath;
			return handle;
		},
		stopQemu: async (h) => {
			stopCalls.push(h);
			return { path: "quit", detail: "fake ladder" };
		},
	};

	return {
		home,
		dirs,
		deps,
		logs,
		clock,
		guest,
		keyscanPorts,
		stopCalls,
		sessionDir,
		cleanup: () => rmSync(home, { recursive: true, force: true }),
		qemuArgv: () => qemuArgv,
		qemuStderrPath: () => qemuStderrPath,
	};
}

/** The full expected (command, stdin) sequence of the happy pass, two bootCommands set. */
function happyCalls(password: string): Array<readonly [string, string | undefined]> {
	const sudoStdin = `${password}\n`;
	return [
		["true", undefined],
		["true", undefined],
		["sudo -S -p '' pacman -Sy --needed --noconfirm ripgrep fd tmux", sudoStdin],
		["cat > /tmp/openhammer-sddm-autologin.conf", "[Autologin]\nUser=sandbox\nSession=hyprland\n"],
		[
			"sudo -S -p '' install -D -m 644 /tmp/openhammer-sddm-autologin.conf /etc/sddm.conf.d/99-openhammer-autologin.conf",
			sudoStdin,
		],
		["sudo -S -p '' sh -c 'groupadd -f autologin && usermod -aG autologin sandbox'", sudoStdin],
		["sudo -S -p '' systemctl restart sddm.service", sudoStdin],
		["mkdir -p ~/.config/omarchy/defaults", undefined],
		["cat > ~/.config/omarchy/defaults/agent", "claude\n"],
		["grep -q openhammer/env ~/.bashrc", undefined],
		["cat >> ~/.bashrc", `${ENV_LINE}\n`],
		["grep -q openhammer/env ~/.zshrc", undefined],
		["cat >> ~/.zshrc", `${ENV_LINE}\n`],
		["cat > /tmp/openhammer-logind-powerkey.conf", LOGIND_POWERKEY_CONF],
		[
			"sudo -S -p '' install -D -m 644 /tmp/openhammer-logind-powerkey.conf /etc/systemd/logind.conf.d/99-openhammer-powerkey.conf",
			sudoStdin,
		],
		["mkdir -p ~/.config/omarchy/hooks/post-boot.d", undefined],
		["cat > ~/.config/omarchy/hooks/post-boot.d/openhammer.sh", "#!/bin/bash\necho one\necho two\n"],
		["chmod +x ~/.config/omarchy/hooks/post-boot.d/openhammer.sh", undefined],
		["mkdir -p ~/.openhammer", undefined],
		["~/.local/bin/claude --version || true", undefined],
		["command -v rg", undefined],
		["command -v fd", undefined],
		["command -v tmux", undefined],
		["omarchy default agent", undefined],
		["test -x ~/.config/omarchy/hooks/post-boot.d/openhammer.sh", undefined],
		["grep -q openhammer/env ~/.bashrc", undefined],
		["grep -q openhammer/env ~/.zshrc", undefined],
		[`grep -q HandlePowerKey=poweroff ${LOGIND_POWERKEY_DEST}`, undefined],
		["sudo -S -p '' systemctl poweroff", sudoStdin],
	];
}

describe("runProvision — happy path", () => {
	it("runs the full ordered pass with exact commands, stdins, checks, and a clean poweroff", async () => {
		const h = harness();
		try {
			const result = await runProvision(h.deps);
			expect(result.sessionDir).toBe(h.sessionDir);
			expect(result.wallClockSeconds).toBe(10); // the one sleep: the 10 s confirm gap
			expect(result.agentPrewarm).toBe("'~/.local/bin/claude --version || true' exited 0 (1.0.99)");
			// The exact ordered (command, stdin) sequence — every step, in pass order.
			expect(h.guest.calls.map((call) => [call.command, call.stdin] as const)).toEqual(happyCalls(PASSWORD));
			// The direct boot: the session-boot disk shape pointed at the install disk, with
			// the provision boot's OWN serial path (the install evidence survives).
			expect(h.qemuArgv()).toEqual(
				qemuBootArgs({
					name: SESSION,
					sessionDir: h.sessionDir,
					serialPath: join(h.sessionDir, "provision-serial.log"),
					disks: { overlayPath: join(h.sessionDir, "disk.qcow2") },
				}),
			);
			expect(h.qemuStderrPath()).toBe(join(h.sessionDir, "provision-qemu.stderr"));
			// Every verify check passed, in run order.
			expect(result.checks).toEqual([
				{ name: "rg", ok: true, detail: "/usr/bin/rg" },
				{ name: "fd", ok: true, detail: "/usr/bin/fd" },
				{ name: "tmux", ok: true, detail: "/usr/bin/tmux" },
				{ name: "default-agent", ok: true, detail: 'omarchy default agent printed "claude" (want "claude")' },
				{
					name: "hook-executable",
					ok: true,
					detail: "test -x ~/.config/omarchy/hooks/post-boot.d/openhammer.sh exited 0",
				},
				{ name: ".bashrc-env-line", ok: true, detail: "grep -q openhammer/env ~/.bashrc exited 0" },
				{ name: ".zshrc-env-line", ok: true, detail: "grep -q openhammer/env ~/.zshrc exited 0" },
				{
					name: "powerkey-dropin",
					ok: true,
					detail:
						"grep -q HandlePowerKey=poweroff /etc/systemd/logind.conf.d/99-openhammer-powerkey.conf exited 0",
				},
			]);
			// The logind power-key drop-in landed in the fake guest exactly (27k: QMP
			// system_powerdown must reach a real poweroff in every later session boot).
			expect(h.guest.files.get(LOGIND_POWERKEY_DEST)).toBe(LOGIND_POWERKEY_CONF);
			// Teardown: clean guest poweroff, no stop ladder.
			expect(h.stopCalls).toEqual([]);
			expect(h.guest.calls.at(-1)?.command).toBe("sudo -S -p '' systemctl poweroff");
			// The SDDM conf + agent file landed in the fake guest exactly.
			expect(h.guest.files.get("/etc/sddm.conf.d/99-openhammer-autologin.conf")).toBe(
				"[Autologin]\nUser=sandbox\nSession=hyprland\n",
			);
			expect(h.guest.files.get(AGENT_DEFAULTS_PATH)).toBe("claude\n");
			// The run log records the pass.
			const runLog = readFileSync(join(h.sessionDir, "provision.log"), "utf8");
			expect(runLog).toContain(`# ${SESSION} (direct boot of ${h.sessionDir})`);
			expect(runLog).toContain("result: PASS");
			expect(runLog).toContain(
				`step| sudo -S -p '' pacman -Sy --needed --noconfirm ripgrep fd tmux ` +
					`[${`${PASSWORD}\n`.length} B stdin] → rc 0`,
			);
			expect(runLog).toContain("shutdown: guest-poweroff");
		} finally {
			h.cleanup();
		}
	});

	it("captures the host key: keyscan over the discovered port, written 0600", async () => {
		const h = harness();
		try {
			await runProvision(h.deps);
			expect(h.keyscanPorts).toEqual([PORT]);
			const knownHosts = join(h.sessionDir, "known_hosts");
			expect(readFileSync(knownHosts, "utf8")).toBe(HOST_KEY);
			expect(statSync(knownHosts).mode & 0o777).toBe(0o600);
			expect(h.logs.some((line) => line.includes(`host key captured → ${knownHosts} (0600)`))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("picks the most recent COMPLETE build-* session (an incomplete newer one is skipped)", async () => {
		const h = harness({ olderSession: true, incomplete: true });
		try {
			const result = await runProvision(h.deps);
			// SESSION is newest but lacks the recovery password → OLDER_SESSION is the pick.
			expect(result.sessionDir).toBe(join(h.dirs.sessions, OLDER_SESSION));
		} finally {
			h.cleanup();
		}
	});

	it("an explicit sessionName provisions that session", async () => {
		const h = harness({ olderSession: true });
		try {
			const result = await runProvision(h.deps, { sessionName: OLDER_SESSION });
			expect(result.sessionDir).toBe(join(h.dirs.sessions, OLDER_SESSION));
		} finally {
			h.cleanup();
		}
	});
});

describe("runProvision — idempotency (the rerun story)", () => {
	it("a second run leaves the rc lines single, reruns pacman with --needed, rewrites the identical hook", async () => {
		const h = harness();
		try {
			await runProvision(h.deps);
			const afterFirst = h.guest.calls.length;
			h.guest.poweroffHolder.current = undefined; // a fresh boot of the same disk
			const result2 = await runProvision(h.deps);
			const secondCommands = h.guest.calls.slice(afterFirst).map((call) => call.command);

			// The rc-line append steps became no-ops via the grep guard — greps answer 0.
			expect(secondCommands).toContain("grep -q openhammer/env ~/.bashrc");
			expect(secondCommands).toContain("grep -q openhammer/env ~/.zshrc");
			expect(secondCommands).not.toContain("cat >> ~/.bashrc");
			expect(secondCommands).not.toContain("cat >> ~/.zshrc");
			// Each rc file carries the source line exactly ONCE across both runs.
			for (const rc of ["~/.bashrc", "~/.zshrc"]) {
				const content = h.guest.files.get(rc) ?? "";
				expect(content.split(ENV_LINE).length - 1).toBe(1);
			}
			// Packages still run, same -Sy form (-y + --needed are the idempotency, not
			// skipping the step).
			expect(secondCommands).toContain("sudo -S -p '' pacman -Sy --needed --noconfirm ripgrep fd tmux");
			// The hook rewrite is identical bytes, re-chmodded.
			expect(h.guest.files.get(BOOT_HOOK_PATH)).toBe("#!/bin/bash\necho one\necho two\n");
			expect(secondCommands).toContain(`cat > ${BOOT_HOOK_PATH}`);
			expect(secondCommands).toContain(`chmod +x ${BOOT_HOOK_PATH}`);
			// And the second run still verifies + powers off cleanly.
			expect(result2.checks.every((check) => check.ok)).toBe(true);
			expect(secondCommands.at(-1)).toBe("sudo -S -p '' systemctl poweroff");
		} finally {
			h.cleanup();
		}
	});
});

describe("runProvision — bootCommands variants", () => {
	it("empty bootCommands → no hook step at all and no hook verify check", async () => {
		const h = harness({ bootCommands: [] });
		try {
			const result = await runProvision(h.deps);
			const commands = h.guest.calls.map((call) => call.command);
			expect(commands.some((command) => command.includes("post-boot.d"))).toBe(false);
			expect(h.logs.some((line) => line.includes("bootCommands empty — no boot hook written"))).toBe(true);
			expect(result.checks.map((check) => check.name)).toEqual([
				"rg",
				"fd",
				"tmux",
				"default-agent",
				".bashrc-env-line",
				".zshrc-env-line",
				"powerkey-dropin",
			]);
		} finally {
			h.cleanup();
		}
	});

	it("bootCommands present → an exact executable bash hook", async () => {
		const h = harness({ bootCommands: ["systemctl --user start foo", "echo done"] });
		try {
			await runProvision(h.deps);
			expect(h.guest.files.get(BOOT_HOOK_PATH)).toBe("#!/bin/bash\nsystemctl --user start foo\necho done\n");
		} finally {
			h.cleanup();
		}
	});
});

describe("runProvision — provision.sh escape hatch", () => {
	it("absent → skipped (logged, no guest commands)", async () => {
		const h = harness();
		try {
			await runProvision(h.deps);
			const commands = h.guest.calls.map((call) => call.command);
			expect(commands).not.toContain("cat > /tmp/openhammer-provision.sh");
			expect(commands).not.toContain("bash /tmp/openhammer-provision.sh");
			expect(h.logs.some((line) => line.includes("no provision.sh — escape hatch skipped"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("present → streamed verbatim and run with bash after the pre-warm, before verify; output logged", async () => {
		const h = harness();
		try {
			const script = "#!/bin/bash\necho custom step\n";
			writeFileSync(join(h.dirs.root, "provision.sh"), script);
			await runProvision(h.deps);
			const commands = h.guest.calls.map((call) => call.command);
			const streamed = commands.indexOf("cat > /tmp/openhammer-provision.sh");
			const ran = commands.indexOf("bash /tmp/openhammer-provision.sh");
			const prewarm = commands.indexOf("~/.local/bin/claude --version || true");
			const verify = commands.indexOf("command -v rg");
			expect(h.guest.calls[streamed]?.stdin).toBe(script);
			expect(ran).toBeGreaterThan(prewarm);
			expect(verify).toBeGreaterThan(ran);
			expect(h.logs.some((line) => line.includes("provision.sh output: custom-provision-output"))).toBe(true);
		} finally {
			h.cleanup();
		}
	});

	it("a failing script is a provision failure — and teardown still powers the guest off", async () => {
		const h = harness({
			guest: { scriptResult: { code: 3, stdoutTail: "partial work", stderrTail: "boom" } },
		});
		try {
			writeFileSync(join(h.dirs.root, "provision.sh"), "#!/bin/bash\nexit 3\n");
			await expect(runProvision(h.deps)).rejects.toThrow(/provision\.sh exited 3.*boom/s);
			// The guest was still cleanly powered off (no leaked QEMU, no ladder).
			expect(h.guest.calls.at(-1)?.command).toBe("sudo -S -p '' systemctl poweroff");
			expect(h.stopCalls).toEqual([]);
			const runLog = readFileSync(join(h.sessionDir, "provision.log"), "utf8");
			expect(runLog).toContain("result: FAIL");
		} finally {
			h.cleanup();
		}
	});
});

describe("runProvision — verify + failure paths", () => {
	it("a failed check throws the actionable error naming what missed (rg)", async () => {
		const h = harness({ guest: { skipRipgrep: true } });
		try {
			await expect(runProvision(h.deps)).rejects.toThrow(
				/vm provision: verify failed: rg \(command -v rg exited 1\)/,
			);
			// The failed run still recorded the failing check in the run log.
			const runLog = readFileSync(join(h.sessionDir, "provision.log"), "utf8");
			expect(runLog).toContain("check| rg: FAILED — command -v rg exited 1");
		} finally {
			h.cleanup();
		}
	});

	it("a keyscan that captures no keys refuses to write an empty pin", async () => {
		const h = harness({ keyscanStdout: "# 127.0.0.1:41733 SSH-2.0-OpenSSH_10.0\n" });
		try {
			await expect(runProvision(h.deps)).rejects.toThrow(
				"vm provision: ssh-keyscan captured no host keys for 127.0.0.1:41733",
			);
			expect(existsSync(join(h.sessionDir, "known_hosts"))).toBe(false);
		} finally {
			h.cleanup();
		}
	});

	it("refuses before ANY side effect when a session is active (single-flight)", async () => {
		const live: ActiveSession = { sessionDir: "/home/x/.openhammer/vm/sessions/live-one", pid: 999 };
		const h = harness({ scan: [live] });
		try {
			await expect(runProvision(h.deps)).rejects.toThrow(
				"vm provision: a VM session is active — stop it first (openhammer vm status) — " +
					"/home/x/.openhammer/vm/sessions/live-one holds qemu pid 999",
			);
			expect(h.qemuArgv()).toBeUndefined(); // nothing booted
			expect(h.guest.calls).toEqual([]); // nothing executed
		} finally {
			h.cleanup();
		}
	});

	it("no install session → the actionable install-first error", async () => {
		const h = harness({ noSession: true });
		try {
			await expect(runProvision(h.deps)).rejects.toThrow(
				`vm provision: no complete install session to provision — ${join(h.dirs.sessions, "build-")} ` +
					`is missing disk.qcow2 — run \`openhammer vm install\` first`,
			);
			expect(h.qemuArgv()).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});

	it("an incomplete install session names the missing file", async () => {
		const h = harness({ incomplete: true });
		try {
			await expect(runProvision(h.deps)).rejects.toThrow(
				`is missing luks-or-sudo-password.txt — run \`openhammer vm install\` first`,
			);
		} finally {
			h.cleanup();
		}
	});

	it("ssh never answering fails the gate and falls back to the stop ladder (error-path teardown)", async () => {
		const guest = statefulGuest();
		const failingTrue: ProvisionExec = async (command, opts) => {
			if (command === "true") return { code: 255, stdoutTail: "", stderrTail: "Connection refused" };
			return guest.exec(command, opts);
		};
		const h = harness();
		h.deps = { ...h.deps, exec: failingTrue };
		try {
			await expect(runProvision(h.deps, { budgetMinutes: 1 })).rejects.toThrow(
				/no ssh gate within the 1 min budget \(port 41733, last ssh exit 255\)/,
			);
			// Poweroff was never sent (never ready) → the ladder ran as the fallback.
			expect(h.guest.calls.map((call) => call.command)).toEqual([]);
			expect(h.stopCalls).toHaveLength(1);
			const runLog = readFileSync(join(h.sessionDir, "provision.log"), "utf8");
			expect(runLog).toContain("shutdown: quit");
		} finally {
			h.cleanup();
		}
	});

	it("a budgetMinutes of 0 or NaN is refused up front", async () => {
		const h = harness();
		try {
			await expect(runProvision(h.deps, { budgetMinutes: 0 })).rejects.toThrow(
				"vm provision: budgetMinutes must be a positive number (got 0)",
			);
			await expect(runProvision(h.deps, { budgetMinutes: Number.NaN })).rejects.toThrow(
				"vm provision: budgetMinutes must be a positive number (got NaN)",
			);
			expect(h.qemuArgv()).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});

	it("an unsafe session name is refused before anything runs", async () => {
		const h = harness();
		try {
			await expect(runProvision(h.deps, { sessionName: "../evil" })).rejects.toThrow(
				"vm provision: session name is not a safe path segment",
			);
			expect(h.qemuArgv()).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});
