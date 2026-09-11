import { describe, expect, it } from "vitest";
import type { IssuedClient } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { defaultVmSettings } from "../../config/settings.ts";
import type { VmStateLine } from "../../observability/status-socket.ts";
import { err, ok, type Result } from "../../tools/result.ts";
import { defaultGuestConfig, type GuestConfig } from "../../vm/provision/guest-config.ts";
import { activeSessionRefusal } from "../../vm/provision/install.ts";
import { createSandboxActions, VM_UNOWNED_HINT } from "../dashboard.ts";
import { createStyle } from "../style.ts";
import { type DashboardActions, DashboardRoot, type InstallOutcome } from "./root.ts";
import { DashboardStore } from "./store.ts";
import { type SerialSource, VM_APPLY_HINT } from "./view.ts";

// Raw pi-tui key sequences (see packages/tui/src/keys.ts).
const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESC = "\x1b";

const ch = (over: Partial<ChannelEntry> = {}): ChannelEntry => ({
	id: "c1",
	kind: "ngrok",
	mode: "live",
	options: {},
	...over,
});

/** A fake actions bundle that records calls and returns canned results. */
function fakeActions(log: string[]): DashboardActions {
	return {
		addChannel: async () => {
			log.push("addChannel");
			return ok(seed()) as Result<Settings, Error>;
		},
		editSettings: async () => {
			log.push("editSettings");
			return ok(seed()) as Result<Settings, Error>;
		},
		issueClient: async () => {
			log.push("issueClient");
			return ok({ clientId: "oh_new", plaintextSecret: "sec-ret" } as IssuedClient) as Result<IssuedClient, Error>;
		},
		removeChannel: async (id: string) => {
			log.push(`removeChannel:${id}`);
			return ok(seed()) as Result<Settings, Error>;
		},
		useChannel: async (id: string) => {
			log.push(`useChannel:${id}`);
			return ok(seed()) as Result<Settings, Error>;
		},
		removeClient: async (id: string) => {
			log.push(`removeClient:${id}`);
			return ok(undefined) as Result<void, Error>;
		},
		setLogin: async () => {
			log.push("setLogin");
			return ok(undefined) as Result<void, Error>;
		},
		runDoctor: async () => {
			log.push("runDoctor");
			return "doctor-report-line";
		},
		stopSandbox: async () => {
			log.push("stopSandbox");
			return ok(undefined) as Result<void, Error>;
		},
		restartSandbox: async () => {
			log.push("restartSandbox");
			return ok(undefined) as Result<void, Error>;
		},
		readSerial: async () => {
			log.push("readSerial");
			return ok({ content: "boot line one\nboot line two\n", totalBytes: 28 }) as Result<SerialSource, Error>;
		},
		configureVm: async () => {
			log.push("configureVm");
			return ok(seed()) as Result<Settings, Error>;
		},
		guestSetup: async () => {
			log.push("guestSetup");
			return ok(defaultGuestConfig()) as Result<GuestConfig, Error>;
		},
		installSandbox: async () => {
			log.push("installSandbox");
			return ok({ sessionDir: "/h/.openhammer/vm/sessions/build-1" }) as Result<InstallOutcome, Error>;
		},
		quit: () => log.push("quit"),
	};
}

function seed(): Settings {
	return { version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] }, vm: defaultVmSettings() };
}

/** A root seeded with one channel + one OAuth client, identity style. */
function rooted(log: string[]): DashboardRoot {
	const store = new DashboardStore(
		{},
		{
			version: 1,
			channels: [ch({ id: "ch1", label: "tun" })],
			defaultChannel: null,
			mcp: { allowedClients: [] },
			vm: defaultVmSettings(),
		},
	);
	store.setOauthClients([{ clientId: "oh_1", label: "ci", createdAt: "now", grantTypes: ["client_credentials"] }]);
	return new DashboardRoot({ store, style: createStyle(false), actions: fakeActions(log) });
}

describe("DashboardRoot — menu navigation", () => {
	it("starts on the menu at the first row", () => {
		const root = rooted([]);
		expect(root.screen.kind).toBe("menu");
		expect(root.focus).toBe(0);
	});

	it("↓ moves the focus; enter opens the focused section; esc restores the menu cursor", () => {
		const root = rooted([]);
		root.handleInput(DOWN); // Status -> Channels
		expect(root.focus).toBe(1);
		root.handleInput(ENTER); // open Channels
		expect(root.screen).toEqual({ kind: "section", section: "channels" });
		expect(root.focus).toBe(0);
		root.handleInput(ESC); // back to menu
		expect(root.screen.kind).toBe("menu");
		expect(root.focus).toBe(1); // restored
	});

	it("↓ clamps at the last row; ↑ clamps at 0", () => {
		const root = rooted([]);
		for (let i = 0; i < 20; i++) root.handleInput(DOWN);
		expect(root.focus).toBeGreaterThan(0);
		for (let i = 0; i < 20; i++) root.handleInput(UP);
		expect(root.focus).toBe(0);
	});
});

describe("DashboardRoot — quit", () => {
	it("q calls actions.quit()", () => {
		const log: string[] = [];
		rooted(log).handleInput("q");
		expect(log).toEqual(["quit"]);
	});

	it("Ctrl-C calls actions.quit()", () => {
		const log: string[] = [];
		rooted(log).handleInput("\x03");
		expect(log).toEqual(["quit"]);
	});

	it("Esc at the menu calls actions.quit() (backs out of the top level)", () => {
		const log: string[] = [];
		rooted(log).handleInput(ESC);
		expect(log).toEqual(["quit"]);
	});
});

describe("DashboardRoot — channels screen", () => {
	it("enter on a channel opens its detail; the add row runs addChannel", () => {
		const log: string[] = [];
		const root = rooted(log);
		root.handleInput(DOWN); // menu -> Channels
		root.handleInput(ENTER); // -> channels section (focus 0 = the channel)
		root.handleInput(ENTER); // channels focus 0 -> channel-detail
		expect(root.screen).toEqual({ kind: "channel-detail", id: "ch1" });

		// Back to channels, focus the add row (last), activate.
		root.handleInput(ESC); // detail -> channels
		root.handleInput(DOWN); // channels: [channel, add] -> focus 1 (add)
		root.handleInput(ENTER); // add
		expect(log).toContain("addChannel");
	});
});

describe("DashboardRoot — channel detail actions", () => {
	it("Use as default / Remove / Back dispatch the right action", async () => {
		const log: string[] = [];
		const root = rooted(log);
		root.handleInput(DOWN); // menu -> Channels
		root.handleInput(ENTER); // -> channels section
		root.handleInput(ENTER); // channels focus 0 -> channel-detail (not default -> [Use, Remove, Back])
		root.handleInput(ENTER); // focus 0 = Use
		await flushActions();
		expect(log).toContain("useChannel:ch1");

		// focus 1 = Remove
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		await flushActions();
		expect(log).toContain("removeChannel:ch1");
		expect(root.screen).toEqual({ kind: "section", section: "channels" }); // removed -> back
	});
});

describe("DashboardRoot — clients screen", () => {
	it("the Set-login row runs setLogin", async () => {
		const log: string[] = [];
		const root = rooted(log);
		// menu -> Clients (index 2)
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		// clients focus 0 = "Set operator login…" -> activate
		root.handleInput(ENTER);
		await flushActions();
		expect(log).toContain("setLogin");
	});

	it("issue row runs issueClient and shows the one-time secret reveal", async () => {
		const log: string[] = [];
		const root = rooted(log);
		// menu -> Clients (index 2)
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "clients" });
		// clients: [Set-login, client, issue] -> focus the issue row (2)
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		await flushActions();
		expect(log).toContain("issueClient");
		// the reveal is rendered on the clients screen header
		const lines = root.render(80);
		expect(lines.some((l) => l.includes("sec-ret"))).toBe(true);
	});

	it("enter on a client opens its detail; remove dispatches removeClient", async () => {
		const log: string[] = [];
		const root = rooted(log);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // clients (focus 0 = Set-login)
		root.handleInput(DOWN); // -> focus 1 = client
		root.handleInput(ENTER); // client -> detail
		expect(root.screen).toEqual({ kind: "client-detail", id: "oh_1" });
		root.handleInput(ENTER); // focus 0 = Remove
		await flushActions();
		expect(log).toContain("removeClient:oh_1");
	});
});

describe("DashboardRoot — settings + doctor", () => {
	it("settings Edit runs editSettings", async () => {
		const log: string[] = [];
		const root = rooted(log);
		// menu -> Settings (index 4)
		for (let i = 0; i < 4; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		root.handleInput(ENTER); // focus 0 = Edit settings…
		await flushActions();
		expect(log).toContain("editSettings");
	});

	it("doctor Run runs runDoctor and shows the report", async () => {
		const log: string[] = [];
		const root = rooted(log);
		// menu -> Doctor (index 5)
		for (let i = 0; i < 5; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		root.handleInput(ENTER); // Run doctor
		await flushActions();
		expect(log).toContain("runDoctor");
		expect(root.render(80).some((l) => l.includes("doctor-report-line"))).toBe(true);
	});
});

describe("DashboardRoot — render", () => {
	it("renders the title, the menu rows, and the footer hint", () => {
		const root = rooted([]);
		const lines = root.render(80);
		expect(lines.some((l) => l === "OpenHammer")).toBe(true); // titleLine (identity style)
		expect(lines.some((l) => l.includes("████████"))).toBe(true); // banner is in the menu frame
		expect(lines.some((l) => l.includes("Status"))).toBe(true);
		expect(lines.some((l) => l.includes("Channels"))).toBe(true);
		expect(lines.at(-1)).toMatch(/move|quit|esc/); // footer hint
	});
});

/** Let any fire-and-forget `activate()` microtasks settle before asserting on action side-effects. */
async function flushActions(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("DashboardRoot — hjkl navigation (nvim-style)", () => {
	it("j/k move the focus like ↓/↑", () => {
		const root = rooted([]);
		root.handleInput("j"); // down
		expect(root.focus).toBe(1);
		root.handleInput("k"); // up
		expect(root.focus).toBe(0);
	});

	it("l drills in like Enter; h backs out like Esc (but h at the menu is a no-op)", () => {
		const root = rooted([]);
		root.handleInput("j"); // -> Channels
		root.handleInput("l"); // open Channels (l == Enter)
		expect(root.screen).toEqual({ kind: "section", section: "channels" });
		root.handleInput("h"); // back (h == Esc/←)
		expect(root.screen.kind).toBe("menu");

		// h at the menu does NOT quit (no accidental exit); q/Esc still quit.
		const log: string[] = [];
		const root2 = rooted(log);
		root2.handleInput("h");
		expect(root2.screen.kind).toBe("menu"); // still on the menu
		expect(log).not.toContain("quit");
	});
});

/** A root whose store is in the given vm mode; the vm case has a ready line + a
 *  hermetic guest root (env-injected — the store never reads the real guest doc).
 *  `actionsOver` swaps in real action implementations over the same store (e.g.
 *  the unowned createSandboxActions defaults) on top of the recording fakes. */
function vmRooted(
	log: string[],
	mode: "off" | "vm",
	actionsOver?: (store: DashboardStore) => Partial<DashboardActions>,
	opts: { hasGolden?: boolean; vmState?: VmStateLine["state"] | null } = {},
): DashboardRoot {
	const store = new DashboardStore(
		{ env: { MCP_ROOT_DIR: "/srv/guest-work" }, goldenExists: () => opts.hasGolden ?? true },
		{
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: [] },
			vm: { ...defaultVmSettings(), mode },
		},
	);
	// The held vm-state line defaults to `ready` (the live-sandbox fixture the earlier
	// boxes' tests grew up with); `vmState` overrides it — `null` holds NO line. Box 28d
	// reads it through the store (vmSessionActive) to gate the Install row.
	const line = opts.vmState ?? (mode === "vm" ? "ready" : null);
	if (mode === "vm" && line !== null) {
		const ready = line === "ready";
		store.applyVmStateLine(
			JSON.stringify({
				type: "vm-state",
				state: line,
				sessionId: ready ? "vm-20260911T101112Z-ab" : null,
				phase: line === "booting" ? "prepare" : null,
				sshPort: ready ? 42255 : null,
				error: null,
			}),
		);
	}
	const actions: DashboardActions = { ...fakeActions(log), ...(actionsOver?.(store) ?? {}) };
	return new DashboardRoot({ store, style: createStyle(false), actions });
}

describe("DashboardRoot — Sandbox screen (spec 28)", () => {
	it("the Sandbox row drills into the state screen (state row + guest root + the 28b action rows)", async () => {
		const log: string[] = [];
		const root = vmRooted(log, "vm");
		for (let i = 0; i < 6; i++) root.handleInput(DOWN); // -> Sandbox (index 6, after Doctor)
		expect(root.focus).toBe(6);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		await flushActions();
		const lines = root.render(80);
		expect(lines.some((l) => l.includes("Sandbox  ready · session vm-20260911T101112Z-ab · ssh :42255"))).toBe(true);
		expect(lines.some((l) => l.includes("guest root: /srv/guest-work"))).toBe(true);
	});

	it("off mode + no vm-state line: focus 6 is Quit, not a hidden Sandbox row", async () => {
		const log: string[] = [];
		const root = vmRooted(log, "off");
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		await flushActions();
		expect(log).toContain("quit"); // the row after Doctor IS Quit — nothing new for an off user
	});
});

describe("DashboardRoot — Sandbox actions (spec 28, box 28b)", () => {
	/** Drill into the vm-mode Sandbox screen (menu → 6 downs → enter). */
	async function sandboxed(
		log: string[],
		actionsOver?: (store: DashboardStore) => Partial<DashboardActions>,
		opts: { hasGolden?: boolean; vmState?: VmStateLine["state"] | null } = {},
	): Promise<DashboardRoot> {
		const root = vmRooted(log, "vm", actionsOver, opts);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		return root;
	}

	it("the screen lists Stop / Restart / Configure / Guest setup / Serial tail / Back — Install only with no golden", async () => {
		// Rendered wide (200): renderList truncates each row to the width, and the stop
		// subtitle only fits its full semantics text on a wide terminal — at 80 the
		// first clause ("power down now — the boot-scoped mode re-boots…") is what shows.
		const lines = (await sandboxed([])).render(200);
		expect(lines.some((l) => l.includes("Stop sandbox…"))).toBe(true);
		expect(lines.some((l) => l.includes("Restart sandbox…"))).toBe(true);
		expect(lines.some((l) => l.includes("Configure…"))).toBe(true);
		expect(lines.some((l) => l.includes("Guest setup…"))).toBe(true);
		expect(lines.some((l) => l.includes("Serial tail"))).toBe(true);
		expect(lines.some((l) => l.includes("Back"))).toBe(true);
		expect(lines.some((l) => l.includes("re-boots the sandbox on the next server start"))).toBe(true);
		expect(lines.some((l) => l.includes("lasting stop: mode off + restart"))).toBe(true);
		expect(lines.some((l) => l.includes("Install sandbox…"))).toBe(false); // a golden exists — HIDDEN, not disabled

		const goldenless = (await sandboxed([], undefined, { hasGolden: false, vmState: "stopped" })).render(200);
		expect(goldenless.some((l) => l.includes("Install sandbox…"))).toBe(true);
	});

	it("enter on Stop runs stopSandbox once and flashes the lasting-stop semantics (matrix row 4)", async () => {
		const log: string[] = [];
		const root = await sandboxed(log);
		root.handleInput(ENTER); // focus 0 = Stop
		await flushActions();
		expect(log).toEqual(["stopSandbox"]);
		expect(root.render(80).some((l) => l.includes("lasting stop: mode off + restart"))).toBe(true);
	});

	it("enter on Restart runs restartSandbox (the stop→start order is pinned at the action level)", async () => {
		const log: string[] = [];
		const root = await sandboxed(log);
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		await flushActions();
		expect(log).toEqual(["restartSandbox"]);
		expect(root.render(80).some((l) => l.includes("fresh boot"))).toBe(true);
	});

	it("Serial tail opens the read-only drill-in (note + tail lines); Back returns to the sandbox", async () => {
		const log: string[] = [];
		const root = await sandboxed(log);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 4 = Serial tail (Configure at 2 + Guest setup at 3, boxes 28c/28e)
		await flushActions();
		expect(log).toEqual(["readSerial"]);
		expect(root.screen).toEqual({ kind: "serial" });
		const lines = root.render(80);
		expect(lines.some((l) => l.includes("serial.log — 2 lines · 28B total · read-only snapshot (not live)"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("boot line one"))).toBe(true);
		expect(lines.some((l) => l.includes("boot line two"))).toBe(true);
		root.handleInput(ESC);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
	});

	it("a failed serial read flashes inline (the no-serial-yet case) and stays on the sandbox screen", async () => {
		const log: string[] = [];
		const root = await sandboxed(log, () => ({
			readSerial: async () => err(new Error("no serial yet")) as Result<SerialSource, Error>,
		}));
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 4 = Serial tail
		await flushActions();
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		expect(root.render(80).some((l) => l.includes("no serial yet"))).toBe(true);
	});

	it("the REAL unowned actions (no vmService dep) surface the exact hint — no fake action fires", async () => {
		const log: string[] = [];
		const root = await sandboxed(log, (store) => createSandboxActions({ store }));
		root.handleInput(ENTER); // Stop
		await flushActions();
		expect(log).toEqual([]); // the fake never ran — the wired default gated first
		expect(root.render(80).some((l) => l.includes(VM_UNOWNED_HINT))).toBe(true);
	});
});

describe("DashboardRoot — Configure, Install, and the apply-on-restart affordance (spec 28, box 28c)", () => {
	/** Drill into the vm-mode Sandbox screen (menu → 6 downs → enter) — the box-28b helper, golden-aware. */
	async function sandboxed(
		log: string[],
		actionsOver?: (store: DashboardStore) => Partial<DashboardActions>,
		opts: { hasGolden?: boolean; vmState?: VmStateLine["state"] | null } = {},
	): Promise<DashboardRoot> {
		const root = vmRooted(log, "vm", actionsOver, opts);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		return root;
	}

	it("enter on Configure runs configureVm and flashes the settings success", async () => {
		const log: string[] = [];
		const root = await sandboxed(log);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 2 = Configure
		await flushActions();
		expect(log).toEqual(["configureVm"]);
		expect(root.render(80).some((l) => l.includes("Settings updated."))).toBe(true);
	});

	it("enter on Install (no golden) runs installSandbox and flashes the completion + the onboarding next step", async () => {
		const log: string[] = [];
		const root = await sandboxed(
			log,
			() => ({
				installSandbox: async () =>
					ok({ sessionDir: "/h/.openhammer/vm/sessions/build-9" }) as Result<InstallOutcome, Error>,
			}),
			{ hasGolden: false, vmState: "stopped" }, // no active session — the row-5 exclusion must not fire
		);
		for (let i = 0; i < 5; i++) root.handleInput(DOWN); // focus 5 = Install (no golden — the row exists; Guest setup joined at 3, box 28e)
		root.handleInput(ENTER);
		await flushActions();
		const lines = root.render(80);
		expect(lines.some((l) => l.includes("Install complete — session /h/.openhammer/vm/sessions/build-9"))).toBe(true);
		expect(lines.some((l) => l.includes("Next: Configure → set the boot mode, then restart"))).toBe(true);
	});

	it("a failed install flashes the runner's actionable error inline", async () => {
		const log: string[] = [];
		const root = await sandboxed(
			log,
			() => ({
				installSandbox: async () => err(new Error("vm install: gate failed")) as Result<InstallOutcome, Error>,
			}),
			{ hasGolden: false, vmState: "stopped" }, // no active session — the row-5 exclusion must not fire
		);
		for (let i = 0; i < 5; i++) root.handleInput(DOWN); // focus 5 = Install
		root.handleInput(ENTER);
		await flushActions();
		expect(root.render(80).some((l) => l.includes("vm install: gate failed"))).toBe(true);
	});

	it("a vm write left unapplied flashes the apply-on-restart hint instead of the generic success (row 3)", async () => {
		const log: string[] = [];
		const root = vmRooted(log, "vm", (store) => ({
			editSettings: async () => {
				// The write must DIFFER from the store's vm section (memory 4096 → 8192) —
				// runAction scopes the hint to writes that actually touched vm fields.
				const next: Settings = { ...seed(), vm: { ...defaultVmSettings(), mode: "vm", memoryMb: 8192 } };
				store.setSettings(next);
				store.setVmApplyPending(true);
				return ok(next) as Result<Settings, Error>;
			},
		}));
		for (let i = 0; i < 4; i++) root.handleInput(DOWN); // -> Settings
		root.handleInput(ENTER);
		root.handleInput(ENTER); // Edit settings…
		await flushActions();
		expect(root.render(80).some((l) => l.includes(VM_APPLY_HINT))).toBe(true);
	});

	it("a vm write applied live flashes the generic success (no stale hint)", async () => {
		const log: string[] = [];
		const root = vmRooted(log, "vm", (store) => ({
			editSettings: async () => {
				const next: Settings = { ...seed(), vm: { ...defaultVmSettings(), mode: "vm", memoryMb: 8192 } };
				store.setSettings(next);
				store.setVmApplyPending(false);
				return ok(next) as Result<Settings, Error>;
			},
		}));
		for (let i = 0; i < 4; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		root.handleInput(ENTER);
		await flushActions();
		expect(root.render(80).some((l) => l.includes("Settings updated."))).toBe(true);
	});

	it("a pending vm change renders the apply-on-restart note on the Sandbox header (the row-3 affordance)", async () => {
		const log: string[] = [];
		let storeRef: DashboardStore | undefined;
		const root = vmRooted(log, "vm", (store) => {
			storeRef = store;
			return {};
		});
		storeRef?.setVmApplyPending(true);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER); // -> Sandbox
		await flushActions();
		expect(root.render(80).some((l) => l.includes(`note: ${VM_APPLY_HINT}`))).toBe(true);
	});
});

describe("DashboardRoot — Guest setup entry (spec 28, box 28e)", () => {
	/** Drill into the vm-mode Sandbox screen (menu → 6 downs → enter) — the per-box helper. */
	async function sandboxed(
		log: string[],
		actionsOver?: (store: DashboardStore) => Partial<DashboardActions>,
	): Promise<DashboardRoot> {
		const root = vmRooted(log, "vm", actionsOver);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		return root;
	}

	it("enter on Guest setup runs guestSetup and flashes the applies-to-next-install line", async () => {
		const log: string[] = [];
		const root = await sandboxed(log);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 3 = Guest setup (beside Configure at 2)
		await flushActions();
		expect(log).toEqual(["guestSetup"]);
		expect(root.render(80).some((l) => l.includes("Guest setup saved — applies to the next `vm install`."))).toBe(
			true,
		);
	});

	it("a failed guest setup flashes the wizard's err inline and stays on the sandbox screen", async () => {
		const log: string[] = [];
		const root = await sandboxed(log, () => ({
			// The override replaces the logging fake, so it logs the call itself.
			guestSetup: async () => {
				log.push("guestSetup");
				return err(new Error('hostname "my host" is not a valid host label (letters, digits, hyphens)')) as Result<
					GuestConfig,
					Error
				>;
			},
		}));
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 3 = Guest setup
		await flushActions();
		expect(log).toEqual(["guestSetup"]);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		expect(
			root
				.render(80)
				.some((l) => l.includes('hostname "my host" is not a valid host label (letters, digits, hyphens)')),
		).toBe(true);
	});

	it("a cancelled/declined guest setup (null) is silent — the cancelled-modal idiom", async () => {
		const log: string[] = [];
		const root = await sandboxed(log, () => ({
			// The override replaces the logging fake, so it logs the call itself.
			guestSetup: async () => {
				log.push("guestSetup");
				return null;
			},
		}));
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER); // focus 3 = Guest setup
		await flushActions();
		expect(log).toEqual(["guestSetup"]);
		expect(root.render(80).some((l) => l.includes("Guest setup saved"))).toBe(false); // no flash
	});
});

describe("DashboardRoot — Install × active session (spec 28, matrix row 5, box 28d)", () => {
	/** Drill into the vm-mode Sandbox screen (menu → 6 downs → enter) — golden/session-aware. */
	async function sandboxed(
		log: string[],
		actionsOver?: (store: DashboardStore) => Partial<DashboardActions>,
		opts: { hasGolden?: boolean; vmState?: VmStateLine["state"] | null } = {},
	): Promise<DashboardRoot> {
		const root = vmRooted(log, "vm", actionsOver, opts);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		return root;
	}

	it("a ready session HIDES the Install row even with no golden (never an offered action that can't run)", async () => {
		const lines = (await sandboxed([], undefined, { hasGolden: false })).render(200); // vm mode holds a ready line
		expect(lines.some((l) => l.includes("Install sandbox…"))).toBe(false);
		expect(lines.some((l) => l.includes("Back"))).toBe(true); // the list still ends at Back
	});

	it("a booting session hides it too; once the session stops, the row is shown again", async () => {
		const log: string[] = [];
		let storeRef: DashboardStore | undefined;
		const root = await sandboxed(
			log,
			(store) => {
				storeRef = store;
				return {};
			},
			{ hasGolden: false, vmState: "booting" },
		);
		expect(root.render(200).some((l) => l.includes("Install sandbox…"))).toBe(false);
		storeRef?.applyVmStateLine(
			JSON.stringify({
				type: "vm-state",
				state: "stopped",
				sessionId: null,
				phase: null,
				sshPort: null,
				error: null,
			}),
		);
		expect(root.render(200).some((l) => l.includes("Install sandbox…"))).toBe(true);
	});

	it("the vm-side single-flight refusal (the runInstall race) surfaces inline with the shared escape", async () => {
		const log: string[] = [];
		const refusal = activeSessionRefusal("install", {
			sessionDir: "/home/x/.openhammer/vm/sessions/live-one",
			pid: 999,
		});
		const root = await sandboxed(
			log,
			() => ({
				// The wiring maps a thrown runInstall refusal to err — the same Result the
				// flash renders (fake runInstall throwing the scanActiveVmSessions refusal).
				installSandbox: async () => err(refusal) as Result<InstallOutcome, Error>,
			}),
			{ hasGolden: false, vmState: "stopped" }, // line says inactive — the vm-side scan is the race backstop
		);
		for (let i = 0; i < 5; i++) root.handleInput(DOWN); // focus 5 = Install (stopped → the row exists)
		root.handleInput(ENTER);
		await flushActions();
		expect(
			root
				.render(200)
				.some((l) => l.includes("stop the session first: mode off + restart, or Sandbox → Stop sandbox")),
		).toBe(true);
	});
});
