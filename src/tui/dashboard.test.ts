import { describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
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
