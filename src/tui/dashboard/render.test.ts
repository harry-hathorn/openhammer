import type { Component, Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { createDashboardRenderer } from "./render.ts";

/**
 * A fake pi-tui `Terminal` — records writes + stores the input/resize callbacks so
 * the test drives the render loop without a real TTY (the `17b`/`19a` fake-IO
 * precedent). Implements the full `Terminal` interface honestly (no `as` cast).
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
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.stopped = true;
		this.started = false;
	}
	drainInput(): Promise<void> {
		return Promise.resolve();
	}
	write(data: string): void {
		this.writes.push(data);
	}
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
	/** Simulate a terminal resize. */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}
	/** All bytes written so far, joined. */
	output(): string {
		return this.writes.join("");
	}
}

/** A stub root that records renders + inputs (the renderer mounts/forwards to it). */
class StubRoot implements Component {
	renders = 0;
	lastWidth = 0;
	readonly inputs: string[] = [];
	handleInput(data: string): void {
		this.inputs.push(data);
	}
	render(width: number): string[] {
		this.renders += 1;
		this.lastWidth = width;
		return [`render#${this.renders}`];
	}
	invalidate(): void {}
}

/** Flush pi-tui's coalesced async render scheduling (≥16ms throttle + a few macrotasks). */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
	for (let i = 0; i < 3; i++) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("dashboard renderer — lifecycle", () => {
	it("start() enters raw mode; stop() restores it; stop() is idempotent", () => {
		const term = new FakeTerminal();
		const r = createDashboardRenderer({ root: new StubRoot(), terminal: term, refreshIntervalMs: 0 });
		r.start();
		expect(term.started).toBe(true);
		r.stop();
		expect(term.stopped).toBe(true);
		expect(() => r.stop()).not.toThrow(); // idempotent
	});

	it("renders the mounted root on start", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		expect(root.renders).toBeGreaterThanOrEqual(1);
		expect(term.output()).toContain("render#1");
		r.stop();
	});

	it("runs on the alternate screen (enter on start, exit on stop) so the banner is preserved", () => {
		const term = new FakeTerminal();
		const r = createDashboardRenderer({ root: new StubRoot(), terminal: term, refreshIntervalMs: 0 });
		r.start();
		expect(term.output()).toContain("\x1b[?1049h"); // entered the alt screen
		r.stop();
		expect(term.output()).toContain("\x1b[?1049l"); // exited → main screen (banner) restored
	});

	it("resume() force-clears + redraws (safe on the alt screen; recovers from a modal)", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		term.writes.length = 0;
		r.suspend();
		r.resume();
		await flush();
		expect(term.output()).toContain("\x1b[2J"); // force clear
		r.stop();
	});
});

describe("dashboard renderer — keys forwarded to the root", () => {
	it("a key reaches root.handleInput and triggers a re-render", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		const before = root.renders;

		term.send("a");
		await flush();

		expect(root.inputs).toContain("a");
		expect(root.renders).toBeGreaterThan(before);
		r.stop();
	});
});

describe("dashboard renderer — suspend/resume (modals)", () => {
	it("suspend() restores the terminal; resume() re-enters raw mode + re-renders", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		expect(term.stopped).toBe(false);

		r.suspend();
		expect(term.stopped).toBe(true);
		const whileSuspended = root.renders;

		r.resume();
		await flush();
		expect(term.stopped).toBe(false);
		expect(root.renders).toBeGreaterThan(whileSuspended); // resume re-rendered
		r.stop();
	});

	it("keys do not reach the root while suspended (no input handler)", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		r.suspend();
		await flush();
		term.send("x"); // suspended → not delivered
		expect(root.inputs).toEqual([]);
		r.resume();
		await flush();
		term.send("y"); // resumed → delivered
		expect(root.inputs).toEqual(["y"]);
		r.stop();
	});

	it("stop() after suspend() is permanent; resume() after stop() is a no-op", () => {
		const term = new FakeTerminal();
		const r = createDashboardRenderer({ root: new StubRoot(), terminal: term, refreshIntervalMs: 0 });
		r.start();
		r.suspend();
		expect(() => r.stop()).not.toThrow();
		expect(term.stopped).toBe(true);
		expect(() => r.resume()).not.toThrow();
		expect(term.stopped).toBe(true);
	});
});

describe("dashboard renderer — clear", () => {
	it("clear() forces a full screen clear + redraw", async () => {
		const term = new FakeTerminal();
		const r = createDashboardRenderer({ root: new StubRoot(), terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		term.writes.length = 0;
		r.clear();
		await flush();
		expect(term.output()).toContain("\x1b[2J");
		r.stop();
	});
});

describe("dashboard renderer — resize", () => {
	it("resize re-renders at the new width", async () => {
		const term = new FakeTerminal();
		const root = new StubRoot();
		const r = createDashboardRenderer({ root, terminal: term, refreshIntervalMs: 0 });
		r.start();
		await flush();
		term.resize(120, 40);
		await flush();
		expect(root.lastWidth).toBe(120);
		r.stop();
	});
});
