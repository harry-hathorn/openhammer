#!/usr/bin/env node
/**
 * OpenHammer CLI entrypoint (spec 17n + 17o). `package.json` `bin: openhammer` →
 * `dist/cli.js`. Parses argv with the pure {@link parseArgs} (never throws —
 * unknown options become diagnostics), prints the README banner on an interactive
 * launch, writes diagnostics to stderr, then {@link dispatch}es on `command`.
 *
 * The command dispatch table (17o + 17p + 19e):
 * - no command → the **dashboard** in a terminal (spec 19; it starts/manages the server),
 *   or boot headless when non-interactive. `start` always boots headless.
 * - `channel { add | list | remove <id> | use <id> }` — manage channels.
 * - `config { get | set [section] }` — manage settings (default section `mcp`).
 * - `auth { add-client | list | remove <id> }` — manage OAuth clients (spec 20e).
 * - `vm { install | provision | snapshot | list | reset | gc }` — manage the local VM
 *   sandbox (spec 26; later boxes add status).
 * - `doctor` — run the diagnostics registry + per-channel checks (17p).
 * - `monitor` — stream live client + tool-call activity over the status socket (17t).
 *
 * `npm start` (`dist/main.js`, spec 14) is unchanged.
 */
import { type ParsedArgs, parseArgs } from "./cli/args.ts";
import { authCommand } from "./cli/auth.ts";
import { doctorCommand } from "./cli/doctor.ts";
import { parseSubFlags, type SubFlags } from "./cli/flags.ts";
import { monitorCommand } from "./cli/monitor.ts";
import { CONFIG_SECTIONS } from "./config/sections.ts";
import { loadSettings, type Settings, saveSettings, settingsPath } from "./config/settings.ts";
import { loadConfig } from "./config.ts";
import { isMainEntry } from "./entrypoint.ts";
import { type BannerStream, printBanner } from "./tui/banner.ts";
import type { ServerStatusState } from "./tui/dashboard/store.ts";
import { flagIo } from "./tui/prompts.ts";
import { addChannel, CHANNEL_SELECT_PROMPT, type ProbeRunner, registryProviders } from "./tui/wizards/channel.ts";
import { SECTION_SELECT_PROMPT, setSection } from "./tui/wizards/section.ts";
import { listChannels, removeChannel, setDefaultChannel } from "./tunnel/manage.ts";
import { DEFAULT_BUDGET_MINUTES, runInstall } from "./vm/provision/install.ts";
import { DEFAULT_KEEP_GOLDENS, type GoldenSummary, vmGc, vmList, vmReset } from "./vm/provision/manage.ts";
import { runProvision } from "./vm/provision/provision.ts";
import { runSnapshot } from "./vm/provision/snapshot.ts";

/** Injection seam for {@link runCli}'s side effects, so the banner/diagnostic behavior is unit-testable without a TTY. */
export interface CliDeps {
	/** Banner destination; defaults to `process.stdout`. */
	stdout?: BannerStream;
	/** Diagnostics destination; defaults to `process.stderr`. */
	stderr?: BannerStream;
	/** Interactive (TTY) launch? Defaults to `process.stdout.isTTY`. */
	isTTY?: boolean;
}

/**
 * Parse `argv`, print the banner on an interactive launch, and write any
 * diagnostics to stderr. Returns the parsed args for {@link dispatch} to act on.
 * Side effects route through {@link CliDeps} so they're hermetically testable —
 * pass fakes and an explicit `isTTY` to assert banner/diagnostic output without
 * touching the real process streams.
 */
export function runCli(argv: string[], deps: CliDeps = {}): ParsedArgs {
	const parsed = parseArgs(argv);
	const stdout = deps.stdout ?? process.stdout;
	const stderr = deps.stderr ?? process.stderr;
	const interactive = deps.isTTY ?? process.stdout.isTTY === true;
	if (interactive) {
		printBanner(stdout);
	}
	for (const diagnostic of parsed.diagnostics) {
		stderr.write(`${diagnostic.type}: ${diagnostic.message}\n`);
	}
	return parsed;
}

// ---- command dispatch (17o) -------------------------------------------------

/** Where the command handlers write. A structural superset of `process.stdout`/`stderr`. */
export interface CommandIo {
	stdout: BannerStream;
	stderr: BannerStream;
}

/**
 * A `BannerStream` that discards writes. The interactive wizards (`addChannel`/
 * `setSection`) frame themselves with the banner via `runWizard` → `withSession`;
 * but {@link runCli} already printed the session banner on a TTY launch, so
 * passing this as the wizard's `stream` keeps exactly one banner instead of two.
 */
const silentStream: BannerStream = { write: () => false };

/**
 * Injectable seams for {@link dispatch}. Every command handler defaults to its
 * real implementation; tests override `boot` (so the dispatch routing is asserted
 * without starting a server) or the `channel`/`config` handlers (arg → command
 * mapping), and the end-to-end `channel list`/`remove`/`use` path runs the real
 * handlers against an isolated `HOME`. `stdout`/`stderr` default to the process
 * streams.
 */
export interface DispatchDeps {
	stdout?: BannerStream;
	stderr?: BannerStream;
	/** Interactive (TTY) launch? Defaults to `process.stdout.isTTY`. Decides whether a
	 * command-less launch opens the dashboard (TTY) or boots headless (non-TTY). */
	isTTY?: boolean;
	/** The boot path for `start`/default-headless (defaults to the spec-14 {@link main}, lazy-imported so `channel list` etc. never load the server stack). */
	boot?: () => Promise<void>;
	/** The dashboard for a command-less **TTY** launch (defaults to {@link defaultDashboard},
	 * lazy-imported so the pi-tui render lib never loads on the headless path). Returns the
	 * exit code (`0` clean quit, `1` the server could not start). */
	dashboard?: (parsed: ParsedArgs) => Promise<number>;
	/** `channel` subcommand handler (defaults to {@link channelCommand}). */
	channel?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
	/** `config` subcommand handler (defaults to {@link configCommand}). */
	config?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
	/** `auth` subcommand handler (defaults to {@link authCommand}). */
	auth?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
	/** `vm` subcommand handler (defaults to {@link vmCommand}). */
	vm?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
	/** `doctor` handler (defaults to {@link doctorCommand}). */
	doctor?: (io: CommandIo) => Promise<number>;
	/** `monitor` handler (defaults to {@link monitorCommand}). */
	monitor?: (io: CommandIo) => Promise<number>;
}

/**
 * The {@link dispatch} outcome: the process exit code for a completed command
 * (`0` success, `1` handled domain failure, `2` usage error), or `undefined`
 * when the command started the server (`start`/default). The boot handler wires
 * a listening Fastify server whose socket keeps the event loop alive; `main`
 * resolves once setup is done, so dispatch returns `undefined` to tell the
 * auto-run **not** to `process.exit` — the server runs until `SIGINT`/`SIGTERM`,
 * which `main`'s own handlers turn into a clean exit 0.
 */
export type DispatchOutcome = number | undefined;

/**
 * Resolve a parsed argv into a command action and run it. Returns the process
 * exit code for a completed command (`0` success, `1` handled domain failure
 * such as an unknown channel id, `2` usage error) or `undefined` for `start`/
 * default (the server is now running — the auto-run does not `process.exit`).
 * `--help` prints usage and returns `0`; an unwired command prints usage to
 * stderr and returns `2`.
 */
export async function dispatch(parsed: ParsedArgs, deps: DispatchDeps = {}): Promise<DispatchOutcome> {
	const io: CommandIo = { stdout: deps.stdout ?? process.stdout, stderr: deps.stderr ?? process.stderr };
	const boot = deps.boot ?? defaultBoot;
	const dashboard = deps.dashboard ?? defaultDashboard;
	const isTTY = deps.isTTY ?? process.stdout.isTTY === true;
	const channel = deps.channel ?? channelCommand;
	const config = deps.config ?? configCommand;
	const auth = deps.auth ?? authCommand;
	const doctor = deps.doctor ?? doctorCommand;
	const monitor = deps.monitor ?? monitorCommand;
	const vm = deps.vm ?? vmCommand;

	if (parsed.help) {
		io.stdout.write(`${USAGE}\n`);
		return 0;
	}

	switch (parsed.command) {
		case null:
			// A command-less launch in a terminal opens the control-center dashboard,
			// which manages the server (spec 19e). Headless (non-TTY / containers) boots
			// the server directly — the dashboard is an interactive (TTY) affordance.
			if (isTTY) return await dashboard(parsed);
			await boot();
			return undefined; // server running — the event loop (Fastify) keeps the process alive
		case "start":
			// `start` is always headless (the explicit "just run the server" command),
			// even in a terminal — the dashboard is the no-args interactive entry.
			await boot();
			return undefined;
		case "channel":
			return channel(parsed.rest[0], parsed.rest.slice(1), io);
		case "config":
			return config(parsed.rest[0], parsed.rest.slice(1), io);
		case "auth":
			return auth(parsed.rest[0], parsed.rest.slice(1), io);
		case "vm":
			return vm(parsed.rest[0], parsed.rest.slice(1), io);
		case "doctor":
			return doctor(io);
		case "monitor":
			return monitor(io);
		default:
			io.stderr.write(`Unknown command: ${parsed.command}\n\n${USAGE}\n`);
			return 2;
	}
}

/** The default boot — lazy-import the spec-14 `main` so non-boot commands stay light. */
const defaultBoot = async (): Promise<void> => {
	const { main } = await import("./main.ts");
	await main();
};

/**
 * The default dashboard (spec 19e) — lazy-imports the dashboard stack (the pi-tui
 * render lib is a devDep; the headless path never loads it) so `channel list` etc.
 * stay light. Ensures the server is up (spawning it as a child if needed), wires
 * the live status-socket feed + static-channel probe + doctor modal + the status
 * snapshot, and blocks on the dashboard until the operator quits — then the server
 * child is torn down (no orphan). Returns `0` on a clean quit, `1` if the server
 * could not be started (the failure is surfaced on stderr).
 */
const defaultDashboard = async (parsed: ParsedArgs): Promise<number> => {
	const { runDashboard } = await import("./tui/dashboard.ts");
	const { createSocketSubscriber } = await import("./tui/dashboard/socket-client.ts");
	const { createChannelProbe } = await import("./tui/dashboard/channel-probe.ts");
	const { ensureServer, serverArgs } = await import("./tui/dashboard/server-control.ts");

	const settings = loadSettings();
	const config = loadConfig();
	const control = await ensureServer(config, { args: serverArgs(parsed.tunnel, parsed.channel) });
	if (!control.ok) {
		process.stderr.write(`${control.error.message}\n`);
		return 1;
	}
	const { localUrl, token, stop, restart } = control.value;
	// The active channel's public URL reaches the channels panel via the status-socket
	// feed (19c-channel); the status screen's tunnel line is the local endpoint + token
	// for now (a live tunnel URL in the status screen is a future refinement).
	const status: ServerStatusState = { up: true, localUrl, publicUrl: null, token };

	// `doctor` runs CLI-side (`src/tui/` must not import `src/cli/`); the dashboard
	// suspends its loop around this and shows the captured report. The report is the
	// text `doctorCommand` writes to stdout, captured into a string.
	const doctorRunner = async (): Promise<string> => {
		let report = "";
		const sink = {
			write: (chunk: string | Uint8Array): boolean => {
				report += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
				return true;
			},
		};
		await doctorCommand({ stdout: sink });
		return report;
	};

	await runDashboard({
		settings,
		status,
		subscribe: createSocketSubscriber(),
		probeChannels: createChannelProbe({ channels: settings.channels }),
		doctorRunner,
		// Live-apply: a channel mutation that changes `defaultChannel` (adding the
		// first channel, switching default) restarts the owned server child so the
		// fresh boot raises the new channel — no manual quit-and-relaunch.
		restartServer: () => restart(),
		onQuit: async () => {
			const result = await stop();
			if (!result.ok) process.stderr.write(`${result.error.message}\n`);
		},
	});
	return 0;
};

// ---- `channel` subcommands --------------------------------------------------

async function channelCommand(sub: string | undefined, rest: string[], io: CommandIo): Promise<number> {
	switch (sub) {
		case "list":
			return listChannelsCmd(io);
		case "add":
			return await addChannelCmd(rest, io);
		case "remove":
			return removeChannelCmd(rest[0], io);
		case "use":
			return useChannelCmd(rest[0], io);
		default:
			io.stderr.write(`${CHANNEL_USAGE}\n`);
			return 2;
	}
}

/** `channel list` — print every configured channel, marking the default. */
function listChannelsCmd(io: CommandIo): number {
	const settings = loadSettings();
	const channels = listChannels(settings);
	if (channels.length === 0) {
		io.stdout.write("No channels configured. Run `openhammer channel add` to add one.\n");
		return 0;
	}
	io.stdout.write("Channels:\n");
	for (const channel of channels) {
		const mark = channel.id === settings.defaultChannel ? "*" : " ";
		const label = channel.label ? `  ${channel.label}` : "";
		io.stdout.write(`  ${mark} ${channel.id}  ${channel.kind}  ${channel.mode}${label}\n`);
	}
	return 0;
}

/**
 * `channel add` — interactive when flag-less, non-interactive (spec 20g) when any
 * flag is present (`--provider`, `--default`, or a `--<field>` value). The two
 * paths share {@link addChannel} + {@link persistAddedChannel}; only the `io`
 * (real pi-tui prompts vs flag-derived) and the `--default` override differ.
 */
async function addChannelCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const hasFlags = Object.keys(flags.values).length > 0 || flags.bools.size > 0;
	return hasFlags ? addChannelFlags(flags, io) : addChannelInteractive(io);
}

/** `channel add` (interactive) — the add wizard over the registry; persist on success. */
async function addChannelInteractive(io: CommandIo): Promise<number> {
	const settings = loadSettings();
	const result = await addChannel(settings, { stream: silentStream });
	if (result === null) return 0; // cancelled / required-empty — no write, silent
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	persistAddedChannel(result.value, io, false);
	return 0;
}

/**
 * `channel add --provider <kind> [--<field> <value>]... [--default]` (spec 20g) —
 * the non-interactive path. Reuses {@link addChannel} over a flag-derived
 * {@link flagIo} (the picker + each field's flag value, keyed by the wizard's
 * prompt messages — the picker constant + the field labels, so message and key
 * agree by construction). Required fields without a flag are caught up front (a
 * clear usage error, not a silent cancel); `--default` forces the new channel to be
 * the default even when it isn't the first. The probe runs without a spinner
 * (the headless path never loads the TUI-only devDependency) but still gates a
 * static-channel add.
 */
async function addChannelFlags(flags: SubFlags, io: CommandIo): Promise<number> {
	const providerName = flags.values.provider;
	if (providerName === undefined) {
		io.stderr.write("Usage: openhammer channel add --provider <kind> [--<field> <value>]... [--default]\n");
		return 2;
	}
	const providers = registryProviders();
	const provider = providers.find((p) => p.kind === providerName);
	if (!provider) {
		const available = providers.map((p) => p.kind).join(", ");
		io.stderr.write(`Unknown channel provider: ${providerName}. Available: ${available}.\n`);
		return 2;
	}
	// Required fields with no default must arrive as flags; catch them up front for a
	// clear message (the wizard would otherwise cancel silently on a required-empty).
	// (`kind !== "confirm"` narrows to the text/secret/select variants that carry
	// `required` — a confirm always resolves to true/false, never required-empty.)
	const missing = provider.fields
		.filter((f) => f.kind !== "confirm" && f.required && f.default === undefined && flags.values[f.key] === undefined)
		.map((f) => f.key);
	if (missing.length > 0) {
		io.stderr.write(`Missing required field(s) for ${provider.kind}: ${missing.join(", ")}\n`);
		return 2;
	}

	// The flag-derived io: the picker answer + each provided field, keyed by the
	// wizard's prompt messages (the picker constant + the field labels).
	const answers: Record<string, string> = { [CHANNEL_SELECT_PROMPT]: provider.kind };
	for (const field of provider.fields) {
		const v = flags.values[field.key];
		if (v !== undefined) answers[field.label] = v;
	}

	const settings = loadSettings();
	const result = await addChannel(settings, {
		io: flagIo(answers),
		stream: silentStream,
		probeRunner: silentProbeRunner,
	});
	if (result === null) {
		// Defensive — the required-field check above means a null here is unexpected;
		// surface it rather than exit 0 silent.
		io.stderr.write("Channel not added (a required value was missing).\n");
		return 1;
	}
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	persistAddedChannel(result.value, io, flags.bools.has("default"));
	return 0;
}

/** Persist the add result + print the confirmation, honoring `--default` (spec 20g). */
function persistAddedChannel(settings: Settings, io: CommandIo, forceDefault: boolean): void {
	let next = settings;
	const added = next.channels.at(-1);
	if (forceDefault && added !== undefined && next.defaultChannel !== added.id) {
		next = { ...next, defaultChannel: added.id };
	}
	saveSettings(settingsPath(), next);
	const def = added !== undefined && added.id === next.defaultChannel ? " (default)" : "";
	io.stdout.write(`Added ${added?.kind} channel ${added?.id}${def}.\n`);
}

/**
 * A spinner-free probe runner for the non-interactive path (spec 20g): runs the
 * probe but prints nothing — the pi-tui `Loader` spinner is a TUI-only devDependency
 * the headless/server deploy must not load. The probe still gates (a failed
 * static-channel probe → no write), matching the interactive wizard minus the animation.
 */
const silentProbeRunner: ProbeRunner = (_label, fn) => fn();

/** `channel remove <id>` — cascade-delete secrets + drop the entry; persist on success. */
function removeChannelCmd(id: string | undefined, io: CommandIo): number {
	if (!id) {
		io.stderr.write("Usage: openhammer channel remove <id>\n");
		return 2;
	}
	const settings = loadSettings();
	const result = removeChannel(settings, id);
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	saveSettings(settingsPath(), result.value);
	io.stdout.write(`Removed channel ${id}.\n`);
	return 0;
}

/** `channel use <id>` — point the default at an existing channel; persist on success. */
function useChannelCmd(id: string | undefined, io: CommandIo): number {
	if (!id) {
		io.stderr.write("Usage: openhammer channel use <id>\n");
		return 2;
	}
	const settings = loadSettings();
	const result = setDefaultChannel(settings, id);
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	saveSettings(settingsPath(), result.value);
	io.stdout.write(`Default channel set to ${id}.\n`);
	return 0;
}

// ---- `config` subcommands ---------------------------------------------------

async function configCommand(sub: string | undefined, rest: string[], io: CommandIo): Promise<number> {
	switch (sub) {
		case "get":
			return getConfigCmd(io);
		case "set":
			return await setConfigCmd(rest, io);
		default:
			io.stderr.write(`${CONFIG_USAGE}\n`);
			return 2;
	}
}

/** `config get` — print the non-secret settings (the MCP client allowlist + default channel). */
function getConfigCmd(io: CommandIo): number {
	const settings = loadSettings();
	const clients = settings.mcp.allowedClients;
	const any = clients.length === 0 || clients.includes("*");
	io.stdout.write(`Allowed clients: ${any ? "(any)" : clients.join(", ")}\n`);
	io.stdout.write(`Default channel: ${settings.defaultChannel ?? "(none)"}\n`);
	return 0;
}

/**
 * `config set [section]` / `config set <section>.<key> <value>` (spec 20g). A
 * `<section>.<key>` target (contains a dot) is the non-interactive path (a value
 * sets one field); otherwise the interactive section wizard runs (a bare section
 * name, or none, picks the section to edit).
 */
async function setConfigCmd(rest: string[], io: CommandIo): Promise<number> {
	const { positionals } = parseSubFlags(rest);
	const target = positionals[0] ?? "";
	if (target.includes(".")) {
		return setConfigFieldCmd(target, positionals[1], io);
	}
	// Interactive wizard (a bare section name or none).
	if (target !== "" && !(target in CONFIG_SECTIONS)) {
		const available = Object.keys(CONFIG_SECTIONS).join(", ");
		io.stderr.write(`Unknown section: ${target}. Available: ${available}.\n`);
		return 2;
	}
	const settings = loadSettings();
	const result = await setSection(settings, { stream: silentStream });
	if (result === null) return 0; // cancelled / required-empty — no write, silent
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	saveSettings(settingsPath(), result.value);
	io.stdout.write("Settings updated.\n");
	return 0;
}

/**
 * `config set <section>.<key> <value>` (spec 20g) — the non-interactive path. Reuses
 * {@link setSection} over a flag-derived {@link flagIo}: the section picker + the
 * target field (keyed by the wizard's prompt messages). `seedDefaults` covers every
 * other field with its current value, so only the target field changes — identical
 * to editing just that field in the wizard.
 */
async function setConfigFieldCmd(target: string, value: string | undefined, io: CommandIo): Promise<number> {
	if (value === undefined) {
		io.stderr.write("Usage: openhammer config set <section>.<key> <value>\n");
		return 2;
	}
	const dot = target.indexOf(".");
	// `target.includes(".")` is the gate, so `dot >= 0`; the section is everything
	// before the first dot, the key everything after it.
	const sectionId = target.slice(0, dot);
	const key = target.slice(dot + 1);
	const section = CONFIG_SECTIONS[sectionId];
	if (!section) {
		const available = Object.keys(CONFIG_SECTIONS).join(", ");
		io.stderr.write(`Unknown section: ${sectionId}. Available: ${available}.\n`);
		return 2;
	}
	const field = section.fields.find((f) => f.key === key);
	if (!field) {
		const keys = section.fields.map((f) => f.key).join(", ");
		io.stderr.write(`Unknown key: ${key} in section ${sectionId}. Available: ${keys}.\n`);
		return 2;
	}
	const answers: Record<string, string> = { [SECTION_SELECT_PROMPT]: section.id, [field.label]: value };
	const settings = loadSettings();
	const result = await setSection(settings, { io: flagIo(answers), stream: silentStream });
	if (result === null) {
		// Defensive — the field is validated above; a null here is unexpected.
		io.stderr.write("Settings not updated.\n");
		return 1;
	}
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	saveSettings(settingsPath(), result.value);
	io.stdout.write(`Set ${target}.\n`);
	return 0;
}

// ---- `vm` subcommands -------------------------------------------------------

/**
 * `vm` (spec 26): the VM-sandbox command tree. `install` + `provision` + `snapshot` +
 * `list`/`reset`/`gc` exist — `status` is the later spec-27 box and is deliberately absent
 * from the usage string (advertising an unimplemented subcommand would just route the
 * operator into an error).
 */
async function vmCommand(sub: string | undefined, rest: string[], io: CommandIo): Promise<number> {
	switch (sub) {
		case "install":
			return await vmInstallCmd(rest, io);
		case "provision":
			return await vmProvisionCmd(rest, io);
		case "snapshot":
			return await vmSnapshotCmd(rest, io);
		case "list":
			return await vmListCmd(io);
		case "reset":
			return await vmResetCmd(rest, io);
		case "gc":
			return await vmGcCmd(rest, io);
		case undefined:
			io.stderr.write(`${VM_USAGE}\n`);
			return 2;
		default:
			io.stderr.write(
				`vm: unknown subcommand '${sub}' (available: install, provision, snapshot, list, reset, gc)\n\n${VM_USAGE}\n`,
			);
			return 2;
	}
}

/**
 * `vm install [--budget-minutes <n>]` — the thin CLI boundary over 26c's
 * {@link runInstall}: progress lines to stdout, the result summary on success, and the
 * thrown actionable error on stderr with exit 1 (the install runner owns every decision;
 * this only parses flags and prints).
 */
async function vmInstallCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const known = new Set(["budget-minutes"]);
	const unknownFlags = [
		...Object.keys(flags.values).filter((name) => !known.has(name)),
		...flags.bools,
		...flags.unknown,
		...flags.positionals,
	];
	if (unknownFlags.length > 0) {
		io.stderr.write(`Usage: openhammer vm install [--budget-minutes <n>]\n`);
		return 2;
	}
	let budgetMinutes = DEFAULT_BUDGET_MINUTES;
	const raw = flags.values["budget-minutes"];
	if (raw !== undefined) {
		budgetMinutes = Number(raw);
		if (!Number.isFinite(budgetMinutes) || budgetMinutes <= 0) {
			io.stderr.write(`vm install: --budget-minutes must be a positive number (got "${raw}")\n`);
			return 2;
		}
	}
	try {
		const result = await runInstall({ log: (line) => io.stdout.write(`${line}\n`) }, { budgetMinutes });
		io.stdout.write(
			`vm install: done — wall-clock ${result.wallClockSeconds.toFixed(1)} s, ` +
				`disk ${result.diskActualBytes} B actual in ${result.diskVirtualBytes} B virtual, ` +
				`shutdown ${result.shutdownPath}, session ${result.sessionDir}\n`,
		);
		return 0;
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * `vm provision` — the thin CLI boundary over 26d's {@link runProvision}: progress lines
 * to stdout, the checks/prewarm summary on success, and the thrown actionable error on
 * stderr with exit 1 (the provision runner owns every decision; this only parses flags —
 * none exist yet — and prints). Flag-less by design: the pass always targets the most
 * recent install session and is idempotent, so there is nothing to configure.
 */
async function vmProvisionCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const unexpected = [...Object.keys(flags.values), ...flags.bools, ...flags.unknown, ...flags.positionals];
	if (unexpected.length > 0) {
		io.stderr.write(`Usage: openhammer vm provision\n`);
		return 2;
	}
	try {
		const result = await runProvision({ log: (line) => io.stdout.write(`${line}\n`) });
		const passed = result.checks.filter((check) => check.ok).length;
		io.stdout.write(
			`vm provision: done — wall-clock ${result.wallClockSeconds.toFixed(1)} s, ${passed}/${result.checks.length} ` +
				`checks passed, agent prewarm: ${result.agentPrewarm}, session ${result.sessionDir}\n`,
		);
		return 0;
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * `vm snapshot` — the thin CLI boundary over 26e's {@link runSnapshot}: progress lines to
 * stdout (including the licensing note), the golden summary on success, and the thrown
 * actionable error on stderr with exit 1 (the snapshot runner owns every decision; this
 * only parses flags — none exist — and prints). Flag-less by design, like `vm provision`:
 * the promote always targets the most recent provisioned build.
 */
async function vmSnapshotCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const unexpected = [...Object.keys(flags.values), ...flags.bools, ...flags.unknown, ...flags.positionals];
	if (unexpected.length > 0) {
		io.stderr.write(`Usage: openhammer vm snapshot\n`);
		return 2;
	}
	try {
		const result = await runSnapshot({ log: (line) => io.stdout.write(`${line}\n`) });
		io.stdout.write(
			`vm snapshot: done — golden ${result.goldenId} (${result.diskVirtualSizeBytes} B virtual), ` +
				`manifest ${result.manifestPath}\n`,
		);
		return 0;
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * `vm list` — the thin CLI boundary over 26f's {@link vmList}: prints one row per golden
 * (newest first) with the drift notes, and — the spec's edge case surfaced — a `corrupt:`
 * row for a golden whose manifest failed validation, with the WARNING on stderr. Exit 0
 * even with corrupt rows: a degraded tree is exactly what `list` exists to report.
 */
async function vmListCmd(io: CommandIo): Promise<number> {
	let rows: GoldenSummary[];
	try {
		rows = await vmList();
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
	if (rows.length === 0) {
		io.stdout.write("No goldens — run openhammer vm install, vm provision, vm snapshot to build one.\n");
		return 0;
	}
	io.stdout.write("Goldens (newest first):\n");
	for (const row of rows) {
		if (!row.manifestOk) {
			io.stdout.write(`  corrupt: ${row.id} — manifest.json missing or invalid\n`);
			io.stderr.write(
				`vm list: WARNING: golden ${row.id}: manifest.json is missing or invalid — rebuild with vm install\n`,
			);
			continue;
		}
		const actual = row.diskActualBytes > 0 ? `${row.diskActualBytes} B` : "unmeasured";
		io.stdout.write(
			`  ${row.id}  flavor ${row.flavor ?? "?"}  user ${row.guestUser ?? "?"}  built ${row.builtAt ?? "?"}` +
				`  iso ${row.isoVersion ?? "?"}  virtual ${row.diskVirtualSizeBytes ?? "?"} B  actual ${actual}\n`,
		);
		if (row.note !== null) io.stdout.write(`    note: ${row.note}\n`);
	}
	return 0;
}

/**
 * `vm reset [--yes]` — the thin CLI boundary over 26f's {@link vmReset} (the manage.ts
 * confirm precedent: dry run by default, `--yes` removes). Only the `--yes` bool flag is
 * valid; anything else is a usage error before anything runs.
 */
async function vmResetCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const unexpected = [
		...Object.keys(flags.values), // `--yes=…` is rejected too — the bool has no value form
		...[...flags.bools].filter((name) => name !== "yes"),
		...flags.unknown,
		...flags.positionals,
	];
	if (unexpected.length > 0) {
		io.stderr.write(`Usage: openhammer vm reset [--yes]\n`);
		return 2;
	}
	try {
		const report = await vmReset({ log: (line) => io.stdout.write(`${line}\n`) }, { yes: flags.bools.has("yes") });
		io.stdout.write(
			`vm reset: done — ${report.sessions.count} session dir(s), ${report.sessions.bytes} B` +
				`${report.dryRun ? " (dry run — rerun with --yes to remove)" : " removed"}\n`,
		);
		return 0;
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

/**
 * `vm gc [--yes] [--keep-goldens <n>]` — the thin CLI boundary over 26f's {@link vmGc}
 * (the manage.ts confirm precedent: dry run by default, `--yes` reclaims). The keep
 * count must be an integer >= 1 — the newest golden is ALWAYS kept (it is the active
 * one), so keeping zero is a usage error, not a valid reclaim-everything request.
 */
async function vmGcCmd(rest: string[], io: CommandIo): Promise<number> {
	const flags = parseSubFlags(rest);
	const unexpected = [
		...Object.keys(flags.values).filter((name) => name !== "keep-goldens"),
		...[...flags.bools].filter((name) => name !== "yes"),
		...flags.unknown,
		...flags.positionals,
	];
	if (unexpected.length > 0) {
		io.stderr.write(`Usage: openhammer vm gc [--yes] [--keep-goldens <n>]\n`);
		return 2;
	}
	let keepGoldens = DEFAULT_KEEP_GOLDENS;
	const raw = flags.values["keep-goldens"];
	if (raw !== undefined) {
		keepGoldens = Number(raw);
		if (!Number.isInteger(keepGoldens) || keepGoldens < 1) {
			io.stderr.write(`vm gc: --keep-goldens must be an integer >= 1 (got "${raw}")\n`);
			return 2;
		}
	}
	try {
		const report = await vmGc(
			{ log: (line) => io.stdout.write(`${line}\n`) },
			{ yes: flags.bools.has("yes"), keepGoldens },
		);
		const totals =
			`sessions ${report.sessions.count} (${report.sessions.bytes} B), ` +
			`cidata ${report.cidata.count} (${report.cidata.bytes} B), ` +
			`goldens ${report.goldens.count} (${report.goldens.bytes} B)`;
		io.stdout.write(`vm gc: done — ${totals}${report.dryRun ? " (dry run — rerun with --yes to reclaim)" : ""}\n`);
		return 0;
	} catch (error) {
		io.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

// ---- usage text -------------------------------------------------------------

const USAGE = `Usage: openhammer [command] [options]

Commands:
  (no command)           In a terminal: open the control-center dashboard (it
                         starts the server). Otherwise: start the server headless.
  start                  Start the OpenHammer server headless
  channel <subcommand>   Manage channels (how OpenHammer is reached)
    add                    Add a channel (interactive wizard)
    add --provider <kind> [--<field> <value>]... [--default]
                           Add a channel non-interactively (no TTY; e.g.
                           --provider ngrok --authtoken "$T")
    list                   List configured channels
    remove <id>            Remove a channel by id
    use <id>               Set the default channel by id
  config <subcommand>    Manage settings
    get                    Show current settings
    set [section]          Edit a settings section (interactive wizard)
    set <section>.<key> <value>
                           Set one setting non-interactively (e.g.
                           mcp.allowedClients claude-code)
  auth <subcommand>      Manage OAuth clients (client-credentials + auth-code AS)
    add-client             Issue a client (interactive) — secret shown once
    add-client --label <name> [--print-secret]
                           Issue a client non-interactively (--print-secret
                           prints the plaintext secret to stdout for capture)
      add --type authorization_code --redirect-uris <urls>
      [--username <u> --password <p>]   make it an auth-code (login) client
    set-login              Set the global /authorize operator login (interactive)
    set-login --username <u> --password <p>
                           Set the operator login non-interactively
    list                   List registered clients
    remove <client_id>     Remove a client by id
  vm <subcommand>        Manage the local VM sandbox (needs qemu + KVM)
    install               Build the golden Omarchy image unattended
                           (pinned-ISO download on first run; headless boot,
                           ssh readiness gate, clean poweroff)
    provision             Provision the installed build over ssh (idempotent,
                           rerunnable): packages, SDDM autologin, agent
                           defaults, env rc lines, boot hook, host-key capture
    snapshot              Promote the provisioned build to the golden image
                           (disk + installed OVMF VARS moved into images/,
                           host pin copied, 0600 manifest written — a personal
                           artifact)
    list                  List the golden images (disk sizes; a note when
                           guest.json changed since a golden was baked — edits
                           apply on the next vm install; corrupt manifests
                           surfaced, exit 0)
    reset [--yes]         Discard stale (dead-pid) session dirs, keeping live
                           and unverifiable ones (dry run by default; --yes
                           removes; refuses while a session is live)
    gc [--yes] [--keep-goldens <n>]
                           Reclaim stale sessions + orphaned cidata builds +
                           old goldens, with a footprint report (dry run by
                           default; keeps the newest <n> goldens, default 2;
                           refuses while a session is live)
  doctor                 Run diagnostics checks
  monitor                Stream live client + tool-call activity

Options:
  --tunnel               Start the cloudflared quick-tunnel at boot
  --channel <id>         Resolve a persisted channel at boot
  -h, --help             Show this help`;

const CHANNEL_USAGE = `Usage: openhammer channel { add | list | remove <id> | use <id> }`;

const CONFIG_USAGE = `Usage: openhammer config { get | set [section] }`;

/** The vm tree's usage line — only the implemented subcommands are advertised (see vmCommand). */
const VM_USAGE = `Usage: openhammer vm { install | provision | snapshot | list | reset | gc }`;

// Auto-run only when invoked as the entrypoint (the `openhammer` bin), not when
// imported by tests. Matches the T-canary guard: under vitest `process.argv[1]`
// is the runner binary, never this file, so dispatch never fires in a test.
const invokedDirectly = isMainEntry(process.argv[1], import.meta.url);
if (invokedDirectly) {
	const parsed = runCli(process.argv.slice(2));
	// A completed command resolves to its exit code; `start`/default resolves
	// `undefined` (the server is running via Fastify's event loop — do NOT
	// `process.exit`, or the server dies the moment setup finishes). A thrown
	// handler surfaces as a one-line stderr message + exit 1.
	void dispatch(parsed).then(
		(code) => {
			if (typeof code === "number") process.exit(code);
		},
		(error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(message);
			process.exit(1);
		},
	);
}
