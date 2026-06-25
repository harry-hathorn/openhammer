import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.ts";
import { ok, type Result } from "../tools/result.ts";
import { type DashboardDeps, runDashboard } from "./dashboard.ts";

/** A fake terminal: records writes + lets the test inject keystrokes via `send`. */
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
	send(data: string): void {
		this.inputHandler?.(data);
	}
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}
}

const seed: Settings = { version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } };

/** Build deps with a fake terminal + no-op persist + the given seams. */
function deps(opts: {
	terminal: FakeTerminal;
	actions?: DashboardDeps["actions"];
	subscribe?: DashboardDeps["subscribe"];
	onQuit?: () => void;
	persist?: (s: Settings) => void;
	doctorRunner?: () => Promise<string>;
}): DashboardDeps {
	return {
		settings: seed,
		terminal: opts.terminal,
		refreshIntervalMs: 0,
		persist: opts.persist ?? (() => {}),
		actions: opts.actions,
		subscribe: opts.subscribe,
		onQuit: opts.onQuit,
		doctorRunner: opts.doctorRunner,
	};
}

/** Schedule a sequence of keys (sent 30ms apart) on the terminal. */
function scheduleKeys(terminal: FakeTerminal, keys: string[]): void {
	for (let i = 0; i < keys.length; i++) {
		const k = keys[i] as string;
		setTimeout(() => terminal.send(k), 30 * (i + 1));
	}
}

describe("runDashboard — lifecycle", () => {
	it("enters raw mode on start and restores it on quit", async () => {
		const term = new FakeTerminal();
		scheduleKeys(term, ["q"]);
		await runDashboard(deps({ terminal: term }));
		expect(term.started).toBe(false); // quit stopped the renderer
		expect(term.stopped).toBe(true);
	});

	it("Ctrl-C resolves the dashboard too", async () => {
		const term = new FakeTerminal();
		scheduleKeys(term, ["\x03"]);
		await runDashboard(deps({ terminal: term }));
		expect(term.stopped).toBe(true);
	});
});

describe("runDashboard — subscribe wiring", () => {
	it("connects the live feed (subscribe is called on start)", async () => {
		const term = new FakeTerminal();
		let subscribed = false;
		const subscribe = (): (() => void) => {
			subscribed = true;
			return () => {};
		};
		scheduleKeys(term, ["q"]);
		await runDashboard(deps({ terminal: term, subscribe }));
		expect(subscribed).toBe(true);
	});
});

describe("runDashboard — quit", () => {
	it("q resolves the dashboard and runs onQuit", async () => {
		const term = new FakeTerminal();
		let quit = false;
		scheduleKeys(term, ["q"]);
		await runDashboard(deps({ terminal: term, onQuit: () => (quit = true) }));
		expect(quit).toBe(true);
		expect(term.stopped).toBe(true);
	});
});

describe("runDashboard — action wiring", () => {
	it("the root dispatches to the wired addChannel action (menu → Channels → Add)", async () => {
		const term = new FakeTerminal();
		let addCalled = false;
		const actions = {
			addChannel: async () => {
				addCalled = true;
				return ok({ version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } }) as Result<
					Settings,
					Error
				>;
			},
		};
		// menu -> Channels (down x1) -> enter -> down (to Add row) -> enter (addChannel) -> q
		scheduleKeys(term, ["\x1b[B", "\r", "\x1b[B", "\r", "q"]);
		await runDashboard(deps({ terminal: term, actions }));
		await new Promise((r) => setTimeout(r, 20));
		expect(addCalled).toBe(true);
	});
});

describe("runDashboard — doctor wiring", () => {
	it("runDoctor wraps the injected doctorRunner", async () => {
		const term = new FakeTerminal();
		let doctorCalled = false;
		const doctorRunner = async (): Promise<string> => {
			doctorCalled = true;
			return "ok-report";
		};
		// menu -> Doctor (down x5) -> enter -> enter (Run doctor) -> q
		const downs = Array.from({ length: 5 }, () => "\x1b[B");
		scheduleKeys(term, [...downs, "\r", "\r", "q"]);
		await runDashboard(deps({ terminal: term, actions: {}, doctorRunner }));
		await new Promise((r) => setTimeout(r, 20));
		expect(doctorCalled).toBe(true);
	});
});
