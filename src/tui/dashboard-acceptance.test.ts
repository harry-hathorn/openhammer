/**
 * Spec 19 acceptance (checkbox 19f) — the cross-cutting dashboard test suite.
 *
 * The per-module units cover each piece **in isolation**:
 * - `panels.test.ts` (19b) — each pure panel function + `composeDashboard` layout.
 * - `render.test.ts` (19a) — the real pi-tui `DashboardRenderer` via a fake `Terminal`.
 * - `server-control.test.ts` (19e) — `ensureServer`/`stop` lifecycle in isolation.
 * - `dashboard.test.ts` (19b–19e) — `runDashboard` via a fake `DashboardRenderer`.
 *
 * This file is the **acceptance lens** (spec 19 line 45 — "Hermetic trio green: panel
 * logic via the pure panel functions; rendering via the injectable `DashboardRenderer`";
 * + line 44 — "quitting the dashboard stops the child (no orphan)"): it drives the
 * dashboard through the **real integration surfaces** the units split apart —
 * - the pure panels compose into the full control-center screen (all four populated);
 * - the REAL pi-tui renderer renders the REAL `runDashboard` loop's frames (the real
 *   panels composed by the loop), handles keys, and restores the terminal on quit;
 * - the REAL `ServerControl.stop()` (from `ensureServer`) is reaped when the dashboard
 *   quits via the `onQuit` seam (the `defaultDashboard` wiring) — no orphan child.
 *
 * Mirrors the `guide-acceptance.test.ts` (18b) precedent: a cross-cutting acceptance
 * suite complementing (not duplicating) the per-module units, with no `src/` changes.
 */
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.ts";
import type { Config } from "../config.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
import type { ServerStatusState } from "./dashboard/panels.ts";
import { composeDashboard } from "./dashboard/panels.ts";
import type { DashboardRenderer, FrameProducer } from "./dashboard/render.ts";
import { createDashboardRenderer } from "./dashboard/render.ts";
import { ensureServer, type ServerChild } from "./dashboard/server-control.ts";
import { runDashboard } from "./dashboard.ts";

// ---- shared fixtures ---------------------------------------------------------

/** A minimal `Config` — only `host`/`port` feed the URL `ensureServer` constructs. */
function config(port = 3000): Config {
	return {
		port,
		host: "127.0.0.1",
		rootDir: "/tmp",
		authToken: undefined,
		maxResponseBytes: 512_000,
		logLevel: "silent",
	};
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
 * Flush pi-tui's async render scheduling. A render is `process.nextTick` →
 * `scheduleRender` → `setTimeout(delay)`, and pi-tui coalesces to ≥16ms
 * (`MIN_RENDER_INTERVAL_MS`) — so wait past that throttle, then a few macrotask
 * turns, before asserting a frame has landed. (Same helper as `render.test.ts`.)
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

/**
 * A fake pi-tui `Terminal` — records writes + stores the input/resize callbacks so
 * the test drives the render loop without a real TTY. Implements the full `Terminal`
 * interface honestly (no `as` cast): cursor/clear/title ops are inert; what matters is
 * `start` (raw-mode entry), `write` (rendered output), and the `send`/`resize` drivers
 * that simulate keys + resizing. (Same shape as `render.test.ts`'s `FakeTerminal`.)
 */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	started = false;
	stopped = false;
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void, _onResize: () => void): void {
		this.inputHandler = onInput;
		this.started = true;
		this.stopped = false;
	}

	stop(): void {
		// Mirror ProcessTerminal.stop(): detach the input handler so no keys arrive
		// while stopped; start() re-attaches it.
		this.inputHandler = undefined;
		this.stopped = true;
		this.started = false;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.writes.push(data);
	}

	// Inert cursor/clear/title/progress ops — fewer params than the interface declares
	// is fine (method bivariance); a renderer only reads writes + drives start/send.
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	/** Simulate a keypress reaching the TUI's input handler. */
	send(data: string): void {
		this.inputHandler?.(data);
	}

	/** All bytes written so far, joined (handy for substring asserts on rendered frames). */
	output(): string {
		return this.writes.join("");
	}
}

/**
 * A minimal `DashboardRenderer` that forwards keys + records `stop()` — enough to drive
 * `runDashboard`'s quit path (the lifecycle acceptance group) without a render loop.
 * Implements the full interface honestly (no `as`).
 */
class MinimalRenderer implements DashboardRenderer {
	stopped = false;
	private keyHandler: ((data: string) => void) | undefined;

	onKey(cb: (data: string) => void): void {
		this.keyHandler = cb;
	}

	start(_produceFrame: FrameProducer): void {}

	stop(): void {
		this.stopped = true;
	}

	clear(): void {}

	suspend(): void {}

	resume(): void {}

	/** Deliver a raw key sequence to the loop's handler. */
	key(data: string): void {
		this.keyHandler?.(data);
	}
}

/**
 * A controllable fake child for `ensureServer`. A `cooperative` child emits exit shortly
 * after `kill` (graceful `stop` reaps it); `signals` records every signal sent, in order.
 * (Same shape as `server-control.test.ts`'s `FakeChild`, trimmed to the lifecycle path.)
 */
class FakeChild implements ServerChild {
	pid = 4242;
	killed = false;
	cooperative = true;
	signals: string[] = [];
	private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
	stderr = { on: (): unknown => undefined };

	once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
		this.exitListeners.push(listener);
	}

	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		const sig = typeof signal === "number" ? String(signal) : signal;
		this.signals.push(sig);
		this.killed = true;
		if (this.cooperative) setTimeout(() => this.emitExit(null, null), 0);
		return true;
	}

	emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
		const listeners = this.exitListeners;
		this.exitListeners = [];
		for (const listener of listeners) listener(code, signal);
	}
}

/** A spawn fake over a controllable child that also records each invocation. */
function spawnOf(child: FakeChild): ((mainPath: string, args: string[]) => ServerChild) & {
	seen: Array<{ mainPath: string; args: string[] }>;
} {
	const seen: Array<{ mainPath: string; args: string[] }> = [];
	const fn = (mainPath: string, args: string[]): ServerChild => {
		seen.push({ mainPath, args });
		return child;
	};
	return Object.assign(fn, { seen });
}

// ---- 1. panel pure functions ------------------------------------------------

describe("spec 19 acceptance — panel pure functions render the full control-center screen", () => {
	it("composes status / channels / clients / monitor + the key menu from realistic live state", () => {
		const status: ServerStatusState = {
			up: true,
			localUrl: "http://127.0.0.1:3000/mcp",
			publicUrl: null,
			token: "tok-abc",
		};
		const frame = composeDashboard(
			{
				status,
				channels: [{ id: "edge", kind: "ngrok", mode: "live", label: "edge", options: {} }],
				defaultChannelId: "edge",
				channelState: { edge: { up: true, url: "https://edge.ngrok.app/mcp" } },
				clients: [{ client: "claude-code", calls: 2, lastSeen: "2026-06-24T12:01:03.000Z" }],
				monitor: [event({ client: "claude-code", tool: "bash", ms: 1200 })],
				monitorLimit: 8,
			},
			120,
		);
		const out = frame.join("\n");

		// Status panel — server up + the local endpoint + the token.
		expect(out).toContain("STATUS");
		expect(out).toContain("server: up");
		expect(out).toContain("local:  http://127.0.0.1:3000/mcp");
		expect(out).toContain("token:  tok-abc");
		// Channels panel — the configured channel + its live URL (not `unknown`).
		expect(out).toContain("CHANNELS");
		expect(out).toContain("edge");
		expect(out).toContain("https://edge.ngrok.app/mcp");
		expect(out).toContain(" up ");
		// Clients panel — the connected client + its call count.
		expect(out).toContain("CLIENTS");
		expect(out).toContain("claude-code");
		expect(out).toContain("2 calls");
		// Monitor panel — the streaming event.
		expect(out).toContain("MONITOR");
		expect(out).toContain("bash");
		// Footer key menu.
		expect(out).toContain("r refresh");
		expect(out).toContain("q quit");
	});
});

// ---- 2. rendering via the injectable DashboardRenderer ----------------------

describe("spec 19 acceptance — rendering via the injectable DashboardRenderer (real pi-tui + real loop)", () => {
	it("the real pi-tui renderer renders the real runDashboard frame (panels composed by the loop)", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const status: ServerStatusState = {
			up: true,
			localUrl: "http://127.0.0.1:3000/mcp",
			publicUrl: null,
			token: "tok-abc",
		};
		const done = runDashboard({
			renderer,
			settings: {
				...emptySettings(),
				defaultChannel: "edge",
				channels: [{ id: "edge", kind: "ngrok", mode: "live", label: "edge", options: {} }],
			},
			status,
		});

		await flush();

		// The real renderer pulled the loop's frame producer, which composes the real
		// panels — so the rendered terminal output carries the full dashboard, not a stub.
		const out = term.output();
		expect(out).toContain("STATUS");
		expect(out).toContain("server: up");
		expect(out).toContain("edge"); // channels panel — the configured channel
		expect(out).toContain("r refresh"); // footer key menu

		term.send("q");
		await done;
		expect(term.stopped).toBe(true); // terminal restored on quit (no raw-mode leak)
	});

	it("'r' forces a full screen clear + redraw on the real renderer", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const done = runDashboard({ renderer, settings: emptySettings() });
		await flush();

		term.writes.length = 0; // ignore the initial render
		term.send("r"); // runDashboard → renderer.clear() → tui.requestRender(true)
		await flush();

		expect(term.output()).toContain("\x1b[2J"); // the full-screen clear sequence
		term.send("q");
		await done;
	});

	it("Ctrl+C (\\x03) restores the terminal and resolves the loop", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const done = runDashboard({ renderer, settings: emptySettings() });
		await flush();

		term.send("\x03");
		await done;
		expect(term.stopped).toBe(true);
	});
});

// ---- 3. lifecycle start/stop ------------------------------------------------

describe("spec 19 acceptance — lifecycle start/stop (quitting the dashboard reaps the child)", () => {
	it("quitting the dashboard stops the spawned server child via onQuit (no orphan)", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		// First probe (the attach check) → down → spawn; subsequent probes (the ready
		// poll) → up → ready (mirrors `server-control.test.ts`'s spawn case).
		let probeCalls = 0;
		const control = await ensureServer(config(), {
			probeHealth: async () => {
				probeCalls += 1;
				return probeCalls > 1;
			},
			spawn,
			exists: () => true,
			token: "tok",
			readyIntervalMs: 1,
		});
		expect(control.ok).toBe(true);
		if (!control.ok) return;
		expect(control.value.ownsServer).toBe(true);

		const renderer = new MinimalRenderer();
		// Wire onQuit → control.stop exactly as `defaultDashboard` (cli.ts) does.
		const done = runDashboard({
			renderer,
			settings: emptySettings(),
			onQuit: async () => {
				const result = await control.value.stop();
				if (!result.ok) throw result.error;
			},
		});

		renderer.key("q"); // quit → onQuit → control.stop → SIGTERM the child
		await done;

		expect(renderer.stopped).toBe(true); // the dashboard restored its renderer
		expect(child.signals).toContain("SIGTERM"); // the spawned child was reaped
		expect(child.signals).not.toContain("SIGKILL"); // cooperative child — no backstop needed
	});

	it("attaching to an already-running server does not spawn, and quit is a no-op stop", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		const control = await ensureServer(config(), {
			probeHealth: async () => true, // up → attach
			spawn,
			token: "tok",
		});
		expect(control.ok).toBe(true);
		if (!control.ok) return;
		expect(control.value.ownsServer).toBe(false);
		expect(spawn.seen).toEqual([]); // never spawned a second server

		const renderer = new MinimalRenderer();
		const done = runDashboard({
			renderer,
			settings: emptySettings(),
			onQuit: async () => {
				await control.value.stop();
			},
		});

		renderer.key("q");
		await done;

		expect(child.killed).toBe(false); // attached → stop touches no child
	});
});
