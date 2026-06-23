/**
 * The settings-section registry (spec 17l).
 *
 * A {@link ConfigSection} is "`ConfigField[]` the wizard renders + a place to
 * persist the answers" — the same engine channels use, applied to non-ingress
 * config. The first (and currently only) section is `mcp`, editing
 * `allowedClients`. Adding a section later is one entry here, no wizard change —
 * the scalability seam the channel registry (17g) already proved, re-proven by the
 * section wizard (17l) reusing the generic {@link runWizard} unchanged.
 *
 * **No secrets here.** A section's fields are non-secret config (an allowlist), so
 * unlike channels there is no credentials-store split — `write` just returns the
 * updated {@link Settings} for the CLI to `saveSettings`.
 */

import { parseClientList } from "../config.ts";
import type { ConfigField } from "../tui/schema.ts";
import type { Settings } from "./settings.ts";

/**
 * One settings section. `read` extracts the current values as the string map the
 * wizard seeds from (field key → current string value); `write` applies the
 * wizard's string answers as an immutable {@link Settings} update. `fields` is what
 * the generic `runWizard` renders — declaring a section never touches the wizard.
 */
export interface ConfigSection {
	/** The section id — also the `config set [section]` argument (e.g. `"mcp"`). */
	id: string;
	/** The human label shown in the section-select prompt + the wizard title. */
	label: string;
	/** The field schema the wizard renders. */
	fields: ConfigField[];
	/** Read the current section values as a `key → string` map (wizard seed). */
	read(s: Settings): Record<string, string>;
	/** Apply the wizard's answers as an immutable {@link Settings} update. */
	write(s: Settings, vals: Record<string, string>): Settings;
}

/**
 * The `mcp` settings section — edits `mcp.allowedClients`.
 *
 * The list is a single free-form text field (comma- or newline-separated).
 * `read` joins the current `string[]` (comma + space) for display; `write` parses
 * it back with {@link parseClientList} — the same comma/newline/trim/drop-empty
 * parser {@link resolveConfig} uses for `MCP_ALLOWED_CLIENTS` (single source of the
 * format, so the two paths can never disagree). `[]`/`["*"]` = any client
 * (enforced in the auth middleware, 17r); a non-wildcard list is the User-Agent
 * allowlist.
 */
export const mcpSection: ConfigSection = {
	id: "mcp",
	label: "MCP allowed clients",
	fields: [
		{
			key: "allowedClients",
			label: "Allowed clients",
			kind: "text",
			help: "Comma- or newline-separated User-Agent allowlist. Empty or * = any client.",
		},
	],
	read: (s) => ({ allowedClients: s.mcp.allowedClients.join(", ") }),
	write: (s, vals) => ({ ...s, mcp: { allowedClients: parseClientList(vals.allowedClients ?? "") } }),
};

/**
 * Every registered settings section, keyed by section id. The `config set` flow
 * picks from here; the `config set <id>` form looks up `<id>` directly.
 */
export const CONFIG_SECTIONS: Record<string, ConfigSection> = { mcp: mcpSection };
