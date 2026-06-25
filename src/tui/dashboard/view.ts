/**
 * The dashboard view-models (spec 19 rebuild) — **pure** functions that turn live
 * state into the plain-text rows each screen renders. No terminal, no render-lib
 * (not even pi-tui): they return domain row objects / strings, and the screen
 * components (`screens.ts`) apply color via {@link ../style.ts} and map selectable
 * rows to `SelectItem`s. That split keeps this module maximally testable (the
 * `panels.test.ts` pure-function precedent) and keeps the pi-tui coupling in one
 * place (the components).
 *
 * **Replaces the flat-ASCII panel composition** (`panels.ts`'s
 * `composeDashboard`/`renderXPanel`): those baked layout + clip into `string[]`;
 * these return *values* the components lay out + color + clip. The data shapes are
 * the same source of truth (a channel row mirrors {@link ChannelEntry}; a monitor
 * row is {@link formatEvent}; a status row mirrors {@link ServerStatusState}) —
 * one source, used by both the one-line CLI and the dashboard.
 *
 * **"unknown" vs "down":** a channel absent from `channelState` is `unknown`
 * (not yet reported); `up:false` is reported down — distinct states the channels
 * screen renders differently.
 */
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import { formatEvent } from "../monitor-view.ts";
import type { ChannelLiveState, ServerStatusState } from "./store.ts";

/** A labeled key/value row (status, channel detail, settings). `value` is plain text. */
export interface FieldRow {
	/** The label, e.g. "server", "local", "token". */
	label: string;
	/** The value (URL, token, up/down, …); empty string when absent. */
	value: string;
}

/** One selectable channel row (the Channels screen's list). */
export interface ChannelRow {
	id: string;
	/** Display label (`label ?? kind`). */
	label: string;
	kind: string;
	mode: string;
	live: "up" | "down" | "unknown";
	/** The live or declared URL; "" when none. */
	url: string;
	/** Is this the default channel? */
	isDefault: boolean;
}

/** One selectable OAuth-client row (the Clients screen's list). */
export interface ClientRow {
	clientId: string;
	/** Display label ("(no label)" when blank). */
	label: string;
	createdAt: string;
	/** Display label for the grant type: "login" (authorization code) or "machine" (client credentials). */
	grantType: string;
}

/**
 * A short display label for a client's grant types — "login" when it may use the
 * authorization-code grant (a browser login), else "machine" (client credentials).
 */
export function grantTypeLabel(grantTypes: string[]): string {
	return grantTypes.includes("authorization_code") ? "login" : "machine";
}

/**
 * The channels-screen list. One {@link ChannelRow} per configured channel, in
 * configured order. The URL prefers the live channel URL and falls back to a
 * static channel's declared `publicUrl`; the live state is `unknown` when no
 * report exists yet. Pure — the screen maps these to `SelectItem`s + color.
 */
export function channelRows(
	channels: ChannelEntry[],
	defaultChannelId: string | null,
	channelState: Record<string, ChannelLiveState>,
): ChannelRow[] {
	return channels.map((ch) => {
		const live = channelState[ch.id];
		return {
			id: ch.id,
			label: ch.label ?? ch.kind,
			kind: ch.kind,
			mode: ch.mode,
			live: live === undefined ? "unknown" : live.up ? "up" : "down",
			url: live?.url ?? ch.options.publicUrl ?? "",
			isDefault: ch.id === defaultChannelId,
		};
	});
}

/**
 * The full detail rows for one channel (the ChannelDetail screen). Includes the
 * id, label, kind, mode, default marker, live state, the URL, and any non-secret
 * `options` (e.g. a static channel's `publicUrl`). Pure.
 */
export function channelDetailRows(
	channel: ChannelEntry,
	defaultChannelId: string | null,
	live: ChannelLiveState | undefined,
): FieldRow[] {
	const rows: FieldRow[] = [
		{ label: "id", value: channel.id },
		{ label: "label", value: channel.label ?? "(none)" },
		{ label: "kind", value: channel.kind },
		{ label: "mode", value: channel.mode },
		{ label: "default", value: channel.id === defaultChannelId ? "yes" : "no" },
		{ label: "status", value: live === undefined ? "unknown" : live.up ? "up" : "down" },
		{ label: "url", value: live?.url ?? channel.options.publicUrl ?? "(none)" },
	];
	for (const [key, value] of Object.entries(channel.options)) {
		if (value !== "") rows.push({ label: key, value });
	}
	return rows;
}

/**
 * The status-screen rows: server up/down, then local + tunnel URLs and the token
 * as they become known. A `down` server still lists known URLs so the operator
 * sees what *should* be reachable. Pure.
 */
export function statusRows(status: ServerStatusState): FieldRow[] {
	const rows: FieldRow[] = [{ label: "server", value: status.up ? "up" : "down" }];
	if (status.localUrl !== null) rows.push({ label: "local", value: status.localUrl });
	if (status.publicUrl !== null) rows.push({ label: "tunnel", value: status.publicUrl });
	if (status.token !== null) rows.push({ label: "token", value: status.token });
	return rows;
}

/**
 * The OAuth-clients list rows (id + label + createdAt). A blank label renders as
 * `(no label)`. Empty → `[]` (the screen shows its own empty hint). Pure — the
 * plaintext secret is **never** here (only its hash is persisted); the issue flow
 * reveals it once via {@link secretRevealRows}.
 */
export function clientRows(clients: ClientInfo[]): ClientRow[] {
	return clients.map((c) => ({
		clientId: c.clientId,
		label: c.label.trim() ? c.label : "(no label)",
		createdAt: c.createdAt,
		grantType: grantTypeLabel(c.grantTypes),
	}));
}

/**
 * The one-time plaintext-secret reveal block for a freshly issued client — shown
 * **once**, then never again (only the SHA-256 hash is kept). Re-derived here
 * (pure) rather than imported from `src/cli/auth.ts` (`formatSecretReveal`) so the
 * dashboard stays free of the CLI layer (`src/tui/` must not import `src/cli/`).
 * Pure.
 */
export function secretRevealRows(clientId: string, plaintextSecret: string): string[] {
	return [
		`Issued OAuth client.`,
		"",
		`  client_id:     ${clientId}`,
		`  client_secret: ${plaintextSecret}`,
		"",
		"Store the secret now — it will NOT be shown again.",
		"(Only a SHA-256 hash is kept in ~/.openhammer/credentials.json.)",
	];
}

/**
 * The monitor-screen rows: one {@link formatEvent} line per recent event (the same
 * formatter `openhammer monitor` uses — single source). Empty → `[]`. Pure.
 */
export function monitorRows(events: RequestEvent[]): string[] {
	return events.map((event) => formatEvent(event));
}

/**
 * The settings-screen rows: the MCP allowed-client list (or "(any)" when empty or
 * `["*"]`) and the default channel (or "(none)"). Pure.
 */
export function settingsRows(settings: Settings): FieldRow[] {
	const clients = settings.mcp.allowedClients;
	const any = clients.length === 0 || clients.includes("*");
	return [
		{ label: "allowed clients", value: any ? "(any)" : clients.join(", ") },
		{ label: "default channel", value: settings.defaultChannel ?? "(none)" },
	];
}
