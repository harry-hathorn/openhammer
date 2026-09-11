import { describe, expect, it } from "vitest";
import type { IssuedClient } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { defaultVmSettings } from "../../config/settings.ts";
import { err, ok, type Result } from "../../tools/result.ts";
import { createSandboxActions, VM_UNOWNED_HINT } from "../dashboard.ts";
import { createStyle } from "../style.ts";
import { type DashboardActions, DashboardRoot } from "./root.ts";
import { DashboardStore } from "./store.ts";
import type { SerialSource } from "./view.ts";

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
): DashboardRoot {
	const store = new DashboardStore(
		{ env: { MCP_ROOT_DIR: "/srv/guest-work" } },
		{
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: [] },
			vm: { ...defaultVmSettings(), mode },
		},
	);
	if (mode === "vm") {
		store.applyVmStateLine(
			JSON.stringify({
				type: "vm-state",
				state: "ready",
				sessionId: "vm-20260911T101112Z-ab",
				phase: null,
				sshPort: 42255,
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
	): Promise<DashboardRoot> {
		const root = vmRooted(log, "vm", actionsOver);
		for (let i = 0; i < 6; i++) root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "sandbox" });
		return root;
	}

	it("the screen lists Stop / Restart / Serial tail / Back, the stop subtitle carrying the re-boot semantics", async () => {
		// Rendered wide (200): renderList truncates each row to the width, and the stop
		// subtitle only fits its full semantics text on a wide terminal — at 80 the
		// first clause ("power down now — the boot-scoped mode re-boots…") is what shows.
		const lines = (await sandboxed([])).render(200);
		expect(lines.some((l) => l.includes("Stop sandbox…"))).toBe(true);
		expect(lines.some((l) => l.includes("Restart sandbox…"))).toBe(true);
		expect(lines.some((l) => l.includes("Serial tail"))).toBe(true);
		expect(lines.some((l) => l.includes("Back"))).toBe(true);
		expect(lines.some((l) => l.includes("re-boots the sandbox on the next server start"))).toBe(true);
		expect(lines.some((l) => l.includes("lasting stop: mode off + restart"))).toBe(true);
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
		root.handleInput(ENTER); // focus 2 = Serial tail
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
		root.handleInput(ENTER);
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
