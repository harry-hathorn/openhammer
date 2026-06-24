import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createDashboardRenderer, type FrameProducer } from "./render.ts";

/**
 * A fake pi-tui `Terminal` — records writes + stores the input/resize callbacks
 * so the test drives the render loop without a real TTY (the `17b`/`17s`
 * fake-IO precedent). Implements the full `Terminal` interface honestly (no `as`
 * cast): the cursor/clear/title/progress ops are inert; what matters is `start`
 * (raw-mode entry), `write` (the rendered output), and the `send`/`resize`
 * drivers that simulate keys + resizing.
 */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	started = false;
	stopped = false;
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.started = true;
		this.stopped = false;
	}

	stop(): void {
		this.stopped = true;
		this.started = false;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.writes.push(data);
	}

	// Inert cursor/clear/title/progress ops — fewer params than the interface
	// declares is fine (a DashboardRenderer only reads writes + drives start/send/resize).
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

	/** Simulate a terminal resize (and report the new size to the TUI). */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}

	/** All bytes written so far, joined (handy for substring asserts on rendered frames). */
	output(): string {
		return this.writes.join("");
	}
}

/**
 * Flush pi-tui's async render scheduling. A render is `process.nextTick` →
 * `scheduleRender` → `setTimeout(delay)`, and pi-tui coalesces to ≥16ms
 * (`MIN_RENDER_INTERVAL_MS`) — so wait past that throttle, then a few macrotask
 * turns, before asserting a frame has landed.
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("dashboard renderer — lifecycle", () => {
	it("start() enters raw mode (terminal.start) and stop() restores it (terminal.stop)", () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		renderer.start(() => ["frame"]);
		expect(term.started).toBe(true);
		expect(term.stopped).toBe(false);

		renderer.stop();
		expect(term.stopped).toBe(true);
	});

	it("stop() is idempotent — a second stop is a no-op", () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		renderer.start(() => ["frame"]);
		renderer.stop();
		expect(() => renderer.stop()).not.toThrow();
		expect(term.stopped).toBe(true);
	});

	it("stop() without start() is safe (no throw)", () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		expect(() => renderer.stop()).not.toThrow();
	});
});

describe("dashboard renderer — frame production", () => {
	it("pulls the frame on start with the terminal width + height and draws it", async () => {
		const term = new FakeTerminal();
		term.columns = 100;
		term.rows = 30;
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const calls: Array<{ w: number; h: number }> = [];
		const produce: FrameProducer = (w, h) => {
			calls.push({ w, h });
			return ["line one", "line two"];
		};

		renderer.start(produce);
		await flush();

		expect(calls.length).toBeGreaterThanOrEqual(1);
		expect(calls[0]).toEqual({ w: 100, h: 30 });
		// First render is a fullRender(false): lines are written joined by \r\n.
		expect(term.output()).toContain("line one");
		expect(term.output()).toContain("line two");
		renderer.stop();
	});

	it("clear() forces a full screen clear + redraw", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		renderer.start(() => ["frame"]);
		await flush();

		term.writes.length = 0; // ignore the initial render
		renderer.clear();
		await flush();

		// requestRender(true) → widthChanged → fullRender(clear=true) writes the clear sequence.
		expect(term.output()).toContain("\x1b[2J");
		renderer.stop();
	});
});

describe("dashboard renderer — keys", () => {
	it("onKey delivers raw input sequences (e.g. Ctrl+C as \\x03)", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const seen: string[] = [];
		renderer.onKey((data) => seen.push(data));
		renderer.start(() => ["frame"]);
		await flush();

		term.send("\x03"); // Ctrl+C
		term.send("q");

		expect(seen).toEqual(["\x03", "q"]);
		renderer.stop();
	});

	it("a key triggers a re-render (the frame producer is pulled again)", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		let pulls = 0;
		renderer.start(() => {
			pulls += 1;
			return [`pull ${pulls}`];
		});
		await flush();
		const afterStart = pulls;

		term.send("a");
		await flush();

		expect(pulls).toBeGreaterThan(afterStart);
		renderer.stop();
	});

	it("keys before onKey is registered are harmless (no throw, no handler)", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		renderer.start(() => ["frame"]);
		await flush();

		expect(() => term.send("x")).not.toThrow();
		renderer.stop();
	});
});

describe("dashboard renderer — resize", () => {
	it("resize re-renders at the new width", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 0 });
		const widths: number[] = [];
		renderer.start((w) => {
			widths.push(w);
			return [`w=${w}`];
		});
		await flush();

		term.resize(120, 40);
		await flush();

		expect(widths).toContain(120);
		renderer.stop();
	});
});

describe("dashboard renderer — refresh cadence", () => {
	it("a refresh interval pulls fresh frames without a key or resize", async () => {
		const term = new FakeTerminal();
		const renderer = createDashboardRenderer({ terminal: term, refreshIntervalMs: 20 });
		let pulls = 0;
		renderer.start(() => {
			pulls += 1;
			return ["frame"];
		});
		await flush();
		const afterStart = pulls;

		// Wait long enough for at least one refresh tick (no key, no resize).
		await new Promise((resolve) => setTimeout(resolve, 60));
		await flush();

		expect(pulls).toBeGreaterThan(afterStart);
		renderer.stop();
	});
});
