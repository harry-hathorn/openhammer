// Probes runner: `SPIKE_DIR=... npx tsx scripts/vm-spike/probes.ts [--install-session <path>]
// [--agent-budget-seconds 1200] [--mux-samples 20]`
// Spec 22 gates 4 + 5 + 7 (gate 8's usernet row comes along as the port source — it is
// already proven by 22b/22c/22d; this run re-records a fourth row). ONE overlay boot of the
// golden under the headless recipe (the 22c winner), every gate measured over ssh inside
// that single session:
//   (4) env dual-injection: OH_SPIKE_TEST written to ~/.openhammer/env (+ a source line in
//       BOTH ~/.zshrc and ~/.bashrc — run #1 measured the cidata guest's shell as BASH with
//       zsh not even installed, so the bashrc line is the load-bearing one and the zshrc
//       line is belt-and-braces for images that do ship zsh) AND
//       ~/.config/environment.d/openhammer.conf, verified in the three consumption
//       contexts — the interactive shell (whichever exists), the prefixed-exec runShell
//       shape, and the user's systemd manager. environment.d is only parsed when the user
//       manager STARTS, so the third context needs a REAL guest reboot mid-run (safe: the
//       overlay absorbs it); the pre-reboot `show-environment` is the negative control.
//   (5) `omarchy agent prompt` headless: version/commands/default-agent recon, then the
//       flag shape the subcommand's own --help documents, run with NO credentials in the
//       guest. Run #1 measured the unprovisioned launcher failing FAST with "Choose
//       default agent with: omarchy default agent <name>" — so the gate now also measures
//       the provisioned chain (`omarchy default agent claude`, the product's spec-26
//       provisioning step): default form first, then --inline when the default form fails
//       fast headless. Expected end: auth failure with no credentials; the gate measures
//       the LAUNCHER: does it run without a TTY, does it ever stop to ask (it must not),
//       where do output/files/tmux land, what is the exit code and wall-clock.
//   (7) ControlMaster latency: N timed `ssh ... true` round-trips through a warm mux vs N
//       fresh connections, p50/p95/max per mode (the ssh2 fast-follow trigger), the mux
//       master killed with `-O exit` at the end.
// Teardown is the overlay discipline's lesson: clean guest poweroff over ssh (NEVER a hard
// cut while btrfs is mounted rw — that is what corrupted the first golden), stop ladder
// only as the fallback. Run log: runs/<stamp>-probes.log; the golden's disk + VARS are
// stat-asserted byte-identical before vs after.
import { spawn } from "node:child_process";
import {
	appendFileSync,
	closeSync,
	copyFileSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { matrixQemuArgs, QEMU_BIN, QEMU_IMG } from "./args.ts";
import { ensureSshKeypair, GUEST_HOSTNAME, GUEST_USERNAME } from "./cidata.ts";
import { run } from "./proc.ts";
import type { QmpClient } from "./qmp.ts";
import {
	assertProcessGone,
	connectQmpWithRetry,
	hasExited,
	type LadderResult,
	parseUsernetHostPort,
	shutdownLadder,
	sleep,
	sshExecTrue,
	sshRun,
	tailText,
	waitForExit,
	waitForFile,
} from "./runtime.ts";
import { openSpikeDirs } from "./scratch.ts";

const DEFAULT_AGENT_BUDGET_SECONDS = 1200;
const DEFAULT_MUX_SAMPLES = 20;
const READY_BUDGET_MS = 300_000;
const READY_POLL_MS = 5_000;
const CONFIRM_GAP_MS = 10_000;
const CONNECT_RETRY_ATTEMPTS = 5;
const SERIAL_TAIL_BYTES = 16_384;
const SERIAL_READ_CHUNK = 64_000;
const REBOOT_BUDGET_MS = 300_000;
const REBOOT_POLL_MS = 5_000;
const AGENT_SETTLE_MS = 20_000;
const POWEROFF_WAIT_MS = 180_000;
const SERIAL_LOGIN_PROMPT = `${GUEST_HOSTNAME} login:`;

// Gate 4's payload: one KEY stamped per run, written to all three places. The source line is
// POSIX-sh compatible so the same literal serves ~/.zshrc and ~/.bashrc.
const ENV_KEY = "OH_SPIKE_TEST";
const ENV_SOURCE_LINE = "[ -f ~/.openhammer/env ] && . ~/.openhammer/env";

// Gate 7's mux socket lives in /tmp with %r/%h/%p expansion (unique per boot's port).
const CONTROL_PATH = "/tmp/oh-probe-cm-%r@%h-%p";

interface ProbesFlags {
	readonly installSession: string | undefined;
	readonly agentBudgetSeconds: number;
	readonly muxSamples: number;
}

function parseFlags(argv: readonly string[]): ProbesFlags {
	let installSession: string | undefined;
	let agentBudgetSeconds = DEFAULT_AGENT_BUDGET_SECONDS;
	let muxSamples = DEFAULT_MUX_SAMPLES;
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		if (flag === "--install-session") {
			installSession = argv[++i];
		} else if (flag === "--agent-budget-seconds") {
			agentBudgetSeconds = Number(argv[++i]);
		} else if (flag === "--mux-samples") {
			muxSamples = Number(argv[++i]);
		} else {
			throw new Error(`probes: unknown argument: ${flag}`);
		}
	}
	if (!Number.isFinite(agentBudgetSeconds) || agentBudgetSeconds <= 0) {
		throw new Error(`probes: --agent-budget-seconds must be a positive number, got ${argv.join(" ")}`);
	}
	if (!Number.isFinite(muxSamples) || muxSamples <= 0) {
		throw new Error(`probes: --mux-samples must be a positive number, got ${argv.join(" ")}`);
	}
	return { installSession, agentBudgetSeconds, muxSamples };
}

// --- golden install session (copied shape from matrix.ts: the only installed system, never
// --- booted directly; the overlay absorbs every write) ---

interface GoldenSession {
	readonly name: string;
	readonly dir: string;
	readonly disk: string;
	readonly vars: string;
	readonly passwordFile: string;
}

function isGoldenSession(dir: string): boolean {
	return (
		statSync(join(dir, "disk.qcow2"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "OVMF_VARS.4m.fd"), { throwIfNoEntry: false }) !== undefined &&
		statSync(join(dir, "luks-or-sudo-password.txt"), { throwIfNoEntry: false }) !== undefined
	);
}

// Newest `install-*` session holding the full golden set (ISO-stamped names sort; the
// `luks-install-*` prefix stays disjoint — that chain belongs to unlock.ts).
function findGoldenSession(sessionsDir: string): GoldenSession | undefined {
	const names = readdirSync(sessionsDir)
		.filter((name) => name.startsWith("install-"))
		.sort();
	for (let i = names.length - 1; i >= 0; i--) {
		const dir = join(sessionsDir, names[i]);
		if (isGoldenSession(dir)) {
			return goldenSessionAt(dir);
		}
	}
	return undefined;
}

function goldenSessionAt(dir: string): GoldenSession {
	return {
		name: basename(dir),
		dir,
		disk: join(dir, "disk.qcow2"),
		vars: join(dir, "OVMF_VARS.4m.fd"),
		passwordFile: join(dir, "luks-or-sudo-password.txt"),
	};
}

interface FileFingerprint {
	readonly path: string;
	readonly size: number;
	readonly mtimeMs: number;
}

function fileFingerprint(path: string): FileFingerprint | undefined {
	const stat = statSync(path, { throwIfNoEntry: false });
	return stat === undefined ? undefined : { path, size: stat.size, mtimeMs: stat.mtimeMs };
}

function fingerprintsEqual(a: FileFingerprint | undefined, b: FileFingerprint | undefined): boolean {
	if (a === undefined || b === undefined) {
		return false;
	}
	return a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function describeFingerprint(fingerprint: FileFingerprint | undefined): string {
	return fingerprint === undefined
		? "MISSING"
		: `${fingerprint.path} size=${fingerprint.size} mtimeMs=${fingerprint.mtimeMs}`;
}

// --- run-log collector (the established shape: every measurement in the log AND console) ---

interface Recorder {
	readonly lines: string[];
	findings: string[];
	failures: string[];
}

function note(rec: Recorder, tag: string, line: string): void {
	rec.lines.push(`${tag}| ${line}`);
	console.log(`probes: ${tag}| ${line}`);
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

// Collapse multi-line output to one log line (raw content survives, one line per command).
function oneLine(text: string, max: number): string {
	const collapsed = text
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		.join("; ");
	return clip(collapsed, max);
}

interface Capture {
	readonly code: number | null;
	readonly out: string;
	readonly err: string;
}

async function capture(port: number, keyPath: string, command: string): Promise<Capture> {
	const result = await sshRun(GUEST_USERNAME, port, keyPath, command);
	return { code: result.code, out: result.stdoutTail.trim(), err: result.stderrTail.trim() };
}

// --- serial.log read from a byte offset (the reboot appends a second boot; the first boot's
// --- login prompt must not satisfy the post-reboot readiness check) ---

async function readSerialFrom(path: string, offset: number, maxBytes: number): Promise<string> {
	const size = statSync(path, { throwIfNoEntry: false })?.size ?? 0;
	if (size <= offset) {
		return "";
	}
	const length = Math.min(size - offset, maxBytes);
	const buffer = Buffer.alloc(length);
	const handle = await open(path, "r");
	try {
		await handle.read(buffer, 0, length, offset);
	} finally {
		await handle.close();
	}
	return buffer.toString("utf8");
}

// --- gate 4: env dual-injection ---

interface EnvGateResult {
	readonly shellValue: string;
	readonly prefixValue: string;
	readonly rebootGrep: string;
}

async function gate4WriteEnv(
	port: number,
	keyPath: string,
	stamp: string,
	rec: Recorder,
): Promise<{ envValue: string; zshInstalled: boolean }> {
	const envValue = `spike-${stamp}`;
	note(rec, "gate4", `payload: ${ENV_KEY}=${envValue} → ~/.openhammer/env + shell rc + environment.d`);

	// The shell inventory is a measurement, not an assumption (run #1's finding: the cidata
	// guest's login shell is BASH and zsh is not installed — Arch's archinstall default).
	const shellInventory = await capture(port, keyPath, "echo SHELL=$SHELL; command -v zsh; command -v bash");
	const zshInstalled = shellInventory.out.includes("/zsh");
	note(
		rec,
		"gate4",
		`shell inventory: rc=${shellInventory.code} ${oneLine(shellInventory.out, 200)} → zsh ${zshInstalled ? "present" : "ABSENT"}`,
	);

	// Negative controls BEFORE any file exists: plain non-interactive ssh must NOT see the
	// var (that absence is why the product's runShell prefix-sources the env file), and the
	// user manager's environment cannot contain it (it started before the file existed).
	const plain = await capture(port, keyPath, `echo N1:$${ENV_KEY}`);
	note(rec, "gate4", `pre-write plain non-interactive ssh: rc=${plain.code} out="${plain.out}" (empty = expected)`);
	await userShowEnvironment(port, keyPath, rec, "pre-write");
	const absent = await capture(port, keyPath, `systemctl --user show-environment | grep -c ${ENV_KEY} || true`);
	note(
		rec,
		"gate4",
		`pre-write manager grep -c: rc=${absent.code} out="${absent.out}" (0 = expected negative control)`,
	);

	const dirs = await capture(port, keyPath, "mkdir -p ~/.openhammer ~/.config/environment.d");
	note(rec, "gate4", `mkdir -p ~/.openhammer ~/.config/environment.d: rc=${dirs.code} ${oneLine(dirs.err, 120)}`);
	const putEnv = await sshRun(GUEST_USERNAME, port, keyPath, "cat > ~/.openhammer/env", {
		stdin: `${ENV_KEY}=${envValue}\n`,
	});
	note(rec, "gate4", `cat > ~/.openhammer/env: rc=${putEnv.code} ${oneLine(putEnv.stderrTail, 120)}`);
	for (const rcFile of [".zshrc", ".bashrc"]) {
		const has = await capture(port, keyPath, `grep -q openhammer/env ~/${rcFile}`);
		if (has.code !== 0) {
			const append = await sshRun(GUEST_USERNAME, port, keyPath, `cat >> ~/${rcFile}`, {
				stdin: `${ENV_SOURCE_LINE}\n`,
			});
			note(rec, "gate4", `cat >> ~/${rcFile}: rc=${append.code} line=${JSON.stringify(ENV_SOURCE_LINE)}`);
		} else {
			note(rec, "gate4", `~/${rcFile} already sources ~/.openhammer/env`);
		}
	}
	const putEnvD = await sshRun(GUEST_USERNAME, port, keyPath, "cat > ~/.config/environment.d/openhammer.conf", {
		stdin: `${ENV_KEY}=${envValue}\n`,
	});
	note(
		rec,
		"gate4",
		`cat > ~/.config/environment.d/openhammer.conf: rc=${putEnvD.code} ${oneLine(putEnvD.stderrTail, 120)}`,
	);

	const raw = await capture(
		port,
		keyPath,
		"cat ~/.openhammer/env; echo ---; tail -n 2 ~/.bashrc; echo ---; cat ~/.config/environment.d/openhammer.conf",
	);
	note(rec, "gate4", `raw files: ${oneLine(raw.out, 300)}`);
	return { envValue, zshInstalled };
}

// `systemctl --user show-environment` over a plain ssh exec: pam_systemd exports
// XDG_RUNTIME_DIR into the session env, which is usually enough; when it is not, the
// explicit /run/user/1000 prefix is the fallback — which form worked is itself recorded.
async function userShowEnvironment(port: number, keyPath: string, rec: Recorder, phase: string): Promise<string> {
	const plain = await capture(port, keyPath, "systemctl --user show-environment");
	if (plain.code === 0) {
		note(rec, "gate4", `${phase} show-environment: rc=0 (no prefix needed) ${oneLine(plain.out, 250)}`);
		return plain.out;
	}
	const prefixed = await capture(port, keyPath, "XDG_RUNTIME_DIR=/run/user/1000 systemctl --user show-environment");
	note(
		rec,
		"gate4",
		`${phase} show-environment: plain rc=${plain.code} (${oneLine(plain.err, 120)}) → prefixed rc=${prefixed.code} ${oneLine(prefixed.out, 250)}`,
	);
	return prefixed.out;
}

// --- gate 5: `omarchy agent prompt` headless ---

interface AgentAttempt {
	readonly label: string;
	readonly exitCode: string;
	readonly wallSeconds: number;
}

interface AgentGateResult {
	readonly attempts: readonly AgentAttempt[];
	readonly provisioned: boolean;
}

// One launcher attempt under the budget, output teed to a per-attempt guest log (a
// deterministic tail whatever the churn does to the 4 KB stdout window). NO credentials are
// ever written into the guest — auth failure is the expected end state.
async function agentAttempt(
	port: number,
	keyPath: string,
	form: string,
	budgetSeconds: number,
	label: string,
	rec: Recorder,
): Promise<AgentAttempt> {
	note(rec, "agent", `${label}: ${form}`);
	const startedAt = Date.now();
	const runResult = await sshRun(
		GUEST_USERNAME,
		port,
		keyPath,
		`timeout ${budgetSeconds} ${form} > /tmp/oh-agent-${label}.log 2>&1; echo AGENT_EXIT:$?; tail -c 4000 /tmp/oh-agent-${label}.log`,
	);
	const wallSeconds = (Date.now() - startedAt) / 1000;
	const outLines = runResult.stdoutTail
		.trim()
		.split(/\r?\n/)
		.filter((line) => line !== "");
	const exitLine = outLines.find((line) => line.startsWith("AGENT_EXIT:")) ?? "AGENT_EXIT:?";
	note(rec, "agent", `${label}: wall ${wallSeconds.toFixed(1)} s (budget ${budgetSeconds} s), ${exitLine}`);
	for (const line of outLines.filter((line) => !line.startsWith("AGENT_EXIT:"))) {
		note(rec, "agent", `${label} output| ${clip(line.trim(), 300)}`);
	}
	if (runResult.stderrTail.trim() !== "") {
		note(rec, "agent", `${label} ssh stderr: ${oneLine(runResult.stderrTail, 200)}`);
	}
	return { label, exitCode: exitLine.replace("AGENT_EXIT:", ""), wallSeconds };
}

// Where did output/files/sessions land: ~/Work contents, tmux sessions + pane tails, the
// mise tree size (claude pre-seeds 225 MB at install time in this image).
async function agentLandingSites(port: number, keyPath: string, phase: string, rec: Recorder): Promise<void> {
	const work = await capture(port, keyPath, "ls -la ~/Work 2>&1");
	note(rec, "agent", `${phase} ls -la ~/Work: rc=${work.code} ${oneLine(work.out || work.err, 400)}`);
	const tmux = await capture(port, keyPath, "tmux ls 2>&1");
	note(rec, "agent", `${phase} tmux ls: rc=${tmux.code} ${oneLine(tmux.out || tmux.err, 200)}`);
	if (tmux.code === 0) {
		for (const line of tmux.out.split(/\r?\n/)) {
			const session = line.trim().split(":")[0];
			if (session === undefined || session === "") {
				continue;
			}
			const pane = await capture(port, keyPath, `tmux capture-pane -p -t ${session} 2>&1 | tail -20`);
			note(rec, "agent", `${phase} tmux capture-pane ${session} (tail): ${oneLine(pane.out || pane.err, 500)}`);
		}
	}
	const mise = await capture(port, keyPath, "du -sh ~/.local/share/mise 2>&1");
	note(rec, "agent", `${phase} du -sh ~/.local/share/mise: rc=${mise.code} ${oneLine(mise.out || mise.err, 150)}`);
}

async function gate5AgentPrompt(
	port: number,
	keyPath: string,
	budgetSeconds: number,
	rec: Recorder,
): Promise<AgentGateResult> {
	// Recon for the record.
	const version = await capture(port, keyPath, "omarchy --version || omarchy version");
	note(rec, "agent", `omarchy --version: rc=${version.code} ${oneLine(version.out || version.err, 150)}`);
	const commands = await capture(port, keyPath, "omarchy commands --json 2>&1 | head -40");
	note(rec, "agent", `omarchy commands --json | head -40: rc=${commands.code} ${oneLine(commands.out, 400)}`);
	const defaultBefore = await capture(port, keyPath, "omarchy default agent");
	note(
		rec,
		"agent",
		`omarchy default agent (getter): rc=${defaultBefore.code} out="${defaultBefore.out}" ${oneLine(defaultBefore.err, 150)}`,
	);
	const stubs = await capture(port, keyPath, "command -v omarchy; command -v claude; command -v mise");
	note(rec, "agent", `command -v omarchy/claude/mise: rc=${stubs.code} ${oneLine(stubs.out, 200)}`);

	// The flag shape comes from the subcommand's own --help — never guessed.
	const agentHelp = await capture(port, keyPath, "omarchy agent --help 2>&1");
	note(rec, "agent", `omarchy agent --help: rc=${agentHelp.code} ${oneLine(agentHelp.out || agentHelp.err, 500)}`);
	const promptHelp = await capture(port, keyPath, "omarchy agent prompt --help 2>&1");
	note(
		rec,
		"agent",
		`omarchy agent prompt --help: rc=${promptHelp.code} ${oneLine(promptHelp.out || promptHelp.err, 500)}`,
	);
	const message = "run: echo hello-from-agent && exit";
	let form = `omarchy agent prompt '${message}'`;
	if (promptHelp.code === 0 && promptHelp.out.includes("--message")) {
		form = `omarchy agent prompt --message '${message}'`;
	}
	const inlineForm = `omarchy agent prompt --inline '${message}'`;
	note(rec, "agent", `launch form (from --help): ${form}`);

	await agentLandingSites(port, keyPath, "before", rec);
	const attempts: AgentAttempt[] = [];

	// Attempt 1 — the UNPROVISIONED launcher (what a fresh golden presents): run #1 measured
	// a fast "Choose default agent" failure; keep it as the recorded baseline.
	const first = await agentAttempt(port, keyPath, form, Math.min(budgetSeconds, 60), "a1-unprovisioned", rec);
	attempts.push(first);

	// The provisioning step the product owes the guest (spec 26): pick the default agent.
	// Run #2 measured `omarchy default agent claude` as a Wayland picker (wayland.c:1822
	// "failed to connect" over bare ssh, rc=0, value not persisted) — so when the setter
	// fails, discover the file it writes from the launcher binaries themselves and set it
	// directly: the honest headless provisioning path, recorded either way for spec 26.
	let provisioned = false;
	if (first.exitCode !== "0") {
		const choose = await capture(port, keyPath, "omarchy default agent claude");
		note(rec, "agent", `omarchy default agent claude: rc=${choose.code} ${oneLine(choose.out || choose.err, 400)}`);
		let after = await capture(port, keyPath, "omarchy default agent");
		note(rec, "agent", `omarchy default agent (re-read): rc=${after.code} out="${after.out}"`);
		if (after.out.trim() !== "claude") {
			const bins = await capture(
				port,
				keyPath,
				"command -v omarchy-agent omarchy-agent-prompt omarchy-default-agent omarchy-agent-picker",
			);
			note(rec, "agent", `launcher binaries: rc=${bins.code} ${oneLine(bins.out || bins.err, 300)}`);
			const stringsProbe = await capture(
				port,
				keyPath,
				`strings ${bins.out.trim().split(/\r?\n/).join(" ")} 2>/dev/null | grep -E '\\.config|agent' | sort -u | head -30`,
			);
			note(
				rec,
				"agent",
				`strings discovery: rc=${stringsProbe.code} ${oneLine(stringsProbe.out || stringsProbe.err, 600)}`,
			);
			const tree = await capture(
				port,
				keyPath,
				"ls -la ~/.config/omarchy 2>/dev/null; find ~/.config ~/.local/share/omarchy -maxdepth 3 -iname '*agent*' 2>/dev/null | head -20",
			);
			note(rec, "agent", `config tree probe: rc=${tree.code} ${oneLine(tree.out || tree.err, 400)}`);
			// A clean path candidate: under .config, mentions agent, single token (no printf
			// format specifiers like %s that would need expanding).
			const candidate = stringsProbe.out
				.split(/\r?\n/)
				.map((line) => line.trim())
				.find(
					(line) => line.includes(".config/") && /agent/i.test(line) && !line.includes("%") && !/\s/.test(line),
				);
			if (candidate !== undefined) {
				const expanded = candidate.replace(/^~\/?/, "$HOME/");
				const write = await capture(
					port,
					keyPath,
					`mkdir -p "$(dirname ${expanded})"; printf 'claude\\n' > ${expanded}`,
				);
				note(
					rec,
					"agent",
					`direct write ${expanded} (from strings candidate "${candidate}"): rc=${write.code} ${oneLine(write.out || write.err, 200)}`,
				);
				after = await capture(port, keyPath, "omarchy default agent");
				note(
					rec,
					"agent",
					`omarchy default agent (re-read after direct write): rc=${after.code} out="${after.out}"`,
				);
			}
			// The launchers measured as SHELL SCRIPTS — the strings dump showed the getter is
			// `read -r agent <"$agent_file"`. Record the assignment and let the guest's own
			// shell expand it, then write "claude" there directly.
			if (after.out.trim() !== "claude") {
				const assignment = await capture(
					port,
					keyPath,
					"grep -hE 'agent_file=' /usr/bin/omarchy-default-agent /usr/bin/omarchy-agent /usr/bin/omarchy-agent-prompt /usr/share/omarchy/lib/*.sh 2>/dev/null | head -5",
				);
				note(
					rec,
					"agent",
					`agent_file assignments: rc=${assignment.code} ${oneLine(assignment.out || assignment.err, 400)}`,
				);
				const first = assignment.out.split(/\r?\n/)[0] ?? "";
				const match = first.match(/agent_file=(?:"([^"]*)"|([^;#\s]+))/);
				if (match !== null) {
					const expression = match[1] ?? match[2] ?? "";
					const resolved = await capture(
						port,
						keyPath,
						`eval "agent_file=${expression}"; echo RESOLVED:$agent_file`,
					);
					note(
						rec,
						"agent",
						`eval-resolved agent_file: rc=${resolved.code} ${oneLine(resolved.out || resolved.err, 200)}`,
					);
					const path = resolved.out.replace(/^RESOLVED:/, "").trim();
					if (path.startsWith("/")) {
						const write = await capture(
							port,
							keyPath,
							`mkdir -p "$(dirname ${path})"; printf 'claude\\n' > ${path}`,
						);
						note(rec, "agent", `direct write ${path}: rc=${write.code} ${oneLine(write.out || write.err, 200)}`);
						after = await capture(port, keyPath, "omarchy default agent");
						note(
							rec,
							"agent",
							`omarchy default agent (re-read after direct write): rc=${after.code} out="${after.out}"`,
						);
					}
				}
				if (after.out.trim() !== "claude") {
					rec.findings.push(
						"gate 5: no headless default-agent provisioning path found — recorded for spec 26 (the setter is a Wayland picker)",
					);
				}
			}
		}
		provisioned = after.out.trim() === "claude";
		if (!provisioned) {
			rec.findings.push(`gate 5: default agent still unset after every provisioning path (re-read "${after.out}")`);
		}
	}

	// Attempt 2 — the provisioned default form ("in a terminal": where does it land headless?).
	if (provisioned) {
		const second = await agentAttempt(port, keyPath, form, budgetSeconds, "a2-default", rec);
		attempts.push(second);
		await sleep(AGENT_SETTLE_MS);
		await agentLandingSites(port, keyPath, "after a2-default", rec);
		// Attempt 3 — --inline when the default form failed fast headless (no TTY to give it).
		if (second.exitCode !== "0" && second.exitCode !== "124" && second.wallSeconds < 30) {
			const third = await agentAttempt(port, keyPath, inlineForm, budgetSeconds, "a3-inline", rec);
			attempts.push(third);
			await sleep(AGENT_SETTLE_MS);
			await agentLandingSites(port, keyPath, "after a3-inline", rec);
		}
	}

	for (const attempt of attempts) {
		if (attempt.exitCode === "124") {
			rec.findings.push(
				`gate 5 ${attempt.label}: still running at the budget — download over slirp is the long pole, or it stopped to ask (inspect /tmp/oh-agent-${attempt.label}.log + tmux evidence)`,
			);
		} else if (attempt.exitCode !== "0") {
			rec.findings.push(
				`gate 5 ${attempt.label}: exit ${attempt.exitCode} (no credentials in the guest — expected shape is an auth failure)`,
			);
		}
	}
	return { attempts, provisioned };
}

// --- gate 7: ControlMaster latency ---

function percentile(sorted: readonly number[], fraction: number): number {
	if (sorted.length === 0) {
		return 0;
	}
	const rank = Math.max(1, Math.ceil(fraction * sorted.length));
	return sorted[rank - 1];
}

function describeSamples(label: string, samples: readonly number[]): string {
	const sorted = [...samples].sort((a, b) => a - b);
	return `${label}: n=${sorted.length} p50=${percentile(sorted, 0.5).toFixed(1)} ms p95=${percentile(sorted, 0.95).toFixed(1)} ms max=${sorted[sorted.length - 1].toFixed(1)} ms`;
}

async function timedSshTrue(
	port: number,
	keyPath: string,
	extraOptions: readonly string[],
): Promise<{ ms: number; code: number | null }> {
	const started = process.hrtime.bigint();
	const result = await run("ssh", [
		"-i",
		keyPath,
		"-p",
		String(port),
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"ConnectTimeout=5",
		"-o",
		"BatchMode=yes",
		...extraOptions,
		`${GUEST_USERNAME}@127.0.0.1`,
		"true",
	]);
	const ms = Number(process.hrtime.bigint() - started) / 1e6;
	return { ms, code: result.code };
}

async function gate7ControlMasterLatency(
	port: number,
	keyPath: string,
	samplesPerMode: number,
	rec: Recorder,
): Promise<{ muxP50: number; freshP50: number }> {
	const muxOptions = ["-o", "ControlMaster=auto", "-o", `ControlPath=${CONTROL_PATH}`, "-o", "ControlPersist=yes"];
	const freshOptions = ["-o", "ControlMaster=no", "-o", "ControlPath=none"];

	const mux: number[] = [];
	let muxFailures = 0;
	for (let i = 0; i < samplesPerMode; i++) {
		const sample = await timedSshTrue(port, keyPath, muxOptions);
		if (sample.code !== 0) {
			muxFailures++;
		}
		mux.push(sample.ms);
	}
	note(rec, "latency", describeSamples("warm ControlMaster (auto/ControlPersist, first call establishes)", mux));
	if (mux.length > 1) {
		note(rec, "latency", describeSamples("warm ControlMaster excluding the establishing first call", mux.slice(1)));
	}
	if (muxFailures > 0) {
		rec.failures.push(`gate 7: ${muxFailures}/${samplesPerMode} mux-mode ssh calls failed`);
	}

	// Kill the master BEFORE the fresh-mode samples (belt and braces: ControlPath=none
	// already bypasses any socket) — a leaked master would outlive the VM and the run.
	const killMaster = await run("ssh", [
		"-i",
		keyPath,
		"-p",
		String(port),
		"-o",
		"StrictHostKeyChecking=no",
		"-o",
		"UserKnownHostsFile=/dev/null",
		"-o",
		"BatchMode=yes",
		"-o",
		`ControlPath=${CONTROL_PATH}`,
		"-O",
		"exit",
		`${GUEST_USERNAME}@127.0.0.1`,
	]);
	note(
		rec,
		"latency",
		`ssh -O exit (mux master kill): rc=${killMaster.code} ${oneLine(killMaster.stdoutTail || killMaster.stderrTail, 150)}`,
	);

	const fresh: number[] = [];
	let freshFailures = 0;
	for (let i = 0; i < samplesPerMode; i++) {
		const sample = await timedSshTrue(port, keyPath, freshOptions);
		if (sample.code !== 0) {
			freshFailures++;
		}
		fresh.push(sample.ms);
	}
	note(rec, "latency", describeSamples("no mux (fresh connection per call)", fresh));
	if (freshFailures > 0) {
		rec.failures.push(`gate 7: ${freshFailures}/${samplesPerMode} fresh-mode ssh calls failed`);
	}
	const speedup = percentile(fresh, 0.5) / Math.max(percentile(mux.slice(1), 0.5), 0.01);
	note(rec, "latency", `p50 speedup (fresh ÷ warm-excluding-first): ${speedup.toFixed(1)}x`);
	return { muxP50: percentile(mux.slice(1), 0.5), freshP50: percentile(fresh, 0.5) };
}

let stopRequested = false;
process.on("SIGINT", () => {
	stopRequested = true;
});
process.on("SIGTERM", () => {
	stopRequested = true;
});

async function main(): Promise<number> {
	const flags = parseFlags(process.argv.slice(2));
	const dirs = openSpikeDirs();

	const goldenSession: GoldenSession | undefined =
		flags.installSession !== undefined
			? isGoldenSession(flags.installSession)
				? goldenSessionAt(flags.installSession)
				: undefined
			: findGoldenSession(dirs.sessions);
	if (goldenSession === undefined) {
		throw new Error(
			flags.installSession !== undefined
				? `probes: --install-session ${flags.installSession} is not a golden session (needs disk.qcow2 + OVMF_VARS.4m.fd + luks-or-sudo-password.txt)`
				: `probes: no install session found under ${dirs.sessions} (pass --install-session <path>)`,
		);
	}
	const diskBefore = fileFingerprint(goldenSession.disk);
	const varsBefore = fileFingerprint(goldenSession.vars);
	const password = readFileSync(goldenSession.passwordFile, "utf8").trim();
	const keypair = await ensureSshKeypair(dirs.root);

	const startedAt = Date.now();
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const name = `probes-${stamp}`;
	const sessionDir = join(dirs.sessions, name);
	mkdirSync(sessionDir, { recursive: true, mode: 0o700 });

	// Overlay boot pattern (the matrix discipline): fresh qcow2 with the golden disk as
	// backing file + a COPY of the install session's VARS (it holds the Limine boot entry).
	const overlayPath = join(sessionDir, "disk.qcow2");
	const img = await run(QEMU_IMG, ["create", "-f", "qcow2", "-b", goldenSession.disk, "-F", "qcow2", overlayPath]);
	if (img.code !== 0) {
		throw new Error(`probes: qemu-img create overlay exited ${img.code}: ${img.stderrTail.trim()}`);
	}
	copyFileSync(goldenSession.vars, join(sessionDir, "OVMF_VARS.4m.fd"));

	const argv = matrixQemuArgs({ name, sessionDir, config: "headless" });
	console.log(`probes: golden ${goldenSession.dir}`);
	console.log(`probes: session ${sessionDir}`);
	console.log(`probes: qemu ${JSON.stringify(argv)}`);

	const rec: Recorder = { lines: [], findings: [], failures: [] };
	note(rec, "overlay", `qemu-img create -f qcow2 -b ${goldenSession.disk} -F qcow2 ${overlayPath}`);
	note(rec, "golden", `before: ${describeFingerprint(diskBefore)} / ${describeFingerprint(varsBefore)}`);

	const stderrPath = join(sessionDir, "qemu.stderr");
	const stderrFd = openSync(stderrPath, "w");
	const child = spawn(QEMU_BIN, argv, { stdio: ["ignore", "ignore", stderrFd] });
	closeSync(stderrFd);
	if (child.pid === undefined) {
		throw new Error("probes: spawn qemu failed");
	}
	console.log(`probes: qemu pid ${child.pid}`);

	let qmp: QmpClient | undefined;
	try {
		const socketPath = join(sessionDir, "qmp.sock");
		if (!(await waitForFile(socketPath, 15_000))) {
			if (hasExited(child)) {
				throw new Error(
					`probes: qemu exited before creating the QMP socket; stderr: ${await tailText(stderrPath, 4096)}`,
				);
			}
			throw new Error(`probes: no QMP socket at ${socketPath} within 15 s`);
		}
		qmp = await connectQmpWithRetry(socketPath, CONNECT_RETRY_ATTEMPTS);
		const client = qmp;
		console.log(`probes: qmp greeting ${qmp.greetingLine}`);

		const pidfile = readFileSync(join(sessionDir, "qemu.pid"), "utf8").trim();
		const pidfileNote =
			Number(pidfile) === child.pid
				? `matches pid ${child.pid}`
				: `MISMATCH: pidfile ${pidfile} vs child ${child.pid}`;
		console.log(`probes: pidfile ${pidfileNote}`);

		// --- readiness: serial login prompt + usernet port + the 22b ssh double round-trip
		const serialPath = join(sessionDir, "serial.log");
		let serialSeenAt: number | undefined;
		let hostPort: number | undefined;
		let usernetRow: string | undefined;
		let readyAt: number | undefined;
		let gateFailure: string | undefined;
		let candidateConfirmed = false;
		const deadline = Date.now() + READY_BUDGET_MS;
		while (!stopRequested && Date.now() < deadline && readyAt === undefined && gateFailure === undefined) {
			if (hasExited(child)) {
				gateFailure = `qemu exited during readiness (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
				break;
			}
			if (serialSeenAt === undefined) {
				const tail = await tailText(serialPath, SERIAL_TAIL_BYTES);
				if (tail.includes(SERIAL_LOGIN_PROMPT)) {
					serialSeenAt = Date.now();
					note(
						rec,
						"ready",
						`serial login prompt after ${((serialSeenAt - startedAt) / 1000).toFixed(1)} s (serial.log ${statSync(serialPath, { throwIfNoEntry: false })?.size ?? 0} bytes)`,
					);
				}
			}
			if (hostPort === undefined) {
				try {
					const table = await client.humanMonitorCommand("info usernet");
					const found = parseUsernetHostPort(table);
					if (found !== undefined) {
						hostPort = found.port;
						usernetRow = found.row;
						note(rec, "ready", `usernet (gate 8 row #4): ${found.row} → host port ${found.port}`);
					}
				} catch {
					// retry next tick
				}
			}
			if (serialSeenAt !== undefined && hostPort !== undefined && !candidateConfirmed) {
				if (await sshExecTrue(GUEST_USERNAME, hostPort, keypair.privateKeyPath)) {
					note(rec, "ready", `ssh: first answer user=${GUEST_USERNAME} port=${hostPort}`);
					await sleep(CONFIRM_GAP_MS);
					if (hasExited(child)) {
						gateFailure = `qemu exited during the confirm gap (exitCode=${child.exitCode})`;
						break;
					}
					if (await sshExecTrue(GUEST_USERNAME, hostPort, keypair.privateKeyPath)) {
						candidateConfirmed = true;
						readyAt = Date.now();
						note(
							rec,
							"ready",
							`ssh: CONFIRMED user=${GUEST_USERNAME} (two round-trips ${CONFIRM_GAP_MS / 1000} s apart) after ${((readyAt - startedAt) / 1000).toFixed(1)} s`,
						);
					}
				}
			}
			if (readyAt === undefined && gateFailure === undefined) {
				await sleep(READY_POLL_MS);
			}
		}
		if (stopRequested && readyAt === undefined && gateFailure === undefined) {
			gateFailure = "interrupted by signal";
		}
		if (readyAt === undefined && gateFailure === undefined) {
			gateFailure = `not ready within the ${READY_BUDGET_MS / 60_000} min budget (serial prompt ${serialSeenAt === undefined ? "never seen" : "seen"}, port ${hostPort ?? "never learned"})`;
		}
		if (gateFailure !== undefined) {
			rec.failures.push(gateFailure);
		}

		// --- the gates, in the one session
		let envGate: EnvGateResult | undefined;
		let agentGate: AgentGateResult | undefined;
		let latencyP50: { muxP50: number; freshP50: number } | undefined;
		if (readyAt !== undefined) {
			const port = hostPort;
			if (port === undefined) {
				throw new Error("probes: ready without a host port — impossible state");
			}
			const keyPath = keypair.privateKeyPath;

			// GATE 4 (write + the two immediate contexts; the reboot context comes last).
			const wrote = await gate4WriteEnv(port, keyPath, stamp, rec);
			// Context 1 — the interactive shell that EXISTS. Single quotes matter: the outer
			// shell must pass the literal through so the inner interactive shell expands it.
			let shellValue = "";
			if (wrote.zshInstalled) {
				const zsh = await capture(port, keyPath, `zsh -ic 'echo Z:$${ENV_KEY}'`);
				shellValue = zsh.out;
				note(rec, "gate4", `zsh -ic: rc=${zsh.code} out="${zsh.out}" ${oneLine(zsh.err, 150)}`);
			} else {
				const bash = await capture(port, keyPath, `bash -ic 'echo B:$${ENV_KEY}'`);
				shellValue = bash.out;
				note(
					rec,
					"gate4",
					`bash -ic (zsh absent in this image): rc=${bash.code} out="${bash.out}" ${oneLine(bash.err, 150)}`,
				);
				rec.findings.push(
					"gate 4: zsh is not installed in the cidata guest (shell is bash) — the ~/.zshrc source line is dead weight here; ~/.bashrc is the load-bearing rc",
				);
			}
			if (!shellValue.includes(wrote.envValue)) {
				rec.failures.push(`gate 4: interactive shell did not see ${ENV_KEY} ("${shellValue}")`);
			}
			// Context 2 — the product's runShell shape: source then use, one shell string.
			const prefixValue = (await capture(port, keyPath, `. ~/.openhammer/env; echo P:$${ENV_KEY}`)).out;
			note(rec, "gate4", `prefixed exec: out="${prefixValue}"`);
			if (!prefixValue.includes(wrote.envValue)) {
				rec.failures.push(`gate 4: prefixed exec did not see ${ENV_KEY} ("${prefixValue}")`);
			}

			// GATE 5 (before the latency probe so the download cannot skew the timings).
			agentGate = await gate5AgentPrompt(port, keyPath, flags.agentBudgetSeconds, rec);

			// GATE 7.
			latencyP50 = await gate7ControlMasterLatency(port, keyPath, flags.muxSamples, rec);

			// GATE 4's third context: the reboot. environment.d is parsed only when the user
			// manager starts, so reboot the guest (the overlay absorbs it), then wait for the
			// SECOND serial login prompt (bytes past the pre-reboot offset) + the ssh double
			// round-trip, then read the manager environment.
			const serialSizeBeforeReboot = statSync(serialPath, { throwIfNoEntry: false })?.size ?? 0;
			const reboot = await sshRun(GUEST_USERNAME, port, keyPath, "sudo -S systemctl reboot", {
				stdin: `${password}\n`,
			});
			note(
				rec,
				"gate4",
				`reboot: ssh sudo systemctl reboot rc=${reboot.code} (255 = the connection dropped as the guest went down) ${oneLine(reboot.stderrTail, 120)}`,
			);
			let rebootPromptAt: number | undefined;
			let rebootConfirmed = false;
			const rebootDeadline = Date.now() + REBOOT_BUDGET_MS;
			while (!stopRequested && Date.now() < rebootDeadline && rebootPromptAt === undefined) {
				if (hasExited(child)) {
					gateFailure = `qemu exited during the reboot (exitCode=${child.exitCode} signalCode=${child.signalCode})`;
					break;
				}
				const since = await readSerialFrom(serialPath, serialSizeBeforeReboot, SERIAL_READ_CHUNK);
				if (since.includes(SERIAL_LOGIN_PROMPT)) {
					rebootPromptAt = Date.now();
					const bytesSince = (statSync(serialPath, { throwIfNoEntry: false })?.size ?? 0) - serialSizeBeforeReboot;
					note(
						rec,
						"gate4",
						`post-reboot serial login prompt after ${((rebootPromptAt - startedAt) / 1000).toFixed(1)} s (serial +${bytesSince} bytes since the reboot)`,
					);
				}
				if (rebootPromptAt === undefined) {
					await sleep(REBOOT_POLL_MS);
				}
			}
			// sshd answers a beat after the getty; retry the double round-trip until it holds.
			if (rebootPromptAt !== undefined && !stopRequested) {
				const sshDeadline = Date.now() + 120_000;
				while (!stopRequested && Date.now() < sshDeadline && !rebootConfirmed && gateFailure === undefined) {
					if (await sshExecTrue(GUEST_USERNAME, port, keyPath)) {
						await sleep(CONFIRM_GAP_MS);
						if (await sshExecTrue(GUEST_USERNAME, port, keyPath)) {
							rebootConfirmed = true;
							note(
								rec,
								"gate4",
								"post-reboot ssh: CONFIRMED (two round-trips) — the user manager restarted with this login",
							);
						}
					} else {
						await sleep(REBOOT_POLL_MS);
					}
				}
			}
			if (gateFailure === undefined && rebootPromptAt === undefined) {
				gateFailure = stopRequested
					? "interrupted by signal during the reboot"
					: `no second serial login prompt within ${REBOOT_BUDGET_MS / 1000} s of the reboot`;
				rec.failures.push(gateFailure);
			}
			let rebootGrep = "";
			if (rebootConfirmed) {
				const showAfter = await userShowEnvironment(port, keyPath, rec, "post-reboot");
				const grep = await capture(port, keyPath, `systemctl --user show-environment | grep ${ENV_KEY}`);
				rebootGrep = grep.out;
				note(rec, "gate4", `post-reboot manager grep: rc=${grep.code} out="${grep.out}"`);
				if (!showAfter.includes(`${ENV_KEY}=`) || grep.code !== 0) {
					rec.failures.push(
						`gate 4: environment.d not in the post-reboot user-manager environment ("${grep.out}")`,
					);
				}
				const shellEcho = wrote.zshInstalled ? `zsh -ic 'echo Z2:$${ENV_KEY}'` : `bash -ic 'echo B2:$${ENV_KEY}'`;
				const shell2 = await capture(port, keyPath, shellEcho);
				note(rec, "gate4", `post-reboot interactive-shell persistence: rc=${shell2.code} out="${shell2.out}"`);
			}
			envGate = { shellValue, prefixValue, rebootGrep };
			note(
				rec,
				"gate",
				`env dual-injection: interactive-shell="${envGate.shellValue}" prefixed="${envGate.prefixValue}" manager-after-reboot="${envGate.rebootGrep}"`,
			);
			note(
				rec,
				"gate",
				`agent prompt headless: ${agentGate.attempts.map((a) => `${a.label} exit=${a.exitCode} wall=${a.wallSeconds.toFixed(1)}s`).join("; ")}${agentGate.provisioned ? " (default agent provisioned)" : ""}`,
			);
			if (latencyP50 !== undefined) {
				note(
					rec,
					"gate",
					`controlmaster: warm p50=${latencyP50.muxP50.toFixed(1)} ms vs fresh p50=${latencyP50.freshP50.toFixed(1)} ms`,
				);
			}
		}

		const wallClockSeconds = (Date.now() - startedAt) / 1000;
		// --- teardown: clean guest poweroff over ssh FIRST (the corrupt-golden lesson — the
		// stop ladder is only acceptable when nothing is mounted), ladder as the fallback.
		let poweroffNote = "not attempted";
		if (readyAt !== undefined && hostPort !== undefined) {
			const poweroff = await sshRun(GUEST_USERNAME, hostPort, keypair.privateKeyPath, "sudo -S systemctl poweroff", {
				stdin: `${password}\n`,
			});
			poweroffNote = `ssh sudo systemctl poweroff rc=${poweroff.code}`;
			note(rec, "teardown", poweroffNote);
		}
		let ladder: LadderResult;
		if (await waitForExit(child, POWEROFF_WAIT_MS)) {
			ladder = {
				path: "guest-poweroff" as const,
				detail: `${poweroffNote}; exitCode=${child.exitCode} signalCode=${child.signalCode}`,
			};
		} else {
			ladder = await shutdownLadder(child, qmp);
		}
		assertProcessGone(child);
		console.log(`probes: shutdown path ${ladder.path} (${ladder.detail})`);

		const serialStat = statSync(serialPath, { throwIfNoEntry: false });
		const diskAfter = fileFingerprint(goldenSession.disk);
		const varsAfter = fileFingerprint(goldenSession.vars);
		const goldenOk = fingerprintsEqual(diskBefore, diskAfter) && fingerprintsEqual(varsBefore, varsAfter);
		if (!goldenOk) {
			rec.failures.push(
				"golden install session mutated during the run — the overlay was supposed to absorb every write",
			);
		}
		if (ladder.path === "sigkill") {
			rec.failures.push("qemu only died to SIGKILL");
		}

		const logLines = [
			`# ${name} (overlay boot of ${goldenSession.name})`,
			`started: ${new Date(startedAt).toISOString()}  wall-clock: ${wallClockSeconds.toFixed(1)} s`,
			`golden: ${goldenSession.dir}`,
			`argv: ${JSON.stringify(argv)}`,
			`qmp greeting: ${qmp.greetingLine}`,
			`qmp_capabilities: ${JSON.stringify(qmp.capabilitiesReturn)}`,
			`pidfile: ${pidfileNote}`,
			`usernet row: ${usernetRow ?? "NEVER PARSED"}`,
			`serial.log: ${serialStat === undefined ? "MISSING" : `${serialStat.size} bytes`}`,
			...rec.lines,
			`shutdown: ${ladder.path} (${ladder.detail})`,
			`golden after: ${describeFingerprint(diskAfter)} / ${describeFingerprint(varsAfter)} — ${goldenOk ? "unchanged" : "MUTATED"}`,
			`qemu.stderr tail: ${(await tailText(stderrPath, 4096)).trim()}`,
			`findings: ${rec.findings.length === 0 ? "none" : rec.findings.join("; ")}`,
			`failures: ${rec.failures.length === 0 ? "none" : rec.failures.join("; ")}`,
		];
		const runLog = join(dirs.runs, `${stamp}-probes.log`);
		appendFileSync(runLog, `${logLines.join("\n")}\n\n`);
		console.log(`probes: run log ${runLog}`);

		if (rec.failures.length > 0) {
			console.error(`probes: GATE FAILURES: ${rec.failures.join("; ")}`);
			return stopRequested ? 130 : 1;
		}
		console.log(`probes: gates complete (session kept at ${sessionDir})`);
		return stopRequested ? 130 : 0;
	} finally {
		if (!hasExited(child)) {
			console.error("probes: error path — running the stop ladder before exit");
			await shutdownLadder(child, qmp);
			assertProcessGone(child);
		}
	}
}

main()
	.then((code) => {
		process.exit(code);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	});
