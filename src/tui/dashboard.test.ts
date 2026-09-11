import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import type { Settings } from "../config/settings.ts";
import { defaultVmSettings } from "../config/settings.ts";
import { ok, type Result } from "../tools/result.ts";
import type { VmBootGate } from "../vm/boot-backend.ts";
import type { VmStatus } from "../vm/service.ts";
import { DashboardStore } from "./dashboard/store.ts";
import {
	createSandboxActions,
	type DashboardDeps,
	readSerialLog,
	runDashboard,
	VM_IN_FLIGHT_HINT,
	VM_UNOWNED_HINT,
} from "./dashboard.ts";

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

const seed: Settings = {
	version: 1,
	channels: [],
	defaultChannel: null,
	mcp: { allowedClients: [] },
	vm: defaultVmSettings(),
};

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

// ---- the Sandbox actions (spec 28, box 28b) -------------------------------------

/** A vm-state line fixture — the 27h wire shape (mirrors the dashboard test files). */
function vmLine(sessionId: string | null): string {
	return JSON.stringify({ type: "vm-state", state: "ready", sessionId, phase: null, sshPort: null, error: null });
}

/** A scripted VmBootGate (the structural VmService alias — no real VM, no casts). */
function scriptedGate(over: { stop?: () => Promise<unknown>; start?: () => Promise<void> } = {}): VmBootGate {
	const status: VmStatus = {
		state: "ready",
		phase: "none",
		sessionId: "vm-test",
		sshPort: 42255,
		bootStartedAt: null,
		bootTimeoutMs: 60_000,
		readyAt: 1,
		error: null,
		relaunchUsed: false,
	};
	return {
		state: "ready",
		status: () => status,
		onTransition: () => () => {},
		start: over.start ?? (async () => {}),
		ensureReady: async () => ({ ok: false, message: "unused" }),
		stop: over.stop ?? (async () => ({ path: "powerdown", overlayRemoved: false })),
	};
}

describe("createSandboxActions — owned server", () => {
	it("stopSandbox calls the service's stop once", async () => {
		const calls: string[] = [];
		const gate = scriptedGate({
			stop: async () => {
				calls.push("stop");
				return { path: "powerdown", overlayRemoved: false };
			},
		});
		const actions = createSandboxActions({ vmService: () => gate, store: new DashboardStore() });
		expect(await actions.stopSandbox()).toEqual({ ok: true, value: undefined });
		expect(calls).toEqual(["stop"]);
	});

	it("restartSandbox stops then starts — in that order (the fresh boot per the persist rules)", async () => {
		const calls: string[] = [];
		const gate = scriptedGate({
			stop: async () => {
				calls.push("stop");
				return {};
			},
			start: async () => {
				calls.push("start");
			},
		});
		const actions = createSandboxActions({ vmService: () => gate, store: new DashboardStore() });
		expect(await actions.restartSandbox()).toEqual({ ok: true, value: undefined });
		expect(calls).toEqual(["stop", "start"]);
	});

	it("a second action while one is in flight errs inline and never reaches the service", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let stops = 0;
		const gate = scriptedGate({
			stop: async () => {
				stops += 1;
				await blocked;
				return {};
			},
		});
		const actions = createSandboxActions({ vmService: () => gate, store: new DashboardStore() });
		const first = actions.stopSandbox();
		const second = await actions.stopSandbox();
		expect(second).toEqual({ ok: false, error: new Error(VM_IN_FLIGHT_HINT) });
		expect(stops).toBe(1); // the second activation was gated before the service
		release();
		expect(await first).toEqual({ ok: true, value: undefined });
	});

	it("readSerial reads the latest vm-state line's session through the reader", async () => {
		const store = new DashboardStore();
		store.applyVmStateLine(vmLine("vm-fixture"));
		const reads: string[] = [];
		const actions = createSandboxActions({
			vmService: () => scriptedGate(),
			readSerial: async (id) => {
				reads.push(id);
				return ok({ content: "boot line\n", totalBytes: 10 });
			},
			store,
		});
		expect(await actions.readSerial()).toEqual({ ok: true, value: { content: "boot line\n", totalBytes: 10 } });
		expect(reads).toEqual(["vm-fixture"]);
	});

	it("no session id yet (no vm-state line) errs no-serial-yet; the reader is never called", async () => {
		let called = false;
		const actions = createSandboxActions({
			vmService: () => scriptedGate(),
			readSerial: async () => {
				called = true;
				return ok({ content: "", totalBytes: 0 });
			},
			store: new DashboardStore(),
		});
		expect(await actions.readSerial()).toEqual({ ok: false, error: new Error("no serial yet") });
		expect(called).toBe(false);
	});
});

describe("createSandboxActions — unowned server (the hint, exact)", () => {
	it("all three actions err with the unowned hint; no service is ever touched", async () => {
		let consulted = 0;
		let read = false;
		const actions = createSandboxActions({
			vmService: () => {
				consulted += 1;
				return null;
			},
			readSerial: async () => {
				read = true;
				return ok({ content: "", totalBytes: 0 });
			},
			store: new DashboardStore(),
		});
		expect(await actions.stopSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
		expect(await actions.restartSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
		expect(await actions.readSerial()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
		expect(consulted).toBe(3); // the gate was consulted; nothing behind it existed to touch
		expect(read).toBe(false); // the unowned gate precedes the serial read
	});

	it("an absent vmService dep is unowned too (today's child-process wiring)", async () => {
		const actions = createSandboxActions({ store: new DashboardStore() });
		expect(await actions.stopSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
	});
});

describe("readSerialLog — the default reader (temp HOME)", () => {
	it("reads <HOME>/.openhammer/vm/sessions/<id>/serial.log with the exact byte size", async () => {
		const home = await mkdtemp(join(tmpdir(), "oh-serial-"));
		try {
			const dir = join(home, ".openhammer", "vm", "sessions", "vm-fixture");
			await mkdir(dir, { recursive: true });
			const body = "SeaBIOS booting...\r\nomarchy login:\r\n";
			await writeFile(join(dir, "serial.log"), body, "utf8");
			const result = await readSerialLog("vm-fixture", home);
			expect(result).toEqual({ ok: true, value: { content: body, totalBytes: Buffer.byteLength(body, "utf8") } });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("a missing serial log errs with the no-serial-yet line", async () => {
		const home = await mkdtemp(join(tmpdir(), "oh-serial-"));
		try {
			expect(await readSerialLog("vm-absent", home)).toEqual({ ok: false, error: new Error("no serial yet") });
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});
