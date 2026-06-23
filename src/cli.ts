#!/usr/bin/env node
/**
 * OpenHammer CLI entrypoint (spec 17n + 17o). `package.json` `bin: openhammer` →
 * `dist/cli.js`. Parses argv with the pure {@link parseArgs} (never throws —
 * unknown options become diagnostics), prints the README banner on an interactive
 * launch, writes diagnostics to stderr, then {@link dispatch}es on `command`.
 *
 * The command dispatch table (17o):
 * - `start` / no command → boot (delegate to the spec-14 {@link main}).
 * - `channel { add | list | remove <id> | use <id> }` — manage channels.
 * - `config { get | set [section] }` — manage settings (default section `mcp`).
 *
 * `doctor` and `monitor` are documented commands whose implementations ship in
 * their own iterations (17p diagnostics registry, 17t monitor socket). Wiring
 * them here would require stubbing those modules — forbidden by the no-stub
 * guardrail — so an as-yet-unwired command falls through to the usage message;
 * 17p/17t add their `case` (the dispatcher is the command registry, each command's
 * case is its entry). `npm start` (`dist/main.js`, spec 14) is unchanged.
 */
import { pathToFileURL } from "node:url";
import { type ParsedArgs, parseArgs } from "./cli/args.ts";
import { CONFIG_SECTIONS } from "./config/sections.ts";
import { loadSettings, saveSettings, settingsPath } from "./config/settings.ts";
import { type BannerStream, printBanner } from "./tui/banner.ts";
import { addChannel } from "./tui/wizards/channel.ts";
import { setSection } from "./tui/wizards/section.ts";
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
	/** The boot path for `start`/default (defaults to the spec-14 {@link main}, lazy-imported so `channel list` etc. never load the server stack). */
	boot?: () => Promise<void>;
	/** `channel` subcommand handler (defaults to {@link channelCommand}). */
	channel?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
	/** `config` subcommand handler (defaults to {@link configCommand}). */
	config?: (sub: string | undefined, rest: string[], io: CommandIo) => Promise<number>;
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
	const channel = deps.channel ?? channelCommand;
	const config = deps.config ?? configCommand;

	if (parsed.help) {
		io.stdout.write(`${USAGE}\n`);
		return 0;
	}

	switch (parsed.command) {
		case "start":
		case null:
			await boot();
			return undefined; // server running — the event loop (Fastify) keeps the process alive
		case "channel":
			return channel(parsed.rest[0], parsed.rest.slice(1), io);
		case "config":
			return config(parsed.rest[0], parsed.rest.slice(1), io);
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

// ---- `channel` subcommands --------------------------------------------------

async function channelCommand(sub: string | undefined, rest: string[], io: CommandIo): Promise<number> {
	switch (sub) {
		case "list":
			return listChannelsCmd(io);
		case "add":
			return await addChannelCmd(io);
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

/** `channel add` — the interactive add wizard; persist the updated doc on success. */
async function addChannelCmd(io: CommandIo): Promise<number> {
	const settings = loadSettings();
	const result = await addChannel(settings, { stream: silentStream });
	if (result === null) return 0; // cancelled / required-empty — no write, silent
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	const added = result.value.channels.at(-1);
	saveSettings(settingsPath(), result.value);
	const def = added !== undefined && added.id === result.value.defaultChannel ? " (default)" : "";
	io.stdout.write(`Added ${added?.kind} channel ${added?.id}${def}.\n`);
	return 0;
}

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
			return await setConfigCmd(rest[0], io);
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
 * `config set [section]` — the interactive section wizard (default section `mcp`).
 * A named section must exist in the registry (only `mcp` ships today); the wizard
 * then picks among the registered sections and edits it. Persist on success.
 */
async function setConfigCmd(section: string | undefined, io: CommandIo): Promise<number> {
	if (section !== undefined && !(section in CONFIG_SECTIONS)) {
		const available = Object.keys(CONFIG_SECTIONS).join(", ");
		io.stderr.write(`Unknown section: ${section}. Available: ${available}.\n`);
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

// ---- usage text -------------------------------------------------------------

const USAGE = `Usage: openhammer [command] [options]

Commands:
  start                  Start the OpenHammer server (default when no command)
  channel <subcommand>   Manage channels (how OpenHammer is reached)
    add                    Add a channel (interactive wizard)
    list                   List configured channels
    remove <id>            Remove a channel by id
    use <id>               Set the default channel by id
  config <subcommand>    Manage settings
    get                    Show current settings
    set [section]          Edit a settings section (default: mcp)
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
