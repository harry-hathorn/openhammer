import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ChannelEntry } from "../../config/settings.ts";
import { defaultVmSettings, type VmSettings } from "../../config/settings.ts";
import type { VmStateLine } from "../../observability/status-socket.ts";
import { createStyle } from "../style.ts";
import {
	channelDetailSpec,
	channelItems,
	clientDetailSpec,
	clientItems,
	doctorItems,
	MENU_SECTIONS,
	menuItems,
	menuSectionAt,
	renderFieldRows,
	renderList,
	SANDBOX_APPLY_AGENT_LABEL,
	SANDBOX_APPLY_THEME_LABEL,
	SANDBOX_CONFIGURE_LABEL,
	SANDBOX_GUEST_SETUP_LABEL,
	SANDBOX_INSTALL_LABEL,
	SANDBOX_OFF_LABEL,
	SANDBOX_PROVISION_LABEL,
	SANDBOX_RESTART_LABEL,
	SANDBOX_SECRETS_LABEL,
	SANDBOX_SERIAL_LABEL,
	SANDBOX_START_LABEL,
	SANDBOX_STOP_LABEL,
	SET_LOGIN_LABEL,
	sandboxItems,
	settingsItems,
	visibleMenuSections,
} from "./screens.ts";
import { DashboardStore } from "./store.ts";

const ch = (over: Partial<ChannelEntry> = {}): ChannelEntry => ({
	id: "c1",
	kind: "ngrok",
	mode: "live",
	options: {},
	...over,
});

function storeWith(channels: ChannelEntry[] = [], defaults: Record<string, unknown> = {}): DashboardStore {
	const s = new DashboardStore(
		{},
		{ version: 1, channels, defaultChannel: null, mcp: { allowedClients: [] }, vm: defaultVmSettings() },
	);
	if (defaults.status) s.setStatus(defaults.status as never);
	return s;
}

describe("screens — menuItems", () => {
	it("yields one row per section (in MENU_SECTIONS order) then Quit", () => {
		const items = menuItems(new DashboardStore());
		// Every section is always visible (28j): a fresh off-mode menu is ALL the
		// sections — the sandbox is discoverable before it exists — then Quit.
		expect(items.map((i) => i.label)).toEqual([...MENU_SECTIONS.map(() => expect.any(String)), "Quit"]);
		expect(items.length).toBe(MENU_SECTIONS.length + 1); // + the Quit row
	});

	it("summaries reflect live store state", () => {
		const s = storeWith([ch({ id: "a" }), ch({ id: "b" })]);
		s.setStatus({ up: true, localUrl: null, publicUrl: null, token: null });
		s.setOauthClients([{ clientId: "oh_1", label: "x", createdAt: "now", grantTypes: ["client_credentials"] }]);
		s.setLoginConfigured(true);
		const byLabel = Object.fromEntries(menuItems(s).map((i) => [i.label, i.description]));
		expect(byLabel.Status).toBe("server up");
		expect(byLabel.Channels).toBe("2 configured");
		expect(byLabel["Clients & login"]).toBe("1 client");
		expect(byLabel.Monitor).toBe("quiet");
	});

	it("clients summary surfaces an unset login at the menu level", () => {
		const s = new DashboardStore();
		s.setOauthClients([{ clientId: "oh_1", label: "x", createdAt: "now", grantTypes: ["client_credentials"] }]);
		// loginConfigured defaults false → the urgent "login NOT set" overrides the count.
		const byLabel = Object.fromEntries(menuItems(s).map((i) => [i.label, i.description]));
		expect(byLabel["Clients & login"]).toBe("login NOT set");
	});
});

describe("screens — channelItems / channelDetailSpec", () => {
	it("a down channel's list row carries the server-reported reason (28j — never a silent down)", () => {
		const store = storeWith([ch({ id: "a", kind: "ngrok", label: "tun" })]);
		store.setChannelState("a", false, null, "ngrok authentication failed");
		const row = channelItems(store).find((i) => i.label === "tun");
		expect(row?.description).toContain("down — ngrok authentication failed");
	});

	it("channelItems lists channels then the add row", () => {
		const s = storeWith([ch({ id: "a", kind: "ngrok", label: "tun" })], { status: undefined });
		s.setChannelState("a", true, "https://up");
		const items = channelItems(s);
		expect(items.at(-1)?.label).toMatch(/Add a channel/);
		expect(items[0]?.label).toBe("tun");
		expect(items[0]?.description).toContain("ngrok");
		expect(items[0]?.description).toContain("up");
	});

	it("channelDetailSpec: Use only when not default; Remove + Back always", () => {
		const style = createStyle(false);
		const s = storeWith([ch({ id: "a" })]);
		const nonDefault = channelDetailSpec(s, "a", style);
		expect(nonDefault.items.map((i) => i.label)).toEqual(["Use as default", "Remove", "Back"]);

		s.setSettings({
			version: 1,
			channels: [ch({ id: "a" })],
			defaultChannel: "a",
			mcp: { allowedClients: [] },
			vm: defaultVmSettings(),
		});
		const isDefault = channelDetailSpec(s, "a", style);
		expect(isDefault.items.map((i) => i.label)).toEqual(["Remove", "Back"]);
		// header carries the channel detail (the kind row is present)
		expect(isDefault.header.some((l) => l.includes("ngrok"))).toBe(true);
	});
});

describe("screens — clientItems / clientDetailSpec", () => {
	it("clientItems lists Set-login, then clients, then the issue row", () => {
		const s = new DashboardStore();
		s.setOauthClients([{ clientId: "oh_1", label: "ci", createdAt: "t", grantTypes: ["client_credentials"] }]);
		const items = clientItems(s);
		expect(items[0]?.label).toBe(SET_LOGIN_LABEL);
		expect(items[1]?.label).toBe("ci");
		expect(items.at(-1)?.label).toMatch(/Issue new client/);
	});

	it("clientDetailSpec: Remove + Back; secret noted as once-only", () => {
		const style = createStyle(false);
		const s = new DashboardStore();
		s.setOauthClients([{ clientId: "oh_1", label: "ci", createdAt: "t", grantTypes: ["client_credentials"] }]);
		const spec = clientDetailSpec(s, "oh_1", style);
		expect(spec.items.map((i) => i.label)).toEqual(["Remove", "Back"]);
		expect(spec.header.some((l) => l.includes("oh_1"))).toBe(true);
		expect(spec.header.some((l) => l.toLowerCase().includes("hash"))).toBe(true);
	});
});

describe("screens — settings/doctor items", () => {
	it("settingsItems: Edit + Back", () => {
		expect(settingsItems().map((i) => i.label)).toEqual(["Edit settings…", "Back"]);
	});
	it("doctorItems: Run + Back", () => {
		expect(doctorItems().map((i) => i.label)).toEqual(["Run doctor", "Back"]);
	});
});

describe("screens — sandboxItems (spec 28, box 28b + 28c + 28e + 28f + 28g)", () => {
	it("with a golden: Start, Stop, Restart, Configure, Guest setup, Secrets, Edit provision.sh, Serial tail, Back — no Install row", () => {
		const labels = sandboxItems(true).map((i) => i.label);
		expect(labels).toEqual([
			SANDBOX_START_LABEL,
			SANDBOX_STOP_LABEL,
			SANDBOX_RESTART_LABEL,
			SANDBOX_CONFIGURE_LABEL,
			SANDBOX_GUEST_SETUP_LABEL,
			SANDBOX_SECRETS_LABEL,
			SANDBOX_PROVISION_LABEL,
			SANDBOX_SERIAL_LABEL,
			"Back",
		]);
		expect(labels).not.toContain(SANDBOX_INSTALL_LABEL);
	});

	it("the Start row is the TOP row when no session is live, and hides while one is (28j)", () => {
		expect(sandboxItems(true)[0]?.label).toBe(SANDBOX_START_LABEL);
		expect(sandboxItems(true, true).map((i) => i.label)).not.toContain(SANDBOX_START_LABEL);
	});

	it("Turn sandboxing off sits right under Start, exactly while the mode is vm/agent (never when off)", () => {
		// off mode (the default) — nothing to exit, the row is hidden
		expect(sandboxItems(true).map((i) => i.label)).not.toContain(SANDBOX_OFF_LABEL);
		// vm/agent — the one-action exit sits directly under Start
		const vm = sandboxItems(true, false, false, "vm").map((i) => i.label);
		expect(vm[0]).toBe(SANDBOX_START_LABEL);
		expect(vm[1]).toBe(SANDBOX_OFF_LABEL);
		// …and survives a live session (Stop/Restart era) — the exit never disappears
		const agentLive = sandboxItems(true, true, false, "agent").map((i) => i.label);
		expect(agentLive[0]).toBe(SANDBOX_OFF_LABEL);
	});

	it("the Guest setup row sits beside Configure and frames itself as a local build input (box 28e)", () => {
		const items = sandboxItems(true);
		const configure = items.findIndex((i) => i.label === SANDBOX_CONFIGURE_LABEL);
		const guest = items.findIndex((i) => i.label === SANDBOX_GUEST_SETUP_LABEL);
		expect(guest).toBe(configure + 1); // beside Configure, before Serial tail
		expect(items[guest]?.description).toContain("guest.json");
		expect(items[guest]?.description).toContain("`vm install`");
	});

	it("the Secrets row sits beside Guest setup and frames the 0700 store (box 28f)", () => {
		const items = sandboxItems(true);
		const guest = items.findIndex((i) => i.label === SANDBOX_GUEST_SETUP_LABEL);
		const secrets = items.findIndex((i) => i.label === SANDBOX_SECRETS_LABEL);
		expect(secrets).toBe(guest + 1); // beside Guest setup, before Serial tail
		expect(items[secrets]?.description).toContain("0700");
		expect(items[secrets]?.description).toContain("sandbox boot");
	});

	it("the Edit provision.sh row sits beside Secrets and names the escape hatch (box 28g)", () => {
		const items = sandboxItems(true);
		const secrets = items.findIndex((i) => i.label === SANDBOX_SECRETS_LABEL);
		const provision = items.findIndex((i) => i.label === SANDBOX_PROVISION_LABEL);
		expect(provision).toBe(secrets + 1); // beside Secrets, before Serial tail
		expect(items[provision]?.description).toContain("provision.sh");
		expect(items[provision]?.description).toContain("$EDITOR");
	});

	it("the apply-to-running rows are HIDDEN unless the session is ready enough; shown they sit after Serial tail (box 28g)", () => {
		const hidden = sandboxItems(true, true, false).map((i) => i.label);
		expect(hidden).not.toContain(SANDBOX_APPLY_AGENT_LABEL);
		expect(hidden).not.toContain(SANDBOX_APPLY_THEME_LABEL);

		const items = sandboxItems(true, true, true);
		expect(items.map((i) => i.label)).toEqual([
			SANDBOX_STOP_LABEL,
			SANDBOX_RESTART_LABEL,
			SANDBOX_CONFIGURE_LABEL,
			SANDBOX_GUEST_SETUP_LABEL,
			SANDBOX_SECRETS_LABEL,
			SANDBOX_PROVISION_LABEL,
			SANDBOX_SERIAL_LABEL,
			SANDBOX_APPLY_AGENT_LABEL,
			SANDBOX_APPLY_THEME_LABEL,
			"Back",
		]);
		const serial = items.findIndex((i) => i.label === SANDBOX_SERIAL_LABEL);
		expect(items[serial + 1]?.description).toContain("ssh"); // the direct ssh exec posture
		expect(items[serial + 2]?.description).toContain("omarchy theme set");
	});

	it("without a golden the Install row APPEARS (hidden when one exists — never a disabled row)", () => {
		const labels = sandboxItems(false).map((i) => i.label);
		expect(labels).toContain(SANDBOX_INSTALL_LABEL);
		expect(labels.indexOf(SANDBOX_INSTALL_LABEL)).toBe(labels.length - 2); // just before Back
	});

	it("the stop subtitle carries the matrix-row-4 semantics (teardown now; tools stay gated; lasting off = the named row)", () => {
		const stop = sandboxItems(true).find((i) => i.label === SANDBOX_STOP_LABEL);
		expect(stop?.description).toContain("tools stay sandbox-gated");
		expect(stop?.description).toContain("the lasting off is Turn sandboxing off");
	});

	it("while a session is ACTIVE the Install row is hidden even with no golden (matrix row 5, box 28d)", () => {
		const labels = sandboxItems(false, true).map((i) => i.label);
		expect(labels).not.toContain(SANDBOX_INSTALL_LABEL);
		expect(labels).toEqual([
			SANDBOX_STOP_LABEL,
			SANDBOX_RESTART_LABEL,
			SANDBOX_CONFIGURE_LABEL,
			SANDBOX_GUEST_SETUP_LABEL,
			SANDBOX_SECRETS_LABEL,
			SANDBOX_PROVISION_LABEL,
			SANDBOX_SERIAL_LABEL,
			"Back",
		]);
	});

	it("the Install row returns once the session is no longer active (stopped/failed/off — vmSessionActive)", () => {
		expect(sandboxItems(false, false).map((i) => i.label)).toContain(SANDBOX_INSTALL_LABEL);
	});
});

describe("screens — renderList + renderFieldRows", () => {
	it("renderList marks the focused row with → and aligns labels", () => {
		const style = createStyle(false); // identity — visible chars only
		const items = [
			{ label: "Status", description: "up" },
			{ label: "Channels", description: "2" },
		];
		const lines = renderList(items, 0, style, 80);
		expect(lines[0]).toContain("→");
		expect(lines[0]).toContain("Status");
		expect(lines[0]).toContain("up");
		expect(lines[1]).toContain("Channels");
		expect(lines[1]).not.toContain("→");
		// both labels start at the same column (alignment): "Status" and "Channels" padded
		expect(lines[0]?.indexOf("Status")).toBe(lines[1]?.indexOf("Channels"));
	});

	it("renderList truncates to the visible width (truncateToWidth appends a reset)", () => {
		const style = createStyle(false);
		const lines = renderList([{ label: "a-very-long-label-that-exceeds-the-width", description: "x" }], 0, style, 10);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
	});

	it("renderList colorizes the selected row when style is enabled (ANSI present)", () => {
		const style = createStyle(true);
		const lines = renderList([{ label: "X" }, { label: "Y" }], 0, style, 80);
		expect(lines[0]).toContain("\x1b["); // selected = accent+bold (SGR)
		expect(lines[1]).not.toContain("→");
	});

	it("renderFieldRows renders label + value lines", () => {
		const style = createStyle(false);
		const lines = renderFieldRows([{ label: "server", value: "up" }], style);
		expect(lines[0]).toContain("server");
		expect(lines[0]).toContain("up");
	});
});

/** A vm-state line fixture (mirrors monitor-view.test.ts's — the spec 27h wire shape). */
function vmLine(over: Partial<VmStateLine> = {}): VmStateLine {
	return {
		type: "vm-state",
		state: "ready",
		sessionId: "vm-20260911T101112Z-ab",
		phase: null,
		sshPort: 42255,
		error: null,
		...over,
	};
}

/** A store whose settings doc has only the vm mode overridden. */
function storeInMode(mode: VmSettings["mode"]): DashboardStore {
	return new DashboardStore(
		{},
		{
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: [] },
			vm: { ...defaultVmSettings(), mode },
		},
	);
}

describe("screens — Sandbox entry visibility (28j: always visible)", () => {
	it("off mode + no vm-state line: the row is PRESENT (the sandbox is discoverable before it exists)", () => {
		const items = menuItems(new DashboardStore());
		expect(items.some((i) => i.label === "Sandbox")).toBe(true);
		const sandbox = items.find((i) => i.label === "Sandbox");
		expect(sandbox?.description).toBe("off"); // the honest pre-setup posture, not a stale lifecycle word
	});

	it("off mode + a vm-state line arrives (mode flipped at boot): the row shows, just before Quit", () => {
		const s = new DashboardStore();
		s.applyVmStateLine(
			JSON.stringify(vmLine({ state: "booting", phase: "prepare", sessionId: null, sshPort: null })),
		);
		const labels = menuItems(s).map((i) => i.label);
		expect(labels).toContain("Sandbox");
		expect(labels.at(-2)).toBe("Sandbox"); // just before Quit
	});

	it("vm mode from the settings (no line yet): present with a stopped summary", () => {
		const sandbox = menuItems(storeInMode("vm")).find((i) => i.label === "Sandbox");
		expect(sandbox?.description).toBe("stopped");
	});

	it("the summary is the live state tail (the monitor-view voice minus the head)", () => {
		const s = storeInMode("vm");
		s.applyVmStateLine(JSON.stringify(vmLine()));
		const sandbox = menuItems(s).find((i) => i.label === "Sandbox");
		expect(sandbox?.description).toBe("ready · session vm-20260911T101112Z-ab · ssh :42255");
	});
});

describe("screens — menuSectionAt (the visibility-aware dispatch)", () => {
	it("every section shows: Settings at 4, Doctor at 5, Sandbox at 6, Quit at 7 — nothing misroutes", () => {
		const s = new DashboardStore();
		expect(menuSectionAt(s, 4)).toBe("settings");
		expect(menuSectionAt(s, 5)).toBe("doctor");
		expect(menuSectionAt(s, 6)).toBe("sandbox");
		expect(menuSectionAt(s, 7)).toBe("quit");
		expect(visibleMenuSections(s).length).toBe(MENU_SECTIONS.length);
	});
});
