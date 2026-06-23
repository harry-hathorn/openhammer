/**
 * CLI argument parsing (spec 17n). Mirrors pi's `src/cli/args.ts` shape — a
 * pure, total parser that **never throws**: unknown options and missing values
 * are collected into `diagnostics` for the dispatcher to surface, not raised.
 *
 * The parser knows OpenHammer's flags (`--tunnel`, `--channel <id>`, `--help`)
 * and treats the first positional as the `command` word; every positional after
 * it is `rest` (subcommand + operands). It deliberately does **not** validate
 * the command set — the dispatcher (17o) owns that mapping, so adding a command
 * needs no parser edit. `deps: none` — this module imports nothing.
 */

/** A non-fatal parse finding; surfaced by the CLI, never thrown. Matches pi's shape verbatim. */
export interface Diagnostic {
	type: "warning" | "error";
	message: string;
}

/** {@link parseArgs} result: the command word, trailing positionals, known flags, and findings. */
export interface ParsedArgs {
	/** First positional (e.g. `channel`/`config`/`doctor`/`monitor`/`start`); `null` = default (boot). */
	command: string | null;
	/** Positionals after `command` (subcommand + operands), in order. */
	rest: string[];
	/** `--tunnel` — start the optional cloudflared quick-tunnel at boot. */
	tunnel: boolean;
	/** `--channel <id>` — resolve a persisted channel at boot. */
	channel: string | undefined;
	/** `--help` / `-h` — the dispatcher prints help. */
	help: boolean;
	/** Unknown options / missing values. Never throws. */
	diagnostics: Diagnostic[];
}

/**
 * Parse `argv` (the slice after `node cli.js`) into a {@link ParsedArgs}.
 * Pure and total — every input produces a result; problems land in `diagnostics`.
 */
export function parseArgs(argv: string[]): ParsedArgs {
	const result: ParsedArgs = {
		command: null,
		rest: [],
		tunnel: false,
		channel: undefined,
		help: false,
		diagnostics: [],
	};

	let commandSeen = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];

		// `--flag=value` form (split on the first `=`).
		if (arg.startsWith("--") && arg.includes("=")) {
			const eq = arg.indexOf("=");
			const name = arg.slice(0, eq);
			const value = arg.slice(eq + 1);
			if (name === "--channel") {
				result.channel = value;
			} else {
				result.diagnostics.push({ type: "warning", message: `Unknown option: ${name}` });
			}
			continue;
		}

		if (arg === "--tunnel") {
			result.tunnel = true;
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			result.help = true;
			continue;
		}
		if (arg === "--channel") {
			// A dash-leading next token is another flag, not the value.
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				result.channel = argv[i + 1];
				i++;
			} else {
				result.diagnostics.push({ type: "error", message: "Option --channel requires a value" });
			}
			continue;
		}

		// Unknown long option → warning (recoverable; likely a typo).
		if (arg.startsWith("--")) {
			result.diagnostics.push({ type: "warning", message: `Unknown option: ${arg}` });
			continue;
		}
		// Unknown short option → error (OpenHammer uses no single-dash flags but `-h`).
		if (arg.length > 1 && arg.startsWith("-")) {
			result.diagnostics.push({ type: "error", message: `Unknown option: ${arg}` });
			continue;
		}

		// Positional: the first is the command word, the rest trail it.
		if (!commandSeen) {
			result.command = arg;
			commandSeen = true;
		} else {
			result.rest.push(arg);
		}
	}

	return result;
}
