import { describe, expect, it, vi } from "vitest";
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { defaultVmSettings, type VmSettings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import type { VmStateLine } from "../../observability/status-socket.ts";
import { BUILD_LOG_LIMIT, DashboardStore, emptyStatus, type ServerStatusState } from "./store.ts";

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
	return {
		version: 1,
		channels,
		defaultChannel: channels[0]?.id ?? null,
		mcp: { allowedClients: [] },
		vm: defaultVmSettings(),
	};
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

		const clients: ClientInfo[] = [
			{ clientId: "oh_1", label: "a", createdAt: "now", grantTypes: ["client_credentials"] },
		];
		s.setOauthClients(clients);
		expect(s.oauthClients).toBe(clients);

		expect(s.loginConfigured).toBe(false); // defaults unset
		s.setLoginConfigured(true);
		expect(s.loginConfigured).toBe(true);

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

/** A settings doc with only the vm mode overridden. */
function settingsInMode(mode: VmSettings["mode"]): Settings {
	return {
		version: 1,
		channels: [],
		defaultChannel: null,
		mcp: { allowedClients: [] },
		vm: { ...defaultVmSettings(), mode },
	};
}

describe("DashboardStore — vm-state (spec 28)", () => {
	it("applyVmStateLine holds the latest line and marks the vm observed", () => {
		const s = new DashboardStore();
		expect(s.latestVmState).toBeNull();
		expect(s.vmObserved).toBe(false);
		s.applyVmStateLine(JSON.stringify(vmLine({ state: "booting", phase: "ssh", sessionId: null, sshPort: null })));
		expect(s.latestVmState?.state).toBe("booting");
		s.applyVmStateLine(JSON.stringify(vmLine()));
		expect(s.latestVmState).toEqual(vmLine()); // latest wins
		expect(s.vmObserved).toBe(true);
	});

	it("a stopped line keeps the sticky observed flag (the sandbox existed)", () => {
		const s = new DashboardStore();
		s.applyVmStateLine(JSON.stringify(vmLine()));
		s.applyVmStateLine(JSON.stringify(vmLine({ state: "stopped", sessionId: null, sshPort: null })));
		expect(s.latestVmState?.state).toBe("stopped");
		expect(s.vmObserved).toBe(true);
	});

	it("an off line is held but does NOT mark the vm observed", () => {
		const s = new DashboardStore();
		s.applyVmStateLine(JSON.stringify(vmLine({ state: "off", sessionId: null })));
		expect(s.latestVmState?.state).toBe("off");
		expect(s.vmObserved).toBe(false);
	});

	it("an unknown line kind leaves the store unharmed (the 27h additive-parse twin)", () => {
		const s = new DashboardStore();
		s.applyVmStateLine('{"type":"future-thing","x":1}');
		s.applyVmStateLine("{not json");
		s.applyVmStateLine("");
		s.applyVmStateLine(JSON.stringify({ type: "channel-state", id: "c1", up: true, url: null }));
		// A vm-state discriminator with missing fields is rejected too:
		s.applyVmStateLine(JSON.stringify({ type: "vm-state", state: "ready" }));
		expect(s.latestVmState).toBeNull();
		expect(s.vmObserved).toBe(false);
	});

	it("vmRoot is null in off mode without resolving any vm config (zero-VM pin)", () => {
		const guestUser = vi.fn(() => {
			throw new Error("must not be called in off mode");
		});
		const s = new DashboardStore({ guestUser }, settingsInMode("off"));
		expect(s.vmRoot).toBeNull();
		expect(guestUser).not.toHaveBeenCalled();
	});

	it("vm mode resolves MCP_ROOT_DIR as the guest root (the reinterpretation)", () => {
		const s = new DashboardStore({ env: { MCP_ROOT_DIR: "/srv/guest-work" } }, settingsInMode("vm"));
		expect(s.vmRoot).toBe("/srv/guest-work");
	});

	it("vm mode with MCP_ROOT_DIR unset defaults to /home/<guestUser> via the seam", () => {
		const s = new DashboardStore({ env: {}, guestUser: () => "sandbox" }, settingsInMode("vm"));
		expect(s.vmRoot).toBe("/home/sandbox");
	});

	it("an unresolvable env degrades to null instead of throwing into a render", () => {
		// A malformed MCP_VM_* value throws in resolveConfig (the boot-fatal
		// posture) — the dashboard hides the row rather than crash a render.
		const s = new DashboardStore({ env: { MCP_VM_MEMORY: "banana" } }, settingsInMode("vm"));
		expect(s.vmRoot).toBeNull();
	});

	it("vmRoot memoizes the resolution across reads", () => {
		const guestUser = vi.fn(() => "sandbox");
		const s = new DashboardStore({ env: {}, guestUser }, settingsInMode("vm"));
		expect(s.vmRoot).toBe("/home/sandbox");
		expect(s.vmRoot).toBe("/home/sandbox");
		expect(guestUser).toHaveBeenCalledTimes(1);
	});
});

describe("DashboardStore — hasGolden + vmApplyPending (spec 28, box 28c)", () => {
	it("hasGolden consults the injected probe once and memoizes (vmRoot's lazy-cache idiom)", () => {
		let calls = 0;
		const s = new DashboardStore({
			goldenExists: () => {
				calls += 1;
				return true;
			},
		});
		expect(s.hasGolden).toBe(true);
		expect(s.hasGolden).toBe(true); // second read — cached
		expect(calls).toBe(1);
	});

	it("hasGolden false is the Install row's precondition (no bootable golden)", () => {
		const s = new DashboardStore({ goldenExists: () => false });
		expect(s.hasGolden).toBe(false);
	});

	it("setVmApplyPending flips the saved-but-not-applied flag (the row-3 hint's source)", () => {
		const s = new DashboardStore();
		expect(s.vmApplyPending).toBe(false);
		s.setVmApplyPending(true);
		expect(s.vmApplyPending).toBe(true);
		s.setVmApplyPending(false);
		expect(s.vmApplyPending).toBe(false);
	});

	it("refreshGolden invalidates the memo — the next read re-probes (the build chain's completion)", () => {
		let calls = 0;
		let exists = false;
		const s = new DashboardStore({
			goldenExists: () => {
				calls += 1;
				return exists;
			},
		});
		expect(s.hasGolden).toBe(false);
		exists = true;
		expect(s.hasGolden).toBe(false); // still cached — the pre-28j staleness
		s.refreshGolden();
		expect(s.hasGolden).toBe(true); // re-probed
		expect(s.hasGolden).toBe(true); // re-memoized
		expect(calls).toBe(2);
	});

	it("appendBuildLog rings the build progress at BUILD_LOG_LIMIT (newest last)", () => {
		const s = new DashboardStore();
		for (let i = 0; i < BUILD_LOG_LIMIT + 50; i++) s.appendBuildLog(`line ${i}`);
		expect(s.buildLog).toHaveLength(BUILD_LOG_LIMIT);
		expect(s.buildLog[0]).toBe(`line ${50}`); // the head was dropped
		expect(s.buildLog.at(-1)).toBe(`line ${BUILD_LOG_LIMIT + 49}`);
	});
});
