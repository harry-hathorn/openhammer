#!/usr/bin/env node
/**
 * OpenHammer CLI entrypoint (spec 17n). `package.json` `bin: openhammer` →
 * `dist/cli.js`. Parses argv with the pure {@link parseArgs} (never throws —
 * unknown options become diagnostics), prints the README banner on an
 * interactive launch, and writes diagnostics to stderr.
 *
 * This module ships the **parse + interactive-banner** seam. The command
 * dispatcher (`channel`/`config`/`doctor`/`monitor`/`start` → boot) lands in a
 * follow-up (17o); `runCli` returns the parsed args so that dispatcher can act
 * on `command`/`rest`/flags without re-parsing. `npm start` (`dist/main.js`,
 * spec 14) is unchanged — the bin is the operator-facing entry this grows into.
 */
import { pathToFileURL } from "node:url";
import { type ParsedArgs, parseArgs } from "./cli/args.ts";
import { type BannerStream, printBanner } from "./tui/banner.ts";

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
 * diagnostics to stderr. Returns the parsed args for the dispatcher (17o) to
 * act on. Side effects route through {@link CliDeps} so they're hermetically
 * testable — pass fakes and an explicit `isTTY` to assert banner/diagnostic
 * output without touching the real process streams.
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

// Auto-run only when invoked as the entrypoint (the `openhammer` bin), not when
// imported by tests. Matches the T-canary guard: under vitest `process.argv[1]`
// is the runner binary, never this file, so the banner never fires in a test.
const invokedDirectly = typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
	runCli(process.argv.slice(2));
}
