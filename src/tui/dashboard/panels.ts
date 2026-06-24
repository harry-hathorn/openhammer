/**
 * The dashboard panels (spec 19b): four PURE `(state) => RenderOutput` renderers —
 * **status**, **channels**, **clients**, **monitor** — plus the composer that lays
 * them out into one frame. Pure = no I/O, no terminal, no render-lib dependency:
 * each takes a state slice and returns screen lines, so the unit tests drive them
 * directly (the `extractTunnelUrl`/`parseClientList` "export the pure testable
 * part" precedent). The render loop (`src/tui/dashboard.ts`) feeds them live state
 * (settings + the status-socket feed, 19c) and drives the renderer (19a).
 *
 * **Reuse, not reimplementation** (spec 19 line 49 — the dashboard is a *view* over
 * the running server): the monitor panel reuses {@link formatEvent} and the clients
 * panel reuses {@link isoTimeOf} from `src/tui/monitor-view.ts` (17t); both panels
 * render the exact shapes the recorder emits — {@link ClientStat}/{@link RequestEvent}
 * from `src/mcp/telemetry.ts` (17s). The channels panel renders {@link ChannelEntry}
 * from `src/config/settings.ts` (17d). There is no second copy of the monitor or
 * channel rendering — one source of truth, used by both the one-line CLI and the
 * dashboard.
 *
 * **Plain text, no ANSI** (a deliberate v1 simplification): every value rendered is
 * ASCII (URLs, tokens, client names, `formatEvent` lines), so line `.length` *is*
 * the visible width and {@link clip} is correct without an ANSI-aware width calc.
 * Color (spec 19 §1.4) is a future polish; keeping the panels ANSI-free keeps the
 * pure functions width-honest and free of the pi-tui devDep (so importing
 * `panels.ts` never pulls the render lib into the unit-test graph).
 *
 * **State model:** {@link DashboardState} is the union of the four panels' inputs.
 * The live slices (`clients`/`monitor`/`channelState`) are populated by 19c (the
 * status-socket client) and 19e (server reachability); 19b renders whatever it is
 * given, so the panels are complete and tested with synthetic state today.
 */
import type { ChannelEntry } from "../../config/settings.ts";
import type { ClientStat, RequestEvent } from "../../mcp/telemetry.ts";
import { formatEvent, isoTimeOf } from "../monitor-view.ts";

/** A panel renders to a list of screen lines — the frame is composed of panels. */
export type RenderOutput = string[];

/**
 * Server reachability for the status panel. `up`/URLs are populated by 19e (which
 * probes the running child's `/health` + reads its banner); {@link emptyStatus} is
 * the pre-reach state shown before the server is contacted.
 */
export interface ServerStatusState {
	/** Is the server up (`GET /health` ok)? */
	up: boolean;
	/** The local MCP endpoint (`http://host:port/mcp`), or `null` if unknown. */
	localUrl: string | null;
	/** A public tunnel/channel URL, or `null`. */
	publicUrl: string | null;
	/** The bearer token (shown once in the status panel), or `null`. */
	token: string | null;
}

/** Fresh "not yet reached" status — what the dashboard shows before 19e contacts the server. */
export function emptyStatus(): ServerStatusState {
	return { up: false, localUrl: null, publicUrl: null, token: null };
}

/**
 * Live reachability of one configured channel (queried in 19c over the status
 * socket). Absent from `DashboardState.channelState` means "unknown" (19c hasn't
 * reported it yet) — distinct from `up:false` (reported down).
 */
export interface ChannelLiveState {
	up: boolean;
	url: string | null;
}

/** The complete dashboard state — the union of the four panels' inputs. */
export interface DashboardState {
	status: ServerStatusState;
	channels: ChannelEntry[];
	defaultChannelId: string | null;
	/** Per-channel live state, keyed by channel id (populated in 19c). */
	channelState: Record<string, ChannelLiveState>;
	/** Active clients (call counts), derived from the status-socket feed in 19c. */
	clients: ClientStat[];
	/** Recent monitor events, newest last (populated in 19c). */
	monitor: RequestEvent[];
	/** Max monitor lines to keep in the feed panel. */
	monitorLimit: number;
}

/** One footer key-menu entry (e.g. `{ key: "q", label: "quit" }`). */
export interface KeyHint {
	key: string;
	label: string;
}

/**
 * The keys wired in 19b — only what actually works in this iteration. `r` forces a
 * full redraw via `renderer.clear()`; `q`/Ctrl+C quits. 19d extends this with the
 * modal keys (`a` add channel / `c` config / `d` doctor); the footer is built from
 * whatever key list the render loop passes, so it never advertises a dead key.
 */
export const DEFAULT_19B_KEYS: ReadonlyArray<KeyHint> = [
	{ key: "r", label: "refresh" },
	{ key: "q", label: "quit" },
];

/**
 * Clip a line to a visible `width`. All dashboard content is ASCII (see the module
 * note), so `.length` is the visible width and a hard slice is correct. A clipped
 * line ends in `›` (one column reserved) so a truncated value is visibly truncated,
 * not silently cut. `width <= 0` returns the line untouched (no clipping requested).
 */
function clip(line: string, width: number): string {
	if (width <= 0 || line.length <= width) return line;
	if (width === 1) return line.slice(0, 1);
	return `${line.slice(0, width - 1)}›`;
}

/**
 * Status panel: server up/down, then the local + tunnel URLs and the token as they
 * become known. A `down` server still lists whatever URLs are known (e.g. the local
 * URL from config) so the operator can see what *should* be reachable.
 */
export function renderStatusPanel(status: ServerStatusState): RenderOutput {
	const lines: RenderOutput = ["STATUS"];
	lines.push(`  server: ${status.up ? "up" : "down"}`);
	if (status.localUrl !== null) lines.push(`  local:  ${status.localUrl}`);
	if (status.publicUrl !== null) lines.push(`  tunnel: ${status.publicUrl}`);
	if (status.token !== null) lines.push(`  token:  ${status.token}`);
	return lines;
}

/**
 * Channels panel: one row per configured channel — default marker (`*`), label,
 * kind, mode, live state, URL. The URL prefers the live channel URL (19c) and falls
 * back to a static channel's declared `options.publicUrl`. Empty state nudges the
 * operator toward the add-channel modal (19d). A live channel with no reported state
 * shows `unknown` (distinct from `down`); a trailing empty URL is trimmed.
 */
export function renderChannelsPanel(state: DashboardState): RenderOutput {
	const lines: RenderOutput = ["CHANNELS"];
	if (state.channels.length === 0) {
		lines.push("  (none configured)");
		return lines;
	}
	for (const ch of state.channels) {
		const marker = ch.id === state.defaultChannelId ? "*" : " ";
		const live = state.channelState[ch.id];
		const liveState = live === undefined ? "unknown" : live.up ? "up" : "down";
		const url = live?.url ?? ch.options.publicUrl ?? "";
		const label = ch.label ?? ch.kind;
		lines.push(` ${marker} ${label}  ${ch.kind}  ${ch.mode}  ${liveState}  ${url}`.trimEnd());
	}
	return lines;
}

/**
 * Clients panel: the active-client set (call counts + last-seen time), reusing
 * {@link isoTimeOf} for a deterministic `HH:MM:SS`. Empty state shows "(none
 * connected)" so a quiet dashboard still frames the panel.
 */
export function renderClientsPanel(clients: ClientStat[]): RenderOutput {
	const lines: RenderOutput = ["CLIENTS"];
	if (clients.length === 0) {
		lines.push("  (none connected)");
		return lines;
	}
	for (const c of clients) {
		const calls = c.calls === 1 ? "1 call" : `${c.calls} calls`;
		lines.push(`  ${c.client}  ${calls}  last ${isoTimeOf(c.lastSeen)}`);
	}
	return lines;
}

/**
 * Monitor panel: the tail of the recent-event ring, one {@link formatEvent} line
 * each (the same formatter `openhammer monitor` uses — single source). `limit`
 * keeps the panel bounded; the render loop caps the ring at the same length so this
 * is a cheap slice. Empty state shows "(quiet — no calls yet)".
 */
export function renderMonitorPanel(events: RequestEvent[], limit: number): RenderOutput {
	const lines: RenderOutput = ["MONITOR"];
	if (events.length === 0) {
		lines.push("  (quiet — no calls yet)");
		return lines;
	}
	const start = Math.max(0, events.length - limit);
	for (const event of events.slice(start)) {
		lines.push(`  ${formatEvent(event)}`);
	}
	return lines;
}

/** Footer key-menu: the key hints joined three-spaces-wide, preceded by a blank rule line. */
export function renderFooter(keys: ReadonlyArray<KeyHint>): RenderOutput {
	const hints = keys.map((k) => `${k.key} ${k.label}`).join("   ");
	return ["", `  ${hints}`];
}

/**
 * Compose the four panels + the footer into one frame, each line clipped to `width`.
 * Sections are separated by a blank line so a panel's header reads as a section.
 * `keys` defaults to {@link DEFAULT_19B_KEYS} (19b's wired keys); 19d passes its
 * fuller key set. Pure — the render loop calls this on every tick with live state.
 */
export function composeDashboard(
	state: DashboardState,
	width: number,
	keys: ReadonlyArray<KeyHint> = DEFAULT_19B_KEYS,
): RenderOutput {
	const sections: RenderOutput[] = [
		renderStatusPanel(state.status),
		renderChannelsPanel(state),
		renderClientsPanel(state.clients),
		renderMonitorPanel(state.monitor, state.monitorLimit),
	];
	const frame: RenderOutput = [];
	for (const section of sections) {
		if (frame.length > 0) frame.push("");
		for (const line of section) frame.push(clip(line, width));
	}
	for (const line of renderFooter(keys)) frame.push(clip(line, width));
	return frame;
}
