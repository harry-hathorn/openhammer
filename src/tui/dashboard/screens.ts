/**
 * The dashboard screens' pure builders + render helpers (spec 19 rebuild). This
 * module holds **no state and no input handling** — it turns live state (the
 * {@link DashboardStore}) into the list items / header lines each screen shows, and
 * renders a focused list with the colored two-column layout. The stateful
 * orchestrator (`root.ts`'s {@link DashboardRoot}) owns the focus index + screen
 * state and calls these; the key routing lives there.
 *
 * **Why manual lists over `SelectList`:** the dashboard is a multi-screen app where
 * every screen is a focused list (the menu, channels, clients, per-detail actions).
 * `SelectList` is stateful (it holds its own `selectedIndex`) and bakes its items
 * at construction, so showing *live* summaries (e.g. "2 configured") would mean
 * rebuilding the list each tick and losing the cursor. A manual list with a
 * root-owned `focus` index renders fresh data every frame for free and keeps the
 * cursor stable — the `packages/.../tui.md` "custom component" pattern
 * (`matchesKey(data, Key.up)` + a `selected` prefix). The colored two-column
 * layout (selected row `→ label  summary` in accent+bold, others plain) mirrors
 * the approved menu mock.
 *
 * Pure: reads state, returns data/lines; no terminal, no input. Unit-tested
 * directly (the `view.test.ts` precedent).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Style } from "../style.ts";
import type { DashboardStore } from "./store.ts";
import {
	type ClientRow,
	channelDetailRows,
	channelRows,
	clientRows,
	type FieldRow,
	grantTypeLabel,
	sandboxEntryVisible,
	sandboxStateText,
} from "./view.ts";

/** One selectable list row: a `label` plus an optional right-column `description`. */
export interface ListItem {
	label: string;
	/** Right-column summary (muted); omitted renders label only. */
	description?: string;
}

/**
 * A screen's render spec: the focused list + optional header lines (field rows for
 * detail screens) + the footer hint. The root builds this per frame from the store
 * + the current screen state; {@link DashboardRoot.render} lays it out.
 */
export interface ScreenSpec {
	/** The focused list rows. */
	items: ListItem[];
	/** Lines shown above the list (e.g. a channel/client detail header). */
	header?: string[];
	/** The footer key-hint for this screen. */
	hint: string;
}

/**
 * The menu's section rows, in display/dispatch order (Sandbox last — appended so
 * the long-standing row positions — Settings at 4, Doctor at 5 — never shift for
 * an off-mode user). `menuItems` derives its rows — and `menuSectionAt` the
 * focus→section dispatch — from {@link visibleMenuSections}, the one visibility
 * filter over this order, so a row's position and its section can never drift:
 * the single source the dispatch keys on. The Sandbox row is the one conditional
 * member (off-mode invisibility, spec 28); every other section is always shown.
 */
export const MENU_SECTIONS = ["status", "channels", "clients", "monitor", "settings", "doctor", "sandbox"] as const;

/** The menu label for each section (kept beside {@link MENU_SECTIONS} so they agree). */
const SECTION_LABELS: Record<(typeof MENU_SECTIONS)[number], string> = {
	status: "Status",
	channels: "Channels",
	clients: "Clients & login",
	monitor: "Monitor",
	settings: "Settings",
	doctor: "Doctor",
	sandbox: "Sandbox",
};

/**
 * The Clients-screen "set operator login" row label (routed by exact match in the root — no
 * glyph, so it is portable and unambiguous alongside the `＋` issue row). Exported so the root
 * and {@link clientItems} share the single source.
 */
export const SET_LOGIN_LABEL = "Set operator login…";

/** A short live summary of a slice, for the menu's right column (e.g. "2 configured"). */
function summarizeSection(section: (typeof MENU_SECTIONS)[number], store: DashboardStore): string {
	switch (section) {
		case "status":
			return store.status.up ? "server up" : "server down";
		case "channels": {
			const n = store.channels.length;
			return n === 0 ? "none configured" : n === 1 ? "1 configured" : `${n} configured`;
		}
		case "clients": {
			// The login gate is the urgent signal — surface an unset login at the menu level
			// (it's why login clients can't connect); otherwise show the client count.
			if (!store.loginConfigured) return "login NOT set";
			const n = store.oauthClients.length;
			return n === 0 ? "none issued" : n === 1 ? "1 client" : `${n} clients`;
		}
		case "monitor":
			return store.monitorEvents.length === 0 ? "quiet" : "live";
		case "settings":
			return store.defaultChannelId ?? "no default";
		case "doctor":
			return "run diagnostics";
		case "sandbox":
			// The live state tail ("ready · session … · ssh :42255") — the same text
			// the Sandbox screen's header row shows, minus its `Sandbox  ` head.
			return sandboxStateText(store.latestVmState);
	}
}

/**
 * The menu sections visible for `store` — every {@link MENU_SECTIONS} member
 * except a hidden Sandbox (spec 28 off-mode invisibility: `sandboxEntryVisible`
 * is false while the loaded settings' vm mode is `off` AND no vm-state line has
 * ever reported a live lifecycle). The one filter both the rendering
 * ({@link menuItems}) and the dispatch ({@link menuSectionAt}) derive from.
 */
export function visibleMenuSections(store: DashboardStore): Array<(typeof MENU_SECTIONS)[number]> {
	return MENU_SECTIONS.filter(
		(section) => section !== "sandbox" || sandboxEntryVisible(store.settings.vm.mode, store.vmObserved),
	);
}

/**
 * The menu row at `focus` — the section it drills into, or `"quit"` for the
 * trailing Quit row (and any focus past it). The root's dispatch keys on THIS
 * (not on a raw `MENU_SECTIONS[focus]` index) so a hidden Sandbox row shifts the
 * Quit row's position without misrouting: rendering and dispatch walk the same
 * {@link visibleMenuSections} order. Pure.
 */
export function menuSectionAt(store: DashboardStore, focus: number): (typeof MENU_SECTIONS)[number] | "quit" {
	const sections = visibleMenuSections(store);
	return focus >= sections.length ? "quit" : sections[focus];
}

/**
 * The main-menu rows: one per visible section ({@link visibleMenuSections} —
 * label + live summary) then a trailing `Quit` row. Summaries read the store
 * fresh, so returning to the menu always shows current data. Pure.
 */
export function menuItems(store: DashboardStore): ListItem[] {
	const rows: ListItem[] = visibleMenuSections(store).map((section) => ({
		label: SECTION_LABELS[section],
		description: summarizeSection(section, store),
	}));
	rows.push({ label: "Quit", description: "exit OpenHammer" });
	return rows;
}

/**
 * The channels-screen rows: one per configured channel (label = display name,
 * description = `kind · live state`), then a trailing "add" row. Empty → just the
 * add row. Pure.
 */
export function channelItems(store: DashboardStore): ListItem[] {
	const rows: ListItem[] = channelRows(store.channels, store.defaultChannelId, store.channelState).map((r) => ({
		label: r.label,
		description: `${r.kind} · ${r.live}${r.isDefault ? " · default" : ""}`,
	}));
	rows.push({ label: "＋  Add a channel…", description: "run the wizard" });
	return rows;
}

/**
 * The channel-detail header rows (the channel's full field detail) + the action
 * list (use-as-default when not default / remove / back). Pure.
 */
export function channelDetailSpec(
	store: DashboardStore,
	id: string,
	style: Style,
): { header: string[]; items: ListItem[] } {
	const channel = store.channels.find((c) => c.id === id);
	const live = store.channelState[id];
	// A missing channel (removed mid-view) renders an empty header + just "Back".
	const fieldRows: FieldRow[] = channel ? channelDetailRows(channel, store.defaultChannelId, live) : [];
	const items: ListItem[] = [];
	if (channel && channel.id !== store.defaultChannelId) {
		items.push({ label: "Use as default", description: "set the default channel" });
	}
	if (channel) items.push({ label: "Remove", description: "delete this channel" });
	items.push({ label: "Back", description: "to channels" });
	return { header: renderFieldRows(fieldRows, style), items };
}

/**
 * The clients-screen rows: one per registered OAuth client (label = display label,
 * description = client id prefix + created), then a trailing "issue" row. Pure.
 */
export function clientItems(store: DashboardStore): ListItem[] {
	const rows: ListItem[] = [
		{
			label: SET_LOGIN_LABEL,
			description: store.loginConfigured
				? "change the operator username + password"
				: "set the login that authorizes connecting MCP clients",
		},
		...clientRows(store.oauthClients).map((c: ClientRow) => ({
			label: c.label,
			description: `${c.clientId} · ${c.grantType} · ${c.createdAt}`,
		})),
	];
	rows.push({ label: "＋  Issue new client…", description: "machine client — label + secret" });
	return rows;
}

/**
 * The client-detail header rows + action list (remove / back). Pure. (The plaintext
 * secret is never part of a stored client — only its hash — so it is not here; the
 * issue flow reveals it once out-of-band.)
 */
export function clientDetailSpec(
	store: DashboardStore,
	clientId: string,
	style: Style,
): { header: string[]; items: ListItem[] } {
	const client = store.oauthClients.find((c) => c.clientId === clientId);
	const fieldRows: FieldRow[] = [];
	if (client) {
		fieldRows.push(
			{ label: "client_id", value: client.clientId },
			{ label: "label", value: client.label },
			{ label: "type", value: grantTypeLabel(client.grantTypes) },
			{ label: "created", value: client.createdAt },
			{ label: "client_secret", value: "(shown once at issue — only the hash is kept)" },
		);
		if (client.username !== undefined) fieldRows.push({ label: "username", value: client.username });
		if (client.redirectUris !== undefined && client.redirectUris.length > 0) {
			fieldRows.push({ label: "redirect_uris", value: client.redirectUris.join(", ") });
		}
	}
	const items: ListItem[] = [];
	if (client) items.push({ label: "Remove", description: "delete this client" });
	items.push({ label: "Back", description: "to clients" });
	return { header: renderFieldRows(fieldRows, style), items };
}

/** The settings-screen rows: edit (runs the section wizard) + back. Pure. */
export function settingsItems(): ListItem[] {
	return [
		{ label: "Edit settings…", description: "allowed clients · default channel" },
		{ label: "Back", description: "to menu" },
	];
}

/** The doctor-screen rows: run (or re-run) + back. Pure. */
export function doctorItems(): ListItem[] {
	return [
		{ label: "Run doctor", description: "run diagnostics checks" },
		{ label: "Back", description: "to menu" },
	];
}

// ---- the Sandbox screen's action rows (spec 28, box 28b) ------------------------

/**
 * The Sandbox screen's action-row labels — matched by EXACT match in the root's
 * dispatch (the SET_LOGIN_LABEL precedent: no glyph, portable, unambiguous).
 * Exported so the root and {@link sandboxItems} share the single source.
 */
export const SANDBOX_STOP_LABEL = "Stop sandbox…";
export const SANDBOX_RESTART_LABEL = "Restart sandbox…";
export const SANDBOX_SERIAL_LABEL = "Serial tail";

/**
 * The Stop row's subtitle — the matrix-row-4 semantics verbatim: a stop is a
 * teardown NOW; the boot-scoped mode re-boots the sandbox on the next server
 * start, and the lasting stop is mode `off` + restart (with the row-1 channel
 * warning when a public channel is configured).
 */
export const SANDBOX_STOP_TEXT =
	"power down now — the boot-scoped mode re-boots the sandbox on the next server start (lasting stop: mode off + restart)";

/**
 * The Sandbox screen's action list: Stop / Restart / Serial tail, then Back.
 * Off-mode users never see these — the actions live inside the drill-in screen,
 * which inherits 28a's off-mode invisibility (the menu row is hidden entirely).
 * Owned-vs-unowned does NOT change the list: an unowned dashboard renders the
 * same rows and surfaces the unowned hint on activation (never a dead button).
 * Pure.
 */
export function sandboxItems(): ListItem[] {
	return [
		{ label: SANDBOX_STOP_LABEL, description: SANDBOX_STOP_TEXT },
		{
			label: SANDBOX_RESTART_LABEL,
			description: "stop, then a fresh boot (retain reuses the overlay, discard is fresh)",
		},
		{ label: SANDBOX_SERIAL_LABEL, description: "read-only tail of the session's serial.log" },
		{ label: "Back", description: "to menu" },
	];
}

/**
 * Render a focused list: the selected row gets a `→ ` marker + accent+bold, others
 * a `  ` marker; labels are aligned to the widest, descriptions follow in muted.
 * ANSI-aware alignment (padding computed from `visibleWidth`, which ignores SGR
 * codes) + a final `truncateToWidth` so no line exceeds `width`. Pure.
 */
export function renderList(items: ReadonlyArray<ListItem>, focus: number, style: Style, width: number): string[] {
	const labelWidth = items.reduce((max, item) => Math.max(max, visibleWidth(item.label)), 0);
	return items.map((item, i) => {
		const selected = i === focus;
		const marker = selected ? "→ " : "  ";
		const label = selected ? style.bold(style.accent(item.label)) : item.label;
		const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(item.label)));
		const desc = item.description ? `   ${style.muted(item.description)}` : "";
		return truncateToWidth(`  ${marker}${label}${pad}${desc}`, width, "");
	});
}

/**
 * Render key/value field rows as `  label  value` lines — label muted, value plain
 * (URLs/tokens left uncolored so they copy cleanly). Each row is truncated to
 * `width`. Pure; the detail screens use this for their headers.
 */
export function renderFieldRows(rows: ReadonlyArray<FieldRow>, style: Style): string[] {
	const labelWidth = rows.reduce((max, r) => Math.max(max, visibleWidth(r.label)), 0);
	return rows.map((row) => {
		const pad = " ".repeat(Math.max(0, labelWidth - visibleWidth(row.label)));
		return `  ${style.muted(row.label)}${pad}  ${row.value}`;
	});
}

/** The dashboard title line (compact colored header — the giant banner prints once at startup, above the TUI). */
export function titleLine(style: Style): string {
	return style.bold(style.accent("OpenHammer"));
}

/**
 * The footer key-hint line: `hint` (muted) — the root composes the per-screen hint.
 * Kept here so the hint style is consistent across screens.
 */
export function footerLine(hint: string, style: Style): string {
	return style.dim(hint);
}
