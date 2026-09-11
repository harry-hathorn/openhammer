import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { NO_GOLDEN_GUARD_MESSAGE } from "../config/sections.ts";
import { type ChannelEntry, defaultVmSettings, type Settings, type VmSettings } from "../config/settings.ts";
import { err, ok, type Result } from "../tools/result.ts";
import type { VmBootGate } from "../vm/boot-backend.ts";
import type { VmStatus } from "../vm/service.ts";
import { DashboardStore } from "./dashboard/store.ts";
import {
	createSandboxActions,
	createSettingsActions,
	type DashboardDeps,
	readSerialLog,
	runDashboard,
	VM_IN_FLIGHT_HINT,
	VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE,
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
	it("every Sandbox action errs with the unowned hint; no service is ever touched", async () => {
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
		expect(await actions.installSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
		expect(consulted).toBe(4); // the gate was consulted; nothing behind it existed to touch
		expect(read).toBe(false); // the unowned gate precedes the serial read
	});

	it("an absent vmService dep is unowned too (today's child-process wiring)", async () => {
		const actions = createSandboxActions({ store: new DashboardStore() });
		expect(await actions.stopSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
	});
});

describe("createSandboxActions — installSandbox (spec 28, box 28c)", () => {
	it("owned: the install seam runs to completion and reports the session dir; the log sink is a function", async () => {
		let sinkType = "none";
		const actions = createSandboxActions({
			vmService: () => scriptedGate(),
			store: new DashboardStore(),
			install: async (log) => {
				sinkType = typeof log;
				return { sessionDir: "/h/.openhammer/vm/sessions/build-1" };
			},
		});
		expect(await actions.installSandbox()).toEqual({
			ok: true,
			value: { sessionDir: "/h/.openhammer/vm/sessions/build-1" },
		});
		expect(sinkType).toBe("function");
	});

	it("unowned: the exact unowned hint — the install seam is never invoked (no local vm-tree writes)", async () => {
		let ran = false;
		const actions = createSandboxActions({
			store: new DashboardStore(),
			install: async () => {
				ran = true;
				return { sessionDir: "x" };
			},
		});
		expect(await actions.installSandbox()).toEqual({ ok: false, error: new Error(VM_UNOWNED_HINT) });
		expect(ran).toBe(false);
	});

	it("a second install while one is in flight errs inline and never reaches the seam", async () => {
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let runs = 0;
		const actions = createSandboxActions({
			vmService: () => scriptedGate(),
			store: new DashboardStore(),
			install: async () => {
				runs += 1;
				await blocked;
				return { sessionDir: "x" };
			},
		});
		const first = actions.installSandbox();
		const second = await actions.installSandbox();
		expect(second).toEqual({ ok: false, error: new Error(VM_IN_FLIGHT_HINT) });
		expect(runs).toBe(1);
		release();
		expect(await first).toEqual({ ok: true, value: { sessionDir: "x" } });
	});

	it("an install failure carries the runner's actionable error (evidence paths and all)", async () => {
		const actions = createSandboxActions({
			vmService: () => scriptedGate(),
			store: new DashboardStore(),
			install: async () => {
				throw new Error("vm install: no ssh gate within the 45 min budget");
			},
		});
		expect(await actions.installSandbox()).toEqual({
			ok: false,
			error: new Error("vm install: no ssh gate within the 45 min budget"),
		});
	});
});

// ---- the settings actions: mode-select guards + restart-to-apply (spec 28, box 28c) ----

/** A settings doc with a given vm mode and channel list (the guards' subject). */
function doc(mode: VmSettings["mode"], channels: ChannelEntry[] = []): Settings {
	return {
		version: 1,
		channels,
		defaultChannel: null,
		mcp: { allowedClients: [] },
		vm: { ...defaultVmSettings(), mode },
	};
}

/** A live ngrok channel (the row-1 predicate's hit). */
const LIVE: ChannelEntry[] = [{ id: "c1", kind: "ngrok", mode: "live", options: {} }];

describe("createSettingsActions — the mode-select guards + restart-to-apply (spec 28, box 28c)", () => {
	/** The harness: recorder confirm/persist/restart, a scripted wizard, a real DashboardStore. */
	function harness(opts: {
		before: Settings;
		wizard?: Result<Settings, Error> | null;
		wizardThrows?: Error;
		confirmResult?: boolean | null;
		restart?: () => Promise<Result<void, Error>>;
	}) {
		const calls: string[] = [];
		const persisted: Settings[] = [];
		const store = new DashboardStore({}, opts.before);
		const core = createSettingsActions({
			persist: (s) => persisted.push(s),
			store,
			confirm: async (message) => {
				calls.push(`confirm:${message}`);
				return opts.confirmResult ?? true;
			},
			runSectionWizard: async (_before, sections) => {
				calls.push(`wizard:${sections === undefined ? "picker" : sections.map((s) => s.id).join(",")}`);
				if (opts.wizardThrows !== undefined) {
					throw opts.wizardThrows;
				}
				return opts.wizard ?? null;
			},
			restartIfDefaultChanged: async (before, after) => {
				if (before.defaultChannel !== after.defaultChannel) calls.push("channelRestart");
			},
			restartServer: opts.restart,
		});
		return { calls, persisted, store, core };
	}

	it("row 1: vm → off with a live channel asks the exact confirm; declining keeps the mode (nothing persisted)", async () => {
		const before = doc("vm", LIVE);
		const after: Settings = { ...before, vm: { ...before.vm, mode: "off" } };
		const { calls, persisted, core } = harness({ before, wizard: ok(after), confirmResult: false });
		const result = await core.editSettings();
		expect(result).toBeNull();
		expect(calls).toContain(`confirm:${VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE}`);
		expect(persisted).toEqual([]); // decline keeps the mode — nothing written, nothing restarted
	});

	it("row 1: agent → off gets the same warning", async () => {
		const before = doc("agent", LIVE);
		const after: Settings = { ...before, vm: { ...before.vm, mode: "off" } };
		const { calls, core } = harness({ before, wizard: ok(after), confirmResult: false });
		await core.editSettings();
		expect(calls.some((c) => c.startsWith(`confirm:${VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE}`))).toBe(true);
	});

	it("row 1: accepting persists the doc and adopts it into the store", async () => {
		const before = doc("vm", LIVE);
		const after: Settings = { ...before, vm: { ...before.vm, mode: "off" } };
		const { calls, persisted, store, core } = harness({ before, wizard: ok(after), confirmResult: true });
		const result = await core.editSettings();
		expect(result).toEqual({ ok: true, value: after });
		expect(calls.some((c) => c.startsWith("confirm:"))).toBe(true);
		expect(persisted).toEqual([after]);
		expect(store.settings).toEqual(after);
	});

	it("row 1: vm → off WITHOUT a public channel never confirms", async () => {
		const before = doc("vm");
		const after: Settings = { ...before, vm: { ...before.vm, mode: "off" } };
		const { calls, persisted, core } = harness({ before, wizard: ok(after) });
		const result = await core.editSettings();
		expect(result?.ok).toBe(true);
		expect(calls.some((c) => c.startsWith("confirm:"))).toBe(false);
		expect(persisted).toEqual([after]);
	});

	it("row 1: off → vm never confirms (containment only increases) — even with a live channel", async () => {
		const before = doc("off", LIVE);
		const after: Settings = { ...before, vm: { ...before.vm, mode: "vm" } };
		const { calls, core } = harness({ before, wizard: ok(after) });
		await core.editSettings();
		expect(calls.some((c) => c.startsWith("confirm:"))).toBe(false);
	});

	it("row 1: a static LOOPBACK channel does not trigger the warning (localhost-only doesn't count)", async () => {
		const loopback: ChannelEntry[] = [
			{ id: "s", kind: "static-url", mode: "static", options: { publicUrl: "http://127.0.0.1:3000" } },
		];
		const before = doc("vm", loopback);
		const after: Settings = { ...before, vm: { ...before.vm, mode: "off" } };
		const { calls, core } = harness({ before, wizard: ok(after) });
		await core.editSettings();
		expect(calls.some((c) => c.startsWith("confirm:"))).toBe(false);
	});

	it("row 2: the no-golden guard's write throw propagates (the root flashes it); nothing persists", async () => {
		const { persisted, core } = harness({
			before: doc("off"),
			wizardThrows: new Error(NO_GOLDEN_GUARD_MESSAGE),
		});
		await expect(core.editSettings()).rejects.toThrow(NO_GOLDEN_GUARD_MESSAGE);
		expect(persisted).toEqual([]);
	});

	it("row 3 owned: a vm write invokes the restart seam once and leaves the change applied (pending false)", async () => {
		const before = doc("off");
		const after: Settings = { ...before, vm: { ...before.vm, mode: "vm" } };
		let restarts = 0;
		const { store, core } = harness({
			before,
			wizard: ok(after),
			restart: async () => {
				restarts += 1;
				return ok(undefined);
			},
		});
		const result = await core.editSettings();
		expect(result?.ok).toBe(true);
		expect(restarts).toBe(1);
		expect(store.vmApplyPending).toBe(false);
	});

	it("row 3: a failed restart marks the change pending (the hint, not a dead silence)", async () => {
		const before = doc("off");
		const after: Settings = { ...before, vm: { ...before.vm, mode: "vm" } };
		const { store, core } = harness({
			before,
			wizard: ok(after),
			restart: async () => err(new Error("cannot restart a server the dashboard did not start")),
		});
		await core.editSettings();
		expect(store.vmApplyPending).toBe(true);
	});

	it("row 3 unowned: no restart seam → the write persists and the pending flag carries the hint", async () => {
		const before = doc("off");
		const after: Settings = { ...before, vm: { ...before.vm, mode: "agent" } };
		const { persisted, store, core } = harness({ before, wizard: ok(after) });
		const result = await core.editSettings();
		expect(result?.ok).toBe(true);
		expect(persisted).toEqual([after]); // the write DID land — the hint is about applying, not saving
		expect(store.vmApplyPending).toBe(true);
	});

	it("row 3: a write that does not touch the vm section never restarts and never pends", async () => {
		const before = doc("off");
		const after: Settings = { ...before, mcp: { allowedClients: ["claude-code"] } };
		let restarts = 0;
		const { store, core } = harness({
			before,
			wizard: ok(after),
			restart: async () => {
				restarts += 1;
				return ok(undefined);
			},
		});
		await core.editSettings();
		expect(restarts).toBe(0);
		expect(store.vmApplyPending).toBe(false);
	});

	it("configureVm drives the SAME core with the vm section preselected (the Configure jump)", async () => {
		const before = doc("off");
		const after: Settings = { ...before, vm: { ...before.vm, mode: "vm" } };
		const { calls, core } = harness({ before, wizard: ok(after) });
		await core.configureVm();
		expect(calls).toContain("wizard:vm");
	});

	it("editSettings drives the section picker (no preselection)", async () => {
		const { calls, core } = harness({ before: doc("off"), wizard: null });
		await core.editSettings();
		expect(calls).toContain("wizard:picker");
	});

	it("a wizard cancel passes through as null (no confirm, no persist)", async () => {
		const { calls, persisted, core } = harness({ before: doc("off"), wizard: null });
		expect(await core.editSettings()).toBeNull();
		expect(calls.some((c) => c.startsWith("confirm:"))).toBe(false);
		expect(persisted).toEqual([]);
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
