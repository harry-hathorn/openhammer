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
 * - `doctor` — run the diagnostics registry + per-channel checks (17p).
 * - `monitor` — stream live client + tool-call activity over the status socket (17t).
 *
 * `npm start` (`dist/main.js`, spec 14) is unchanged.
 */
import { pathToFileURL } from "node:url";
import { type ParsedArgs, parseArgs } from "./cli/args.ts";
import { authCommand } from "./cli/auth.ts";
import { doctorCommand } from "./cli/doctor.ts";
import { parseSubFlags, type SubFlags } from "./cli/flags.ts";
import { monitorCommand } from "./cli/monitor.ts";
import { CONFIG_SECTIONS } from "./config/sections.ts";
import { loadSettings, type Settings, saveSettings, settingsPath } from "./config/settings.ts";
import { loadConfig } from "./config.ts";
import { type BannerStream, printBanner } from "./tui/banner.ts";
import type { ServerStatusState } from "./tui/dashboard/panels.ts";
import { flagIo } from "./tui/prompts.ts";
import { addChannel, CHANNEL_SELECT_PROMPT, type ProbeRunner, registryProviders } from "./tui/wizards/channel.ts";
import { SECTION_SELECT_PROMPT, setSection } from "./tui/wizards/section.ts";
import { listChannels, removeChannel, setDefaultChannel } from "./tunnel/manage.ts";

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
	const { createDashboardRenderer } = await import("./tui/dashboard/render.ts");
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
	const { localUrl, token, stop } = control.value;
	// The active channel's public URL reaches the channels panel via the status-socket
	// feed (19c-channel); the status panel's tunnel line is the local endpoint + token
	// for now (a live tunnel URL in the status panel is a future refinement).
	const status: ServerStatusState = { up: true, localUrl, publicUrl: null, token };

	await runDashboard({
		renderer: createDashboardRenderer(),
		settings,
		status,
		subscribe: createSocketSubscriber(),
		probeChannels: createChannelProbe({ channels: settings.channels }),
		doctorModal: () => doctorCommand({ stdout: process.stdout }),
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
  auth <subcommand>      Manage OAuth clients (client-credentials AS)
    add-client             Issue a client (interactive) — secret shown once
    add-client --label <name> [--print-secret]
                           Issue a client non-interactively (--print-secret
                           prints the plaintext secret to stdout for capture)
    list                   List registered clients
    remove <client_id>     Remove a client by id
  doctor                 Run diagnostics checks
  monitor                Stream live client + tool-call activity

Options:
  --tunnel               Start the cloudflared quick-tunnel at boot
  --channel <id>         Resolve a persisted channel at boot
  -h, --help             Show this help`;

const CHANNEL_USAGE = `Usage: openhammer channel { add | list | remove <id> | use <id> }`;

const CONFIG_USAGE = `Usage: openhammer config { get | set [section] }`;

// Auto-run only when invoked as the entrypoint (the `openhammer` bin), not when
// imported by tests. Matches the T-canary guard: under vitest `process.argv[1]`
// is the runner binary, never this file, so dispatch never fires in a test.
const invokedDirectly = typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;
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
