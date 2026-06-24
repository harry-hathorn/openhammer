import { describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
import type { ChannelStateLine } from "../observability/status-socket.ts";
import type { Result } from "../tools/result.ts";
import { err, ok } from "../tools/result.ts";
import type { ChannelProbeState } from "./dashboard/channel-probe.ts";
import type { DashboardRenderer, FrameProducer } from "./dashboard/render.ts";
import { DASHBOARD_MONITOR_LIMIT, runDashboard } from "./dashboard.ts";

/**
 * A fake `DashboardRenderer` that captures the frame producer + key handler so the
 * test drives the render loop without a terminal (the 17b/17s fake-IO precedent, and
 * exactly what `render.ts` says `runDashboard`'s tests do). `frame()` pulls a frame
 * from the latest producer; `key()` delivers a raw input sequence.
 */
class FakeRenderer implements DashboardRenderer {
	produce: FrameProducer | undefined;
	private keyHandler: ((data: string) => void) | undefined;
	stopped = false;
	clearCount = 0;
	suspendCount = 0;
	resumeCount = 0;

	onKey(cb: (data: string) => void): void {
		this.keyHandler = cb;
	}

	start(produceFrame: FrameProducer): void {
		this.produce = produceFrame;
	}

	stop(): void {
		this.stopped = true;
	}

	clear(): void {
		this.clearCount += 1;
	}

	suspend(): void {
		this.suspendCount += 1;
	}

	resume(): void {
		this.resumeCount += 1;
	}

	/** Pull a frame at a given size (the producer ignores height — panels are width-only). */
	frame(width = 80, height = 24): string[] {
		return this.produce ? this.produce(width, height) : [];
	}

	/** Deliver a raw key sequence to the loop's handler. */
	key(data: string): void {
		this.keyHandler?.(data);
	}
}

/** A full empty `Settings` doc (the loader's shape). */
function emptySettings(): Settings {
	return { version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } };
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

/**
 * The monitor event lines in a frame — those under the `MONITOR` header (they all
 * start with `  [` from the `[HH:MM:SS]` timestamp). Isolating them lets a cap test
 * assert on the feed alone: the clients panel legitimately retains every client
 * (`MonitorState` accumulates), so a whole-frame `not.toContain` would false-pass.
 */
function monitorLines(frame: string[]): string[] {
	const start = frame.indexOf("MONITOR");
	if (start < 0) return [];
	const out: string[] = [];
	for (let i = start + 1; i < frame.length; i++) {
		const line = frame[i];
		if (line === "") break; // next section / footer rule
		out.push(line);
	}
	return out;
}

/** `subscribe` seam that captures the push callback so the test can deliver events. */
function capturingSubscribe(): {
	subscribe: (onEvent: (e: RequestEvent) => void) => () => void;
	push: (e: RequestEvent) => void;
} {
	let push: ((e: RequestEvent) => void) | undefined;
	return {
		subscribe: (onEvent) => {
			push = onEvent;
			return () => {};
		},
		push: (e) => push?.(e),
	};
}

describe("runDashboard — initial render", () => {
	it("composes all four panels on start", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({ renderer: r, settings: emptySettings() });
		const out = r.frame().join("\n");
		expect(out).toContain("STATUS");
		expect(out).toContain("CHANNELS");
		expect(out).toContain("CLIENTS");
		expect(out).toContain("MONITOR");
		r.key("q");
		await done;
	});

	it("renders the configured channels from settings (with the default marker)", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				defaultChannel: "a",
				channels: [{ id: "a", kind: "ngrok", mode: "live", label: "edge", options: {} }],
			},
		});
		const out = r.frame().join("\n");
		expect(out).toContain("edge");
		expect(out).toContain(" * "); // default marker
		r.key("q");
		await done;
	});
});

describe("runDashboard — live feed", () => {
	it("folds subscribed events into the monitor + clients panels", async () => {
		const r = new FakeRenderer();
		const { subscribe, push } = capturingSubscribe();
		const done = runDashboard({ renderer: r, settings: emptySettings(), subscribe });

		push(event()); // claude-code tools/call bash

		const out = r.frame().join("\n");
		expect(out).toContain("claude-code"); // appears in both clients + monitor
		expect(out).toContain("bash");
		expect(out).toContain("1 call"); // clients panel, singular
		r.key("q");
		await done;
	});

	it("caps the monitor ring to monitorLimit (the tail is kept)", async () => {
		const r = new FakeRenderer();
		const { subscribe, push } = capturingSubscribe();
		const done = runDashboard({ renderer: r, settings: emptySettings(), subscribe, monitorLimit: 3 });

		for (let i = 0; i < 10; i++) push(event({ client: `c${i}`, ms: i }));

		const feed = monitorLines(r.frame()).join("\n");
		// The monitor panel keeps only the last 3 (c7/c8/c9); c0..c6 dropped.
		for (let i = 7; i <= 9; i++) expect(feed).toContain(`c${i}`);
		for (let i = 0; i <= 6; i++) expect(feed).not.toContain(`c${i}`);
		r.key("q");
		await done;
	});

	it("defaults the monitor limit to DASHBOARD_MONITOR_LIMIT", async () => {
		const r = new FakeRenderer();
		const { subscribe, push } = capturingSubscribe();
		const done = runDashboard({ renderer: r, settings: emptySettings(), subscribe });

		for (let i = 0; i < DASHBOARD_MONITOR_LIMIT + 5; i++) push(event({ client: `c${i}`, ms: i }));

		const feed = monitorLines(r.frame()).join("\n");
		// Older events beyond the default limit are dropped from the feed.
		expect(feed).not.toContain("c0");
		r.key("q");
		await done;
	});
});

describe("runDashboard — channel live-state (19c-channel)", () => {
	it("folds channel-state into the channels panel (live up + url, not unknown)", async () => {
		const r = new FakeRenderer();
		let pushState: ((state: ChannelStateLine) => void) | undefined;
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				channels: [
					{
						id: "deployed",
						kind: "static-url",
						mode: "static",
						label: "edge",
						options: { publicUrl: "https://old.example" },
					},
				],
			},
			// The 2nd subscribe callback receives channel-state lines (19c-channel).
			subscribe: (_onEvent, onChannelState) => {
				pushState = onChannelState;
				return () => {};
			},
		});

		// Before any state: the channel shows `unknown` + its declared publicUrl.
		let out = r.frame().join("\n");
		expect(out).toContain("unknown");
		expect(out).toContain("https://old.example");

		// The server reports the channel up with a live URL → `up` + live URL, not `unknown`.
		pushState?.({ type: "channel-state", id: "deployed", up: true, url: "https://edge.example/mcp" });
		out = r.frame().join("\n");
		expect(out).toContain("static-url  static  up  https://edge.example/mcp");
		expect(out).not.toContain("unknown");
		expect(out).not.toContain("https://old.example"); // the live URL overrides the stale declared one
		r.key("q");
		await done;
	});

	it("reports a channel as down when the server says so", async () => {
		const r = new FakeRenderer();
		let pushState: ((state: ChannelStateLine) => void) | undefined;
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				channels: [{ id: "dead", kind: "ngrok", mode: "live", label: "gone", options: {} }],
			},
			subscribe: (_onEvent, onChannelState) => {
				pushState = onChannelState;
				return () => {};
			},
		});

		pushState?.({ type: "channel-state", id: "dead", up: false, url: null });
		const out = r.frame().join("\n");
		expect(out).toContain("ngrok  live  down");
		expect(out).not.toContain("unknown");
		r.key("q");
		await done;
	});
});

describe("runDashboard — static-channel probe (19c-probe)", () => {
	it("folds probe results into the channels panel (non-active static channel up/down, not unknown)", async () => {
		const r = new FakeRenderer();
		let pushProbe: ((s: ChannelProbeState) => void) | undefined;
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				channels: [
					{
						id: "edge",
						kind: "static-url",
						mode: "static",
						label: "edge",
						options: { publicUrl: "https://edge.example" },
					},
				],
			},
			probeChannels: (report) => {
				pushProbe = report;
				return () => {};
			},
		});

		// Before the probe: the channel shows `unknown` + its declared publicUrl.
		let out = r.frame().join("\n");
		expect(out).toContain("unknown");

		// The probe reports the static channel reachable → `up` + URL, not `unknown`.
		pushProbe?.({ id: "edge", up: true, url: "https://edge.example" });
		out = r.frame().join("\n");
		expect(out).toContain("static-url  static  up  https://edge.example");
		expect(out).not.toContain("unknown");
		r.key("q");
		await done;
	});

	it("keeps the server-reported (active) channel authoritative over a late probe result", async () => {
		const r = new FakeRenderer();
		let pushState: ((state: ChannelStateLine) => void) | undefined;
		let pushProbe: ((s: ChannelProbeState) => void) | undefined;
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				channels: [
					{
						id: "active",
						kind: "static-url",
						mode: "static",
						label: "active",
						options: { publicUrl: "https://active.example" },
					},
				],
			},
			subscribe: (_onEvent, onChannelState) => {
				pushState = onChannelState;
				return () => {};
			},
			probeChannels: (report) => {
				pushProbe = report;
				return () => {};
			},
		});

		// The server reports the active channel down (authoritative).
		pushState?.({ type: "channel-state", id: "active", up: false, url: "https://active.example" });
		// A probe result for the same channel arrives late → ignored (server wins).
		pushProbe?.({ id: "active", up: true, url: "https://active.example" });
		const out = r.frame().join("\n");
		expect(out).toContain("static-url  static  down");
		expect(out).not.toContain("static-url  static  up");
		r.key("q");
		await done;
	});

	it("passes isReported to the probe (true for server-reported channels)", async () => {
		const r = new FakeRenderer();
		let receivedIsReported: ((id: string) => boolean) | undefined;
		const done = runDashboard({
			renderer: r,
			settings: {
				...emptySettings(),
				channels: [{ id: "active", kind: "static-url", mode: "static", options: { publicUrl: "https://x" } }],
			},
			subscribe: (_onEvent, onChannelState) => {
				onChannelState?.({ type: "channel-state", id: "active", up: true, url: "https://x" });
				return () => {};
			},
			probeChannels: (_report, isReported) => {
				receivedIsReported = isReported;
				return () => {};
			},
		});
		// subscribe fires synchronously on start → "active" is server-reported before
		// the probe seam is wired, so isReported reflects it (the probe would skip it).
		expect(receivedIsReported?.("active")).toBe(true);
		expect(receivedIsReported?.("other")).toBe(false);
		r.key("q");
		await done;
	});

	it("unsubscribes the probe on quit", async () => {
		const r = new FakeRenderer();
		let unsubbed = false;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			probeChannels: () => () => {
				unsubbed = true;
			},
		});
		r.key("q");
		await done;
		expect(unsubbed).toBe(true);
	});
});

describe("runDashboard — keys + shutdown", () => {
	it("'q' stops the renderer and resolves the loop", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({ renderer: r, settings: emptySettings() });
		expect(r.stopped).toBe(false);
		r.key("q");
		await done;
		expect(r.stopped).toBe(true);
	});

	it("Ctrl+C (\\x03) quits", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({ renderer: r, settings: emptySettings() });
		r.key("\x03");
		await done;
		expect(r.stopped).toBe(true);
	});

	it("'r' forces a full redraw via renderer.clear()", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({ renderer: r, settings: emptySettings() });
		r.key("r");
		expect(r.clearCount).toBe(1);
		r.key("q");
		await done;
	});

	it("quits idempotently — onQuit runs once even on a double quit", async () => {
		const r = new FakeRenderer();
		let onQuitCalls = 0;
		const done = runDashboard({ renderer: r, settings: emptySettings(), onQuit: () => void onQuitCalls++ });
		r.key("q");
		r.key("q"); // second quit is a no-op
		await done;
		expect(onQuitCalls).toBe(1);
	});

	it("unsubscribes the live feed on quit", async () => {
		const r = new FakeRenderer();
		let unsubbed = false;
		const { subscribe, push } = capturingSubscribe();
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			subscribe: (onEvent) => {
				const inner = subscribe(onEvent);
				return () => {
					unsubbed = true;
					inner();
				};
			},
		});
		push(event());
		r.key("q");
		await done;
		expect(unsubbed).toBe(true);
	});

	it("awaits an async onQuit before resolving (and swallows its throw)", async () => {
		const r = new FakeRenderer();
		let onQuitDone = false;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			onQuit: () =>
				new Promise<void>((resolve) => {
					setTimeout(() => {
						onQuitDone = true;
						resolve();
					}, 5);
				}),
		});
		r.key("q");
		await done; // must not resolve until onQuit settles
		expect(onQuitDone).toBe(true);

		// A throwing onQuit is swallowed (logged), never rejects the loop.
		const r2 = new FakeRenderer();
		const threw = runDashboard({
			renderer: r2,
			settings: emptySettings(),
			onQuit: () => {
				throw new Error("boom");
			},
		});
		r2.key("q");
		await expect(threw).resolves.toBeUndefined();
	});
});

/** Flush one macrotask so a fire-and-forget modal (`void withModal(...)`) settles:
 * the modal is async, so `r.key("a")` returns before suspend→run→resume completes. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("runDashboard — key-menu modals (19d)", () => {
	it("shows the modal keys in the footer only when wired (no dead keys)", async () => {
		// add/config always appear (same-layer defaults); doctor only when wired.
		const r = new FakeRenderer();
		const done = runDashboard({ renderer: r, settings: emptySettings() });
		expect(r.frame().join("\n")).toContain("a add channel");
		expect(r.frame().join("\n")).toContain("c config");
		expect(r.frame().join("\n")).not.toContain("d doctor");

		const r2 = new FakeRenderer();
		const done2 = runDashboard({ renderer: r2, settings: emptySettings(), doctorModal: async () => 0 });
		expect(r2.frame().join("\n")).toContain("d doctor");

		r.key("q");
		await done;
		r2.key("q");
		await done2;
	});

	it("'a' suspends, runs addChannel with the current settings, persists, resumes, and refreshes the channels panel", async () => {
		const r = new FakeRenderer();
		let modalCalledWith: Settings | undefined;
		let persisted: Settings | undefined;
		const next: Settings = {
			...emptySettings(),
			channels: [{ id: "x", kind: "ngrok", mode: "live", label: "edge", options: {} }],
			defaultChannel: "x",
		};
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			addChannelModal: async (s) => {
				modalCalledWith = s;
				return ok(next);
			},
			persist: (s) => {
				persisted = s;
			},
		});

		expect(r.frame().join("\n")).toContain("(none configured)"); // before
		r.key("a");
		await tick();
		expect(r.suspendCount).toBe(1);
		expect(r.resumeCount).toBe(1);
		expect(modalCalledWith).toBeDefined(); // the wizard sees the current settings
		expect(persisted).toBe(next); // the new doc is persisted
		const out = r.frame().join("\n"); // after — the new channel is rendered
		expect(out).toContain("edge");
		expect(out).toContain("ngrok");
		r.key("q");
		await done;
	});

	it("a cancelled modal (null) does not persist and leaves the panel unchanged", async () => {
		const r = new FakeRenderer();
		let persisted = false;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			addChannelModal: async () => null,
			persist: () => {
				persisted = true;
			},
		});
		r.key("a");
		await tick();
		expect(persisted).toBe(false);
		expect(r.suspendCount).toBe(1);
		expect(r.resumeCount).toBe(1); // resume still runs (terminal restored)
		expect(r.frame().join("\n")).toContain("(none configured)");
		r.key("q");
		await done;
	});

	it("a failed probe (err) does not persist", async () => {
		const r = new FakeRenderer();
		let persisted = false;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			addChannelModal: async () => err(new Error("probe failed")),
			persist: () => {
				persisted = true;
			},
		});
		r.key("a");
		await tick();
		expect(persisted).toBe(false);
		r.key("q");
		await done;
	});

	it("'c' config modal persists the new settings", async () => {
		const r = new FakeRenderer();
		let persisted: Settings | undefined;
		const next: Settings = { ...emptySettings(), mcp: { allowedClients: ["claude-code"] } };
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			setSectionModal: async () => ok(next),
			persist: (s) => {
				persisted = s;
			},
		});
		r.key("c");
		await tick();
		expect(persisted).toBe(next);
		r.key("q");
		await done;
	});

	it("'d' doctor modal suspends + resumes with no persist", async () => {
		const r = new FakeRenderer();
		let doctorRan = false;
		let persisted = false;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			doctorModal: async () => {
				doctorRan = true;
				return 0;
			},
			persist: () => {
				persisted = true;
			},
		});
		r.key("d");
		await tick();
		expect(doctorRan).toBe(true);
		expect(r.suspendCount).toBe(1);
		expect(r.resumeCount).toBe(1);
		expect(persisted).toBe(false);
		r.key("q");
		await done;
	});

	it("ignores keys while a modal is running (re-entry guard)", async () => {
		const r = new FakeRenderer();
		let resolveModal: (v: Result<Settings, Error> | null) => void = () => {};
		let calls = 0;
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			addChannelModal: async () => {
				calls += 1;
				return new Promise((res) => {
					resolveModal = res;
				});
			},
		});
		r.key("a"); // starts the modal (pending)
		await tick();
		expect(calls).toBe(1);
		r.key("a"); // ignored — a modal is active
		r.key("q"); // ignored too — can't quit mid-modal
		await tick();
		expect(calls).toBe(1); // not re-entered
		expect(r.stopped).toBe(false); // the ignored 'q' did not quit
		resolveModal(null);
		await tick();
		r.key("q");
		await done;
	});

	it("a thrown modal is caught — resume still runs and the dashboard stays alive", async () => {
		const r = new FakeRenderer();
		const done = runDashboard({
			renderer: r,
			settings: emptySettings(),
			doctorModal: async () => {
				throw new Error("boom");
			},
		});
		r.key("d");
		await tick();
		expect(r.resumeCount).toBe(1); // resume ran despite the throw
		expect(r.stopped).toBe(false); // dashboard still alive
		r.key("q");
		await done;
	});
});
