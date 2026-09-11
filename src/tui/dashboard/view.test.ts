import { describe, expect, it } from "vitest";
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { defaultVmSettings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import type { VmStateLine } from "../../observability/status-socket.ts";
import {
	channelDetailRows,
	channelRows,
	clientRows,
	hasPublicChannel,
	monitorRows,
	SERIAL_TAIL_LINES,
	sandboxEntryVisible,
	sandboxHeaderRows,
	sandboxStateRow,
	secretRevealRows,
	serialTailNote,
	serialTailOf,
	settingsRows,
	statusRows,
	VM_APPLY_HINT,
	vmSessionActive,
	vmSettingsEqual,
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
		const s: Settings = {
			version: 1,
			channels: [],
			defaultChannel: "c1",
			mcp: { allowedClients: [] },
			vm: defaultVmSettings(),
		};
		const map = Object.fromEntries(settingsRows(s).map((r) => [r.label, r.value]));
		expect(map["allowed clients"]).toBe("(any)");
		expect(map["default channel"]).toBe("c1");

		const s2: Settings = {
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: ["claude-code", "*"] },
			vm: defaultVmSettings(),
		};
		const map2 = Object.fromEntries(settingsRows(s2).map((r) => [r.label, r.value]));
		expect(map2["allowed clients"]).toBe("(any)"); // "*" => any
		expect(map2["default channel"]).toBe("(none)");
	});
});

/** A vm-state line fixture (mirrors monitor-view.test.ts's — the spec 27h wire shape). */
function vmState(over: Partial<VmStateLine> = {}): VmStateLine {
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

describe("view — sandbox rows (spec 28)", () => {
	it("renders the state row per lifecycle state, in the monitor-view voice", () => {
		expect(sandboxStateRow(vmState())).toBe("Sandbox  ready · session vm-20260911T101112Z-ab · ssh :42255");
		expect(sandboxStateRow(vmState({ sshPort: null }))).toBe("Sandbox  ready · session vm-20260911T101112Z-ab");
		expect(sandboxStateRow(vmState({ sshPort: null, sessionId: null }))).toBe("Sandbox  ready · session (none)");
		expect(sandboxStateRow(vmState({ state: "booting", phase: "ssh", sessionId: null, sshPort: null }))).toBe(
			"Sandbox  booting (phase ssh)",
		);
		expect(sandboxStateRow(vmState({ state: "booting", phase: null, sessionId: null, sshPort: null }))).toBe(
			"Sandbox  booting",
		);
		expect(
			sandboxStateRow(
				vmState({
					state: "failed",
					sessionId: null,
					sshPort: null,
					error: "sandbox boot failed: no golden manifest\nrun: openhammer vm install",
				}),
			),
		).toBe("Sandbox  failed — sandbox boot failed: no golden manifest run: openhammer vm install");
		expect(sandboxStateRow(vmState({ state: "failed", sessionId: null, sshPort: null, error: null }))).toBe(
			"Sandbox  failed",
		);
		expect(sandboxStateRow(vmState({ state: "stopped", sessionId: null, sshPort: null }))).toBe("Sandbox  stopped");
	});

	it("a null line (vm mode configured, nothing reported yet) reads as stopped", () => {
		expect(sandboxStateRow(null)).toBe("Sandbox  stopped");
	});

	it("sandboxHeaderRows appends the guest-root row only when the root is known", () => {
		const row = sandboxStateRow(vmState());
		expect(sandboxHeaderRows(vmState(), "/home/sandbox")).toEqual([row, "guest root: /home/sandbox"]);
		expect(sandboxHeaderRows(vmState(), null)).toEqual([row]);
	});

	it("sandboxEntryVisible: off + no report hides; a report or a vm mode shows", () => {
		expect(sandboxEntryVisible("off", false)).toBe(false);
		expect(sandboxEntryVisible("off", true)).toBe(true); // the mode-flipped-at-boot escape hatch
		expect(sandboxEntryVisible("vm", false)).toBe(true); // from settings, before any line
		expect(sandboxEntryVisible("agent", false)).toBe(true);
	});
});

describe("view — vmSessionActive (the row-5 Install exclusion predicate, spec 28 box 28d)", () => {
	it("booting/ready hold a live QEMU → active; stopped/failed/off/no-line → not", () => {
		expect(vmSessionActive(vmState())).toBe(true); // ready
		expect(vmSessionActive(vmState({ state: "booting", phase: "prepare", sessionId: null, sshPort: null }))).toBe(
			true,
		);
		expect(vmSessionActive(vmState({ state: "stopped", sessionId: null, sshPort: null }))).toBe(false);
		expect(vmSessionActive(vmState({ state: "failed", sessionId: null, sshPort: null, error: "boom" }))).toBe(false);
		expect(vmSessionActive(vmState({ state: "off", sessionId: null, sshPort: null }))).toBe(false);
		expect(vmSessionActive(null)).toBe(false);
	});
});

describe("view — serial tail (spec 28, box 28b)", () => {
	it("keeps the LAST 200 lines of a longer log and flags the truncation", () => {
		const lines = Array.from({ length: 250 }, (_, i) => `line-${i + 1}`);
		const tail = serialTailOf(`${lines.join("\n")}\n`, 1234);
		expect(tail.truncated).toBe(true);
		expect(tail.lineCount).toBe(250);
		expect(tail.lines.length).toBe(SERIAL_TAIL_LINES);
		expect(tail.lines[0]).toBe("line-51");
		expect(tail.lines.at(-1)).toBe("line-250");
		expect(tail.totalBytes).toBe(1234);
	});

	it("keeps a whole log; drops the trailing-newline artifact and \\r", () => {
		expect(serialTailOf("a\nb\r\nc\n", 7)).toEqual({
			lines: ["a", "b", "c"],
			totalBytes: 7,
			truncated: false,
			lineCount: 3,
		});
	});

	it("an empty log is zero lines, not one", () => {
		expect(serialTailOf("", 0)).toEqual({ lines: [], totalBytes: 0, truncated: false, lineCount: 0 });
	});

	it("serialTailNote names the window, the byte total, and the not-live posture", () => {
		const lines = Array.from({ length: 250 }, (_, i) => `l${i}`);
		expect(serialTailNote(serialTailOf(lines.join("\n"), 2048))).toBe(
			"serial.log — last 200 of 250 lines · 2048B total · read-only snapshot (not live)",
		);
		expect(serialTailNote(serialTailOf("one\n", 4))).toBe(
			"serial.log — 1 line · 4B total · read-only snapshot (not live)",
		);
	});
});

/** Settings with just the channel list varied (the guard predicates' subject). */
function settingsWithChannels(channels: ChannelEntry[]): Settings {
	return { version: 1, channels, defaultChannel: null, mcp: { allowedClients: [] }, vm: defaultVmSettings() };
}

describe("view — hasPublicChannel (the row-1 predicate, spec 28 box 28c)", () => {
	it("a live channel is ALWAYS public (a spawned tunnel is never loopback by design)", () => {
		expect(hasPublicChannel(settingsWithChannels([ch({ id: "a", kind: "ngrok", mode: "live" })]))).toBe(true);
		expect(hasPublicChannel(settingsWithChannels([ch({ id: "a", kind: "cloudflare", mode: "live" })]))).toBe(true);
	});

	it("a static channel is public iff its declared publicUrl is NOT loopback", () => {
		const staticUrl = (publicUrl: string): ChannelEntry =>
			ch({ id: "s", kind: "static-url", mode: "static", options: { publicUrl } });
		expect(hasPublicChannel(settingsWithChannels([staticUrl("https://tunnel.example.com")]))).toBe(true);
		expect(hasPublicChannel(settingsWithChannels([staticUrl("http://127.0.0.1:3000")]))).toBe(false);
		expect(hasPublicChannel(settingsWithChannels([staticUrl("http://localhost:3000/mcp")]))).toBe(false);
		expect(hasPublicChannel(settingsWithChannels([staticUrl("http://[::1]:3000")]))).toBe(false);
	});

	it("a static channel with NO publicUrl resolves to no handle at boot — not public", () => {
		expect(hasPublicChannel(settingsWithChannels([ch({ id: "s", mode: "static", options: {} })]))).toBe(false);
	});

	it("an unparseable declared URL warns (fail-safe toward the warning when loopback cannot be ruled out)", () => {
		const unparseable = ch({ id: "s", mode: "static", options: { publicUrl: "not a url" } });
		expect(hasPublicChannel(settingsWithChannels([unparseable]))).toBe(true);
	});

	it("no channels at all → false", () => {
		expect(hasPublicChannel(settingsWithChannels([]))).toBe(false);
	});
});

describe("view — vmSettingsEqual + the apply-on-restart affordance (row 3, box 28c)", () => {
	it("vmSettingsEqual is field-wise — equal docs match, each field's change alone breaks the match", () => {
		const a = defaultVmSettings();
		expect(vmSettingsEqual(a, { ...a })).toBe(true);
		expect(vmSettingsEqual(a, { ...a, mode: "vm" })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, memoryMb: 2048 })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, cpus: 2 })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, persist: "retain" })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, idleTimeoutMs: 5 })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, agentCmd: "codex" })).toBe(false);
		expect(vmSettingsEqual(a, { ...a, secretsDir: "/s" })).toBe(false);
	});

	it("VM_APPLY_HINT carries the matrix-row-3 phrasing", () => {
		expect(VM_APPLY_HINT).toBe("vm settings saved — restart openhammer to apply them");
	});

	it("sandboxHeaderRows appends the apply-on-restart note only while a change is pending", () => {
		const row = sandboxStateRow(vmState());
		expect(sandboxHeaderRows(vmState(), null)).toEqual([row]); // default: not pending
		expect(sandboxHeaderRows(vmState(), null, false)).toEqual([row]);
		expect(sandboxHeaderRows(vmState(), null, true)).toEqual([row, `note: ${VM_APPLY_HINT}`]);
		expect(sandboxHeaderRows(vmState(), "/home/sandbox", true)).toEqual([
			row,
			"guest root: /home/sandbox",
			`note: ${VM_APPLY_HINT}`,
		]);
	});
});
