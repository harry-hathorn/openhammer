import { describe, expect, it } from "vitest";
import type { ChannelEntry } from "../../config/settings.ts";
import type { ClientStat, RequestEvent } from "../../mcp/telemetry.ts";
import {
	composeDashboard,
	type DashboardState,
	DEFAULT_19B_KEYS,
	emptyStatus,
	renderChannelsPanel,
	renderClientsPanel,
	renderFooter,
	renderMonitorPanel,
	renderStatusPanel,
} from "./panels.ts";

/** A minimal valid channel entry for tests (the loader's full shape). */
function channel(over: Partial<ChannelEntry> = {}): ChannelEntry {
	return { id: "id-1", kind: "cloudflare", mode: "live", options: {}, ...over };
}

/** A baseline event (the recorder's always-present 8 fields). */
function event(over: Partial<RequestEvent> = {}): RequestEvent {
	return {
		ts: "2026-06-24T12:01:03.000Z",
		client: "claude-code",
		method: "tools/call",
		tool: "bash",
		reqBytes: 10,
		resBytes: 200,
		ms: 1200,
		status: 200,
		...over,
	};
}

/** A baseline dashboard state (empty defaults) with the given overrides applied. */
function state(over: Partial<DashboardState> = {}): DashboardState {
	return {
		status: emptyStatus(),
		channels: [],
		defaultChannelId: null,
		channelState: {},
		clients: [],
		monitor: [],
		monitorLimit: 8,
		...over,
	};
}

describe("renderStatusPanel", () => {
	it("shows 'down' for an un-reached server and omits unknown URLs/token", () => {
		const lines = renderStatusPanel(emptyStatus());
		expect(lines[0]).toBe("STATUS");
		expect(lines).toContain("  server: down");
		// No local/tunnel/token lines when all are null.
		expect(lines.some((l) => l.startsWith("  local:"))).toBe(false);
		expect(lines.some((l) => l.startsWith("  tunnel:"))).toBe(false);
		expect(lines.some((l) => l.startsWith("  token:"))).toBe(false);
	});

	it("shows 'up' + local/tunnel/token lines as they become known", () => {
		const lines = renderStatusPanel({
			up: true,
			localUrl: "http://127.0.0.1:3000/mcp",
			publicUrl: "https://abc.trycloudflare.com/mcp",
			token: "tok-123",
		});
		expect(lines).toContain("  server: up");
		expect(lines).toContain("  local:  http://127.0.0.1:3000/mcp");
		expect(lines).toContain("  tunnel: https://abc.trycloudflare.com/mcp");
		expect(lines).toContain("  token:  tok-123");
	});

	it("omits the tunnel line when only the local URL is known", () => {
		const lines = renderStatusPanel({ up: true, localUrl: "http://h:3000/mcp", publicUrl: null, token: null });
		expect(lines.some((l) => l.startsWith("  tunnel:"))).toBe(false);
		expect(lines.some((l) => l.startsWith("  token:"))).toBe(false);
	});
});

describe("renderChannelsPanel", () => {
	it("shows a placeholder when no channels are configured", () => {
		const lines = renderChannelsPanel(state());
		expect(lines[0]).toBe("CHANNELS");
		expect(lines).toContain("  (none configured)");
	});

	it("renders one row per channel with label/kind/mode and a default marker", () => {
		const lines = renderChannelsPanel(
			state({
				channels: [channel({ id: "a", label: "edge", kind: "ngrok", mode: "live" })],
				defaultChannelId: "a",
			}),
		);
		const row = lines.find((l) => l.startsWith(" * "));
		expect(row).toBeDefined();
		expect(row).toContain("edge");
		expect(row).toContain("ngrok");
		expect(row).toContain("live");
		expect(row).toContain("unknown"); // no live state reported yet
	});

	it("marks the non-default channel with a space, not '*'", () => {
		const lines = renderChannelsPanel(
			state({ channels: [channel({ id: "a", label: "x" })], defaultChannelId: "other" }),
		);
		expect(lines.some((l) => l.startsWith("  "))).toBe(true);
		expect(lines.some((l) => l.startsWith(" * "))).toBe(false);
	});

	it("prefers live URL, then a static channel's declared publicUrl", () => {
		const live = renderChannelsPanel(
			state({
				channels: [channel({ id: "a", kind: "cloudflare" })],
				channelState: { a: { up: true, url: "https://live.example/mcp" } },
			}),
		);
		expect(live.some((l) => l.includes("https://live.example/mcp"))).toBe(true);
		expect(live.some((l) => l.includes("up"))).toBe(true);

		const declared = renderChannelsPanel(
			state({
				channels: [
					channel({ id: "a", kind: "nginx", mode: "static", options: { publicUrl: "https://static.example" } }),
				],
			}),
		);
		expect(declared.some((l) => l.includes("https://static.example"))).toBe(true);
	});

	it("reports 'down' when a channel's live state is up:false", () => {
		const lines = renderChannelsPanel(
			state({ channels: [channel({ id: "a" })], channelState: { a: { up: false, url: null } } }),
		);
		expect(lines.some((l) => l.includes("down"))).toBe(true);
	});
});

describe("renderClientsPanel", () => {
	it("shows a placeholder when no clients are connected", () => {
		expect(renderClientsPanel([])).toContain("  (none connected)");
	});

	it("renders per-client call counts (singular vs plural) + last-seen time", () => {
		const stats: ClientStat[] = [
			{ client: "claude-code", calls: 1, lastSeen: "2026-06-24T12:01:03.000Z" },
			{ client: "cursor", calls: 3, lastSeen: "2026-06-24T12:02:04.000Z" },
		];
		const lines = renderClientsPanel(stats);
		expect(lines.some((l) => l.includes("claude-code") && l.includes("1 call"))).toBe(true);
		expect(lines.some((l) => l.includes("cursor") && l.includes("3 calls"))).toBe(true);
		// isoTimeOf → HH:MM:SS from the ISO timestamp.
		expect(lines.some((l) => l.includes("last 12:01:03"))).toBe(true);
	});
});

describe("renderMonitorPanel", () => {
	it("shows a placeholder when there are no events", () => {
		expect(renderMonitorPanel([], 8)).toContain("  (quiet — no calls yet)");
	});

	it("renders each event with the shared formatEvent formatter (reuse)", () => {
		const lines = renderMonitorPanel([event({ tool: "bash", ms: 1200, resBytes: 200 })], 8);
		expect(lines.some((l) => l.includes("claude-code") && l.includes("bash") && l.includes("1.2s"))).toBe(true);
	});

	it("keeps only the last `limit` events (the tail)", () => {
		const events = Array.from({ length: 10 }, (_, i) => event({ client: `c${i}`, ms: i }));
		const lines = renderMonitorPanel(events, 3);
		// c7/c8/c9 survive; c0..c6 are dropped.
		for (let i = 7; i <= 9; i++) expect(lines.some((l) => l.includes(`c${i}`))).toBe(true);
		for (let i = 0; i <= 6; i++) expect(lines.some((l) => l.includes(`c${i}`))).toBe(false);
	});
});

describe("renderFooter", () => {
	it("joins the key hints three-spaces-wide under a blank rule line", () => {
		const lines = renderFooter([
			{ key: "r", label: "refresh" },
			{ key: "q", label: "quit" },
		]);
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("  r refresh   q quit");
	});
});

describe("composeDashboard", () => {
	it("lays out all four section headers + the footer key menu", () => {
		const frame = composeDashboard(state({ channels: [channel()] }), 120);
		const out = frame.join("\n");
		expect(out).toContain("STATUS");
		expect(out).toContain("CHANNELS");
		expect(out).toContain("CLIENTS");
		expect(out).toContain("MONITOR");
		expect(out).toContain("r refresh");
		expect(out).toContain("q quit");
	});

	it("separates sections with a blank line", () => {
		const frame = composeDashboard(state(), 120);
		expect(frame.filter((l) => l === "").length).toBeGreaterThanOrEqual(4); // 3 between sections + footer rule
	});

	it("clips long lines to the width with a '›' marker", () => {
		const longToken = "x".repeat(60);
		const frame = composeDashboard(
			state({ status: { up: true, localUrl: null, publicUrl: null, token: longToken } }),
			30,
		);
		const tokenLine = frame.find((l) => l.startsWith("  token:"));
		expect(tokenLine).toBeDefined();
		expect(tokenLine?.endsWith("›")).toBe(true);
		expect(tokenLine?.length).toBe(30);
	});

	it("leaves lines untouched when width is 0 (no clipping requested)", () => {
		const frame = composeDashboard(
			state({ status: { up: true, localUrl: "x".repeat(100), publicUrl: null, token: null } }),
			0,
		);
		expect(frame.some((l) => l.length > 100)).toBe(true);
	});

	it("defaults the footer to the 19b wired keys", () => {
		const frame = composeDashboard(state(), 120);
		expect(frame.join("\n")).toContain(`  ${DEFAULT_19B_KEYS.map((k) => `${k.key} ${k.label}`).join("   ")}`);
	});
});
