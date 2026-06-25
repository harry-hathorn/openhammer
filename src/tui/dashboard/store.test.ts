import { describe, expect, it } from "vitest";
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import { DashboardStore, emptyStatus, type ServerStatusState } from "./store.ts";

/** A minimal valid RequestEvent for the monitor ring (the reducer reads client + ts). */
function event(client: string): RequestEvent {
	return {
		ts: "2026-01-01T00:00:00Z",
		client,
		method: "tools/call",
		tool: "read",
		reqBytes: 0,
		resBytes: 0,
		ms: 1,
		status: 200,
	};
}

function settingsWith(channels: ChannelEntry[]): Settings {
	return { version: 1, channels, defaultChannel: channels[0]?.id ?? null, mcp: { allowedClients: [] } };
}

describe("DashboardStore — construction & views", () => {
	it("seeds from empty defaults (no channels, unknown status)", () => {
		const s = new DashboardStore();
		expect(s.channels).toEqual([]);
		expect(s.defaultChannelId).toBeNull();
		expect(s.activeClients).toEqual([]);
		expect(s.monitorEvents).toEqual([]);
		expect(s.oauthClients).toEqual([]);
		expect(s.status).toEqual(emptyStatus());
	});

	it("seeds channels/default from the initial settings", () => {
		const ch: ChannelEntry = { id: "c1", kind: "ngrok", mode: "live", options: {} };
		const s = new DashboardStore({}, settingsWith([ch]));
		expect(s.channels).toEqual([ch]);
		expect(s.defaultChannelId).toBe("c1");
	});
});

describe("DashboardStore — mutators", () => {
	it("setStatus / setOauthClients / setSettings replace their slices", () => {
		const s = new DashboardStore();
		const up: ServerStatusState = { up: true, localUrl: "http://x/mcp", publicUrl: null, token: "t" };
		s.setStatus(up);
		expect(s.status).toBe(up);

		const clients: ClientInfo[] = [{ clientId: "oh_1", label: "a", createdAt: "now" }];
		s.setOauthClients(clients);
		expect(s.oauthClients).toBe(clients);

		const ch: ChannelEntry = { id: "c1", kind: "ngrok", mode: "live", options: {} };
		s.setSettings(settingsWith([ch]));
		expect(s.channels).toEqual([ch]);
		expect(s.defaultChannelId).toBe("c1");
	});

	it("setChannelState / applyChannelState record up+url per id (absent = unknown)", () => {
		const s = new DashboardStore();
		const id = "c1";
		expect(s.channelState[id]).toBeUndefined();
		s.setChannelState(id, true, "https://x");
		expect(s.channelState[id]).toEqual({ up: true, url: "https://x" });
		s.applyChannelState(id, false, null);
		expect(s.channelState[id]).toEqual({ up: false, url: null });
	});
});

describe("DashboardStore — monitor ring + clients reducer", () => {
	it("applyEvent folds into the clients reducer (activeClients reflects call counts)", () => {
		const s = new DashboardStore();
		s.applyEvent(event("claude-code"));
		s.applyEvent(event("claude-code"));
		s.applyEvent(event("other"));
		const clients = s.activeClients;
		expect(clients.length).toBe(2);
		const cc = clients.find((c) => c.client === "claude-code");
		expect(cc).toBeDefined();
		expect(cc?.calls).toBe(2);
	});

	it("applyEvent appends to the ring and caps it at monitorLimit", () => {
		const s = new DashboardStore({ monitorLimit: 3 });
		s.applyEvent(event("a"));
		s.applyEvent(event("b"));
		s.applyEvent(event("c"));
		s.applyEvent(event("d"));
		expect(s.monitorEvents.length).toBe(3);
		// Newest last; the oldest ("a") was shifted out.
		expect(s.monitorEvents.map((e) => e.client)).toEqual(["b", "c", "d"]);
	});

	it("defaults to DASHBOARD_MONITOR_LIMIT (8) when no monitorLimit given", () => {
		const s = new DashboardStore();
		for (let i = 0; i < 12; i++) s.applyEvent(event(`c${i}`));
		expect(s.monitorEvents.length).toBe(8);
	});
});
