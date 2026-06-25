import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { ChannelEntry } from "../../config/settings.ts";
import { createStyle } from "../style.ts";
import {
	channelDetailSpec,
	channelItems,
	clientDetailSpec,
	clientItems,
	doctorItems,
	MENU_SECTIONS,
	menuItems,
	renderFieldRows,
	renderList,
	settingsItems,
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
	const s = new DashboardStore({}, { version: 1, channels, defaultChannel: null, mcp: { allowedClients: [] } });
	if (defaults.status) s.setStatus(defaults.status as never);
	return s;
}

describe("screens — menuItems", () => {
	it("yields one row per section (in MENU_SECTIONS order) then Quit", () => {
		const items = menuItems(new DashboardStore());
		expect(items.map((i) => i.label)).toEqual([...MENU_SECTIONS.map(() => expect.any(String)), "Quit"]);
		expect(items.length).toBe(MENU_SECTIONS.length + 1);
	});

	it("summaries reflect live store state", () => {
		const s = storeWith([ch({ id: "a" }), ch({ id: "b" })]);
		s.setStatus({ up: true, localUrl: null, publicUrl: null, token: null });
		s.setOauthClients([{ clientId: "oh_1", label: "x", createdAt: "now" }]);
		const byLabel = Object.fromEntries(menuItems(s).map((i) => [i.label, i.description]));
		expect(byLabel.Status).toBe("server up");
		expect(byLabel.Channels).toBe("2 configured");
		expect(byLabel["Clients & JWT"]).toBe("1 client");
		expect(byLabel.Monitor).toBe("quiet");
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

		s.setSettings({ version: 1, channels: [ch({ id: "a" })], defaultChannel: "a", mcp: { allowedClients: [] } });
		const isDefault = channelDetailSpec(s, "a", style);
		expect(isDefault.items.map((i) => i.label)).toEqual(["Remove", "Back"]);
		// header carries the channel detail (the kind row is present)
		expect(isDefault.header.some((l) => l.includes("ngrok"))).toBe(true);
	});
});

describe("screens — clientItems / clientDetailSpec", () => {
	it("clientItems lists clients then the issue row", () => {
		const s = new DashboardStore();
		s.setOauthClients([{ clientId: "oh_1", label: "ci", createdAt: "t" }]);
		const items = clientItems(s);
		expect(items[0]?.label).toBe("ci");
		expect(items.at(-1)?.label).toMatch(/Issue new client/);
	});

	it("clientDetailSpec: Remove + Back; secret noted as once-only", () => {
		const style = createStyle(false);
		const s = new DashboardStore();
		s.setOauthClients([{ clientId: "oh_1", label: "ci", createdAt: "t" }]);
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
