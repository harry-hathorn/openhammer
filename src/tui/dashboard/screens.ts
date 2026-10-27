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
import type { VmSettings } from "../../config/settings.ts";
import type { Style } from "../style.ts";
import type { DashboardStore } from "./store.ts";
import {
	type ClientRow,
	channelDetailRows,
	channelRows,
	clientRows,
	type FieldRow,
	grantTypeLabel,
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
 * the long-standing row positions — Settings at 4, Doctor at 5 — stay put).
 * `menuItems` derives its rows — and `menuSectionAt` the focus→section dispatch —
 * from {@link visibleMenuSections}, the one visibility filter over this order, so
 * a row's position and its section can never drift: the single source the
 * dispatch keys on. Every member is always shown (28j: the Sandbox row lost its
 * off-mode invisibility — with Start sandbox + Install reachable from inside it,
 * hiding it made the product's headline feature undiscoverable exactly for the
 * user who hadn't started one yet; the row's SUMMARY carries the honest state).
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
			// Off-and-never-booted reads as the configured posture — "stopped" before
			// any sandbox ever existed would be strange; once a vm mode is set (or any
			// line reported), the live state tail ("ready · session … · ssh :42255") —
			// the same text the Sandbox screen's header row shows, minus its head.
			if (store.settings.vm.mode === "off" && !store.vmObserved) return "off";
			return sandboxStateText(store.latestVmState);
	}
}

/**
 * The menu sections visible for `store` — ALL of them, always (28j): the
 * Sandbox row lost its off-mode invisibility, because hiding it hid Start and
 * Install from exactly the operator who needed them. The one filter both the
 * rendering ({@link menuItems}) and the dispatch ({@link menuSectionAt}) derive
 * from; the parameter stays so the seam survives a future conditional member.
 */
export function visibleMenuSections(_store: DashboardStore): Array<(typeof MENU_SECTIONS)[number]> {
	return [...MENU_SECTIONS];
}

/**
 * The menu row at `focus` — the section it drills into, or `"quit"` for the
 * trailing Quit row (and any focus past it). The root's dispatch keys on THIS
 * (not on a raw `MENU_SECTIONS[focus]` index) so rendering and dispatch walk
 * the same {@link visibleMenuSections} order and can never drift. Pure.
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
		// A server-reported down-reason rides the list row (28j) — never a silent
		// `down` the operator has to drill into (or open a boot log) to explain.
		description: `${r.kind} · ${r.live}${r.error ? ` — ${r.error}` : ""}${r.isDefault ? " · default" : ""}`,
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
	rows.push({ label: "＋  Issue new client…", description: "machine or login — the wizard asks" });
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
export const SANDBOX_CONFIGURE_LABEL = "Configure…";
/**
 * The Guest-setup row's label (spec 28, box 28e) — beside Configure, matched by EXACT
 * match in the root's dispatch like every other Sandbox row. Guest setup is the
 * tier-(a) wizard over the LOCAL `guest.json` (26a) — a build input of this machine's
 * tree, owned-agnostic (see root.ts's action contract).
 */
export const SANDBOX_GUEST_SETUP_LABEL = "Guest setup…";
/**
 * The Secrets row's label (spec 28, box 28f) — the tier-(b) editor over the 0700
 * secrets store (26a), beside Guest setup, matched by EXACT match in the root's
 * dispatch. Owned-agnostic like Guest setup: the store is a local build/runtime
 * input of this machine's tree (the flow owns the row-6 live-session semantics).
 */
export const SANDBOX_SECRETS_LABEL = "Secrets…";
/**
 * The provision.sh row's label (spec 28, box 28g) — the tier-(c) escape hatch
 * (`$EDITOR` over `<vm root>/provision.sh`, created from a commented template on
 * first open), beside Secrets, matched by EXACT match in the root's dispatch.
 * Owned-agnostic like Guest setup/Secrets: a local build input.
 */
export const SANDBOX_PROVISION_LABEL = "Edit provision.sh…";
/**
 * The apply-to-running rows' labels (spec 28, box 28g) — the two curated one-ssh-exec
 * actions against the LIVE guest, matched by EXACT match in the root's dispatch.
 * UNOWNED-FRIENDLY: they take no vmService gate (the guest is addressable from the
 * vm-state line's port + session id plus the vm tree's key/pin — see
 * wizards/guest-setup.ts). Shown ONLY when the vm-state line is ready enough
 * (`applyToRunningReady`) — hidden, not disabled, the row-5 precedent.
 */
export const SANDBOX_APPLY_AGENT_LABEL = "Set default agent…";
export const SANDBOX_APPLY_THEME_LABEL = "Set theme…";
export const SANDBOX_SERIAL_LABEL = "Serial tail";
export const SANDBOX_INSTALL_LABEL = "Install sandbox…";
/**
 * The Start row's label (28j) — the headline one-action launch, TOP of the
 * Sandbox screen whenever no session is live, matched by EXACT match in the
 * root's dispatch like every other Sandbox row. Activation runs the
 * `startSandbox` action (the no-golden guard, the mode pick, the base-flavor
 * confirm, then the dispatch) — see dashboard.ts's `createStartSandboxAction`.
 */
export const SANDBOX_START_LABEL = "Start sandbox…";

/**
 * The Stop row's subtitle — the matrix-row-4 semantics: a stop is a teardown
 * NOW (tools stay sandbox-gated — they break until the sandbox boots again);
 * the lasting off is the Turn-sandboxing-off row, named so the operator
 * lands on it instead of hunting through Configure.
 */
export const SANDBOX_STOP_TEXT = "stop this boot — tools stay sandbox-gated; the lasting off is Turn sandboxing off";

/**
 * The Turn-sandboxing-off row's label — the one-action mode exit the Stop row
 * points at: sets `vm.mode = off`, restarts the owned server (the fresh boot
 * routes tools straight to this machine's filesystem), and never asks the
 * operator to dig through Configure. Matched by EXACT match in the root's
 * dispatch. Hidden when the mode is already `off` (nothing to exit).
 */
export const SANDBOX_OFF_LABEL = "Turn sandboxing off…";

/**
 * The Sandbox screen's action list: — ONLY when no session is live — the top
 * Start sandbox row (28j: the one-action launch — the state row flips to
 * booting), then Stop / Restart / Configure / Guest setup / Secrets / Edit
 * provision.sh / Serial tail, then — ONLY while the vm-state line is ready
 * enough (`applyReady`: a live session with a discovered port, spec 28 box
 * 28g) — the two apply-to-running rows (direct ssh execs at the LIVE guest; no
 * owned-server gate exists for them, so visibility is the only gate), then —
 * ONLY when no bootable golden exists AND no session is active — Install
 * sandbox, then Back. Owned-vs-unowned does NOT change the list: an unowned
 * dashboard renders the same rows and surfaces the unowned hint on activation
 * (never a dead button) — EXCEPT Guest setup, Secrets, and Edit provision.sh,
 * which take no gate at all (editors over the LOCAL vm tree: guest.json is a
 * build input, the secrets store a runtime input, provision.sh an
 * operator-authored build input — not server settings). The Install row is
 * HIDDEN, not disabled, when a golden exists — the spec's "shown only when no
 * golden manifest exists" (matrix row 2's jump target); visibility rides the
 * same probe the vm write guard uses (`goldenManifestExists`), so the
 * affordance and the guard can never disagree. Start and Install are BOTH
 * hidden while a session is active (`sessionActive` — {@link ./view.ts}'s
 * `vmSessionActive` over the store's vm-state line; matrix row 5: install vs a
 * live session is RAM contention + file races, and a live sandbox needs no
 * start) — runInstall's own single-flight scan stays the race authority for
 * the window a vm-state line can't see, and its refusal surfaces inline. Pure.
 */
export function sandboxItems(
	hasGolden: boolean,
	sessionActive = false,
	applyReady = false,
	mode: VmSettings["mode"] = "off",
): ListItem[] {
	const rows: ListItem[] = [];
	if (!sessionActive) {
		// The top row (28j): Start is the headline action, offered exactly when no
		// session is live (stopped/failed/off/no-line); while one boots or runs,
		// Stop/Restart are the levers (hide-don't-disable, the row-5 precedent).
		rows.push({
			label: SANDBOX_START_LABEL,
			description: "boot the sandbox now — the state row flips to booting",
		});
	}
	if (mode !== "off") {
		// The one-action mode exit — shown exactly while sandboxing is ON, so an
		// operator whose tools just broke finds it without a wizard. Hidden when
		// already off (there is nothing to exit).
		rows.push({
			label: SANDBOX_OFF_LABEL,
			description: "tools reach this machine's files again — mode off, applied now",
		});
	}
	rows.push(
		{ label: SANDBOX_STOP_LABEL, description: SANDBOX_STOP_TEXT },
		{
			label: SANDBOX_RESTART_LABEL,
			description: "stop, then a fresh boot (retain reuses the overlay, discard is fresh)",
		},
		{ label: SANDBOX_CONFIGURE_LABEL, description: "the vm settings section — boot mode, memory, persist…" },
		{
			label: SANDBOX_GUEST_SETUP_LABEL,
			description: "the guest's build config — what the next `vm install` bakes (guest.json)",
		},
		{
			label: SANDBOX_SECRETS_LABEL,
			description: "env pairs + credential files — the 0700 store (loads at sandbox boot)",
		},
		{
			label: SANDBOX_PROVISION_LABEL,
			description: "the operator's provision.sh escape hatch in $EDITOR (runs at `vm provision`)",
		},
		{ label: SANDBOX_SERIAL_LABEL, description: "read-only tail of the session's serial.log" },
	);
	if (applyReady) {
		rows.push(
			{
				label: SANDBOX_APPLY_AGENT_LABEL,
				description: "write ~/.config/omarchy/defaults/agent in the running guest over ssh",
			},
			{ label: SANDBOX_APPLY_THEME_LABEL, description: "omarchy theme set — the list fetched from the guest" },
		);
	}
	if (!hasGolden && !sessionActive) {
		rows.push({
			label: SANDBOX_INSTALL_LABEL,
			description: "no golden yet — build it here (the vm install flow; takes minutes)",
		});
	}
	rows.push({ label: "Back", description: "to menu" });
	return rows;
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
