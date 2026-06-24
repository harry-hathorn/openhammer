/**
 * Subcommand flag parsing (spec 20g). The top-level {@link parseArgs} extracts the
 * command word + the recognized top-level flags (`--tunnel`/`--channel`/`--help`)
 * and passes every **unknown** `--flag` after the command through to `rest`
 * untouched. This module turns that raw token stream into the three shapes a
 * subcommand handler cares about: value-flags (`--name value` / `--name=value`),
 * boolean flags (`--name`), and trailing positionals (`<id>`, `<section>.<key>`,
 * `<value>`).
 *
 * Pure and total — like {@link parseArgs}, it never throws; an unrecognized
 * short option lands in `unknown` for the handler to surface (OpenHammer's
 * subcommands use long flags only). The handler owns which flags are valid
 * (`--provider`/`--authtoken`/`--default` for `channel add`; `--label`/
 * `--print-secret` for `auth add-client`) — this parser is schema-free so it
 * serves every subcommand without an edit per flag.
 */

/** The parsed shape of a subcommand's token stream. */
export interface SubFlags {
	/** `--name value` (space form) and `--name=value` (equals form), by flag name (no `--`). */
	values: Record<string, string>;
	/** `--name` with no following value (a boolean flag), by flag name. */
	bools: Set<string>;
	/** Non-flag tokens, in order (operands: `<id>`, `<section>.<key>`, `<value>`). */
	positionals: string[];
	/** Unrecognized single-dash tokens (OpenHammer subcommands use long flags only). */
	unknown: string[];
}

/**
 * Parse a subcommand's token stream (the slice after the subcommand word) into
 * value-flags, boolean-flags, and positionals. Conventions:
 * - `--name value` → `values.name = value` (the next token is the value unless it
 *   itself starts with `-` or is absent).
 * - `--name=value` → `values.name = value` (a value may begin with `-`).
 * - `--name` at the tail or immediately before another flag → `bools.add(name)`.
 * - `--` → everything after is positional (the standard sentinel).
 * - a token starting with a single `-` (and longer than one char) → `unknown`.
 * - any other token → `positionals`.
 *
 * A value can therefore be passed as `--authtoken "$T"` or `--authtoken="$T"`; a
 * value that itself begins with `-` must use the `=` form.
 */
export function parseSubFlags(tokens: string[]): SubFlags {
	const values: Record<string, string> = {};
	const bools = new Set<string>();
	const positionals: string[] = [];
	const unknown: string[] = [];

	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok === undefined) break;

		// `--` sentinel: everything after is positional.
		if (tok === "--") {
			positionals.push(...tokens.slice(i + 1));
			break;
		}

		// Long option: `--name=value` or `--name [value]`.
		if (tok.startsWith("--")) {
			const eq = tok.indexOf("=");
			if (eq >= 0) {
				values[tok.slice(2, eq)] = tok.slice(eq + 1);
				continue;
			}
			const name = tok.slice(2);
			const next = tokens[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
				values[name] = next;
				i++;
			} else {
				bools.add(name);
			}
			continue;
		}

		// Unrecognized single-dash token (no subcommand uses short flags).
		if (tok.length > 1 && tok.startsWith("-")) {
			unknown.push(tok);
			continue;
		}

		positionals.push(tok);
	}

	return { values, bools, positionals, unknown };
}
