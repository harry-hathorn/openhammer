import { describe, expect, it } from "vitest";
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import {
	channelDetailRows,
	channelRows,
	clientRows,
	monitorRows,
	secretRevealRows,
	settingsRows,
	statusRows,
} from "./view.ts";

const ch = (over: Partial<ChannelEntry> = {}): ChannelEntry => ({
	id: "c1",
	kind: "ngrok",
	mode: "live",
	options: {},
	...over,
});

describe("view — channelRows", () => {
	it("maps channels to rows, preferring live url then declared publicUrl", () => {
		const channels = [
			ch({ id: "a", kind: "ngrok", label: "tunnel" }),
			ch({ id: "b", kind: "static-url", mode: "static", options: { publicUrl: "https://pub" } }),
		];
		const rows = channelRows(channels, "a", {
			a: { up: true, url: "https://live" },
		});
		expect(rows).toEqual([
			{ id: "a", label: "tunnel", kind: "ngrok", mode: "live", live: "up", url: "https://live", isDefault: true },
			{
				id: "b",
				label: "static-url",
				kind: "static-url",
				mode: "static",
				live: "unknown",
				url: "https://pub",
				isDefault: false,
			},
		]);
	});

	it("treats absent channelState as unknown and up:false as down", () => {
		const rows = channelRows([ch({ id: "a" }), ch({ id: "b" })], null, { b: { up: false, url: null } });
		expect(rows[0]?.live).toBe("unknown");
		expect(rows[1]?.live).toBe("down");
		expect(rows[1]?.url).toBe("");
	});

	it("falls back label -> kind when no label", () => {
		const rows = channelRows([ch({ id: "a", kind: "cloudflare", label: undefined })], null, {});
		expect(rows[0]?.label).toBe("cloudflare");
	});
});

describe("view — channelDetailRows", () => {
	it("includes id/label/kind/mode/default/status/url + non-empty options", () => {
		const c = ch({
			id: "c1",
			kind: "static-url",
			mode: "static",
			label: "prod",
			options: { publicUrl: "https://p", note: "x", empty: "" },
		});
		const rows = channelDetailRows(c, "c1", { up: true, url: "https://live" });
		const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
		expect(map.id).toBe("c1");
		expect(map.label).toBe("prod");
		expect(map.default).toBe("yes");
		expect(map.status).toBe("up");
		expect(map.url).toBe("https://live"); // live wins over declared
		expect(map.publicUrl).toBe("https://p");
		expect(map.note).toBe("x");
		expect(map.empty).toBeUndefined(); // empty options skipped
	});

	it("label falls back to (none); url to (none) when unknown with no publicUrl", () => {
		const rows = channelDetailRows(ch({ id: "c1", label: undefined }), null, undefined);
		const map = Object.fromEntries(rows.map((r) => [r.label, r.value]));
		expect(map.label).toBe("(none)");
		expect(map.status).toBe("unknown");
		expect(map.url).toBe("(none)");
	});
});

describe("view — statusRows", () => {
	it("always shows server, then only known url/token rows", () => {
		expect(statusRows({ up: false, localUrl: null, publicUrl: null, token: null })).toEqual([
			{ label: "server", value: "down" },
		]);
		const rows = statusRows({
			up: true,
			localUrl: "http://127.0.0.1:3000/mcp",
			publicUrl: "https://tun",
			token: "tok",
		});
		expect(rows.map((r) => r.label)).toEqual(["server", "local", "tunnel", "token"]);
		expect(rows[0]?.value).toBe("up");
	});
});

describe("view — clientRows + secretRevealRows", () => {
	it("maps clients; a blank label becomes (no label)", () => {
		const clients: ClientInfo[] = [
			{ clientId: "oh_1", label: "ci", createdAt: "now", grantTypes: ["client_credentials"] },
			{ clientId: "oh_2", label: "  ", createdAt: "then", grantTypes: ["authorization_code"] },
		];
		expect(clientRows(clients)).toEqual([
			{ clientId: "oh_1", label: "ci", createdAt: "now", grantType: "machine" },
			{ clientId: "oh_2", label: "(no label)", createdAt: "then", grantType: "login" },
		]);
	});

	it("secretRevealRows shows id + plaintext once with the not-again warning", () => {
		const rows = secretRevealRows("oh_abc", "secret123");
		expect(rows.some((r) => r.includes("oh_abc"))).toBe(true);
		expect(rows.some((r) => r.includes("secret123"))).toBe(true);
		expect(rows.some((r) => r.includes("NOT be shown again"))).toBe(true);
	});
});

describe("view — monitorRows + settingsRows", () => {
	it("monitorRows formats each event", () => {
		const events: RequestEvent[] = [
			{
				ts: "2026-01-01T00:00:00Z",
				client: "cc",
				method: "tools/call",
				tool: "read",
				reqBytes: 0,
				resBytes: 200,
				ms: 12,
				status: 200,
			},
		];
		const rows = monitorRows(events);
		expect(rows.length).toBe(1);
		expect(rows[0]).toContain("read");
		expect(rows[0]).toContain("cc");
	});

	it("settingsRows: allowed clients (any) + default channel", () => {
		const s: Settings = { version: 1, channels: [], defaultChannel: "c1", mcp: { allowedClients: [] } };
		const map = Object.fromEntries(settingsRows(s).map((r) => [r.label, r.value]));
		expect(map["allowed clients"]).toBe("(any)");
		expect(map["default channel"]).toBe("c1");

		const s2: Settings = {
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: ["claude-code", "*"] },
		};
		const map2 = Object.fromEntries(settingsRows(s2).map((r) => [r.label, r.value]));
		expect(map2["allowed clients"]).toBe("(any)"); // "*" => any
		expect(map2["default channel"]).toBe("(none)");
	});
});
