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
	SANDBOX_CONFIGURE_LABEL,
	SANDBOX_GUEST_SETUP_LABEL,
	SANDBOX_INSTALL_LABEL,
	SANDBOX_RESTART_LABEL,
	SANDBOX_SECRETS_LABEL,
	SANDBOX_SERIAL_LABEL,
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
		// The default store's vm mode is `off` with no vm-state line — the Sandbox
		// row is hidden (spec 28 off-mode invisibility), so a fresh menu is the six
		// base sections + Quit.
		expect(items.map((i) => i.label)).toEqual([
			...MENU_SECTIONS.filter((section) => section !== "sandbox").map(() => expect.any(String)),
			"Quit",
		]);
		expect(items.length).toBe(MENU_SECTIONS.length);
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

describe("screens — sandboxItems (spec 28, box 28b + 28c + 28e + 28f)", () => {
	it("with a golden: Stop, Restart, Configure, Guest setup, Secrets, Serial tail, Back — no Install row", () => {
		const labels = sandboxItems(true).map((i) => i.label);
		expect(labels).toEqual([
			SANDBOX_STOP_LABEL,
			SANDBOX_RESTART_LABEL,
			SANDBOX_CONFIGURE_LABEL,
			SANDBOX_GUEST_SETUP_LABEL,
			SANDBOX_SECRETS_LABEL,
			SANDBOX_SERIAL_LABEL,
			"Back",
		]);
		expect(labels).not.toContain(SANDBOX_INSTALL_LABEL);
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

	it("without a golden the Install row APPEARS (hidden when one exists — never a disabled row)", () => {
		const labels = sandboxItems(false).map((i) => i.label);
		expect(labels).toContain(SANDBOX_INSTALL_LABEL);
		expect(labels.indexOf(SANDBOX_INSTALL_LABEL)).toBe(labels.length - 2); // just before Back
	});

	it("the stop subtitle carries the matrix-row-4 semantics (re-boots on next start; lasting stop = off + restart)", () => {
		const stop = sandboxItems(true)[0];
		expect(stop?.description).toContain("re-boots the sandbox on the next server start");
		expect(stop?.description).toContain("lasting stop: mode off + restart");
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

describe("screens — Sandbox entry visibility (spec 28)", () => {
	it("off mode + no vm-state line: the Sandbox row is absent entirely", () => {
		const items = menuItems(new DashboardStore());
		expect(items.some((i) => i.label === "Sandbox")).toBe(false);
	});

	it("off mode + a vm-state line arrives (mode flipped at boot): the row appears", () => {
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
	it("hidden Sandbox: focus past Doctor is the Quit row (nothing misroutes)", () => {
		const s = new DashboardStore();
		expect(menuSectionAt(s, 4)).toBe("settings");
		expect(menuSectionAt(s, 5)).toBe("doctor");
		expect(menuSectionAt(s, 6)).toBe("quit");
	});

	it("visible Sandbox: the row sits after Doctor; Quit shifts to 7", () => {
		const s = storeInMode("vm");
		expect(menuSectionAt(s, 5)).toBe("doctor");
		expect(menuSectionAt(s, 6)).toBe("sandbox");
		expect(menuSectionAt(s, 7)).toBe("quit");
		expect(visibleMenuSections(s).length).toBe(MENU_SECTIONS.length);
	});
});
