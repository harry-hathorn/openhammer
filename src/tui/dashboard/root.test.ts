import { describe, expect, it } from "vitest";
import type { IssuedClient } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { ok, type Result } from "../../tools/result.ts";
import { createStyle } from "../style.ts";
import { type DashboardActions, DashboardRoot } from "./root.ts";
import { DashboardStore } from "./store.ts";

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
		runDoctor: async () => {
			log.push("runDoctor");
			return "doctor-report-line";
		},
		quit: () => log.push("quit"),
	};
}

function seed(): Settings {
	return { version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } };
}

/** A root seeded with one channel + one OAuth client, identity style. */
function rooted(log: string[]): DashboardRoot {
	const store = new DashboardStore(
		{},
		{ version: 1, channels: [ch({ id: "ch1", label: "tun" })], defaultChannel: null, mcp: { allowedClients: [] } },
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
	it("issue row runs issueClient and shows the one-time secret reveal", async () => {
		const log: string[] = [];
		const root = rooted(log);
		// menu -> Clients (index 2)
		root.handleInput(DOWN);
		root.handleInput(DOWN);
		root.handleInput(ENTER);
		expect(root.screen).toEqual({ kind: "section", section: "clients" });
		// clients: [client, issue] -> focus the issue row (1)
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
		root.handleInput(ENTER); // clients
		root.handleInput(ENTER); // focus 0 = client -> detail
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
