import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVmDirs, type VmDirs } from "../session.ts";
import {
	defaultGuestConfig,
	GUEST_AGENTS,
	type GuestConfig,
	guestConfigPath,
	loadGuestConfig,
	normalizeGuestConfig,
	saveGuestConfig,
} from "./guest-config.ts";

/** A fresh HOME per test — resolveVmDirs({homeDir}) roots the whole vm tree inside it; nothing real is touched. */
async function withTempDirs(fn: (dirs: VmDirs) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "openhammer-guest-config-"));
	try {
		await fn(resolveVmDirs({ homeDir: home }));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/** A fully-populated valid config — every field non-default, so round-trips prove real reads. */
const fullConfig: GuestConfig = {
	hostname: "build-box",
	timezone: "Europe/Berlin",
	keyboard: "de-latin1",
	username: "builder",
	gitName: "Harry Hathorn",
	gitEmail: "harry@example.invalid",
	encrypt: true,
	agent: "codex",
	extraPackages: ["ripgrep", "fd", "base-devel"],
	bootCommands: ["systemctl --user enable syncthing", "echo provisioned"],
};

/** The valid doc as a mutable plain object — the base every invalid-table entry mutates. */
const validDoc: Record<string, unknown> = {
	hostname: "build-box",
	timezone: "Europe/Berlin",
	keyboard: "de-latin1",
	username: "builder",
	gitName: "Harry Hathorn",
	gitEmail: "harry@example.invalid",
	encrypt: true,
	agent: "codex",
	extraPackages: ["ripgrep", "fd", "base-devel"],
	bootCommands: ["systemctl --user enable syncthing", "echo provisioned"],
};

/** `validDoc` minus one key — every field is required, so any hole is corrupt. */
function without(key: string): Record<string, unknown> {
	const copy = { ...validDoc };
	delete copy[key];
	return copy;
}

/** `validDoc` with one field replaced — the wrong-shape table. */
function withField(key: string, value: unknown): Record<string, unknown> {
	return { ...validDoc, [key]: value };
}

describe("GUEST_AGENTS", () => {
	it("is exactly Omarchy's 13 first-class agents", () => {
		expect([...GUEST_AGENTS]).toEqual([
			"claude",
			"codex",
			"opencode",
			"agy",
			"copilot",
			"crush",
			"grok",
			"pi",
			"omp",
			"ori",
			"hermes",
			"muse",
			"cursor-agent",
		]);
	});
});

describe("defaultGuestConfig", () => {
	it("returns the spec-26 defaults with the spike's git placeholders", () => {
		expect(defaultGuestConfig()).toEqual({
			hostname: "omarchy-sandbox",
			timezone: "UTC",
			keyboard: "us",
			username: "sandbox",
			gitName: "OpenHammer Sandbox",
			gitEmail: "sandbox@openhammer.local",
			encrypt: false,
			agent: "claude",
			extraPackages: [],
			bootCommands: [],
		});
	});

	it("satisfies its own normalization (defaults are always a valid doc)", () => {
		expect(normalizeGuestConfig(defaultGuestConfig())).toEqual(defaultGuestConfig());
	});
});

describe("normalizeGuestConfig", () => {
	it("accepts a fully-populated doc and returns it canonically", () => {
		expect(normalizeGuestConfig(validDoc)).toEqual(fullConfig);
	});

	it("ignores unknown extra keys (the settings.ts posture — extras are not corruption)", () => {
		expect(normalizeGuestConfig({ ...validDoc, surprise: "ignored" })).toEqual(fullConfig);
	});

	it("accepts every agent in the vocabulary", () => {
		for (const agent of GUEST_AGENTS) {
			expect(normalizeGuestConfig(withField("agent", agent))?.agent).toBe(agent);
		}
	});

	it("accepts single-letter segments and loose git identities", () => {
		expect(
			normalizeGuestConfig({ ...validDoc, hostname: "a", username: "z", gitName: "", gitEmail: "" }),
		).not.toBeNull();
	});

	const badDocs: Array<{ name: string; doc: unknown }> = [
		{ name: "not an object (string)", doc: "nope" },
		{ name: "not an object (null)", doc: null },
		{ name: "not an object (array)", doc: [validDoc] },
		{ name: "missing hostname", doc: without("hostname") },
		{ name: "missing timezone", doc: without("timezone") },
		{ name: "missing keyboard", doc: without("keyboard") },
		{ name: "missing username", doc: without("username") },
		{ name: "missing gitName", doc: without("gitName") },
		{ name: "missing gitEmail", doc: without("gitEmail") },
		{ name: "missing encrypt", doc: without("encrypt") },
		{ name: "missing agent", doc: without("agent") },
		{ name: "missing extraPackages", doc: without("extraPackages") },
		{ name: "missing bootCommands", doc: without("bootCommands") },
		{ name: "hostname wrong type", doc: withField("hostname", 42) },
		{ name: "timezone wrong type", doc: withField("timezone", 1) },
		{ name: "keyboard wrong type", doc: withField("keyboard", false) },
		{ name: "username wrong type", doc: withField("username", null) },
		{ name: "gitName wrong type", doc: withField("gitName", 7) },
		{ name: "gitEmail wrong type", doc: withField("gitEmail", true) },
		{ name: "encrypt as string", doc: withField("encrypt", "false") },
		{ name: "agent wrong type", doc: withField("agent", 9) },
		{ name: "extraPackages as string", doc: withField("extraPackages", "ripgrep") },
		{ name: "bootCommands as object", doc: withField("bootCommands", { run: "true" }) },
		{ name: "hostname with underscore", doc: withField("hostname", "bad_host") },
		{ name: "hostname with dot", doc: withField("hostname", "dot.ted") },
		{ name: "hostname leading hyphen", doc: withField("hostname", "-lead") },
		{ name: "hostname trailing hyphen", doc: withField("hostname", "trail-") },
		{ name: "hostname with space", doc: withField("hostname", "bad host") },
		{ name: "hostname empty", doc: withField("hostname", "") },
		{ name: "hostname longer than 63 chars", doc: withField("hostname", `${"a".repeat(63)}-x`) },
		{ name: "username with space", doc: withField("username", "u ser") },
		{ name: "username empty", doc: withField("username", "") },
		{ name: "username with metachar", doc: withField("username", "user;id") },
		{ name: "timezone with space", doc: withField("timezone", "New York") },
		{ name: "timezone empty", doc: withField("timezone", "") },
		{ name: "keyboard with space", doc: withField("keyboard", "us alt") },
		{ name: "keyboard empty", doc: withField("keyboard", "") },
		{ name: "unknown agent", doc: withField("agent", "chatgpt") },
		{ name: "agent case mismatch", doc: withField("agent", "Claude") },
		{ name: "package token with space", doc: withField("extraPackages", ["my pkg"]) },
		{ name: "package token with semicolon", doc: withField("extraPackages", ["pkg;rm"]) },
		{ name: "package token shell substitution", doc: withField("extraPackages", ["$(id)"]) },
		{ name: "package token empty", doc: withField("extraPackages", [""]) },
		{ name: "package entry not a string", doc: withField("extraPackages", [1]) },
		{ name: "bootCommand empty line", doc: withField("bootCommands", ["echo ok", ""]) },
		{ name: "bootCommand entry not a string", doc: withField("bootCommands", ["echo ok", 1]) },
	];

	it.each(badDocs)("$name → null", ({ doc }) => {
		expect(normalizeGuestConfig(doc)).toBeNull();
	});
});

describe("loadGuestConfig", () => {
	/** Create the vm root and write a raw string to guest.json (the settings.test.ts seedDoc idiom). */
	function seedDoc(dirs: VmDirs, contents: string): void {
		mkdirSync(dirs.root, { recursive: true });
		writeFileSync(guestConfigPath(dirs), contents, { mode: 0o600 });
	}

	it("yields defaults when the doc is absent (fresh tree)", async () => {
		await withTempDirs((dirs) => {
			expect(loadGuestConfig(dirs)).toEqual(defaultGuestConfig());
		});
	});

	it("reads a valid doc", async () => {
		await withTempDirs((dirs) => {
			seedDoc(dirs, `${JSON.stringify(validDoc)}\n`);
			expect(loadGuestConfig(dirs)).toEqual(fullConfig);
		});
	});

	it("yields defaults when the JSON is corrupt (the loadSettings posture — never throws)", async () => {
		await withTempDirs((dirs) => {
			seedDoc(dirs, "not valid json {{{");
			expect(loadGuestConfig(dirs)).toEqual(defaultGuestConfig());
		});
	});

	it("yields defaults when the JSON is valid but not a GuestConfig shape", async () => {
		await withTempDirs((dirs) => {
			seedDoc(dirs, JSON.stringify({ hostname: "only-this" }));
			expect(loadGuestConfig(dirs)).toEqual(defaultGuestConfig());
		});
	});
});

describe("saveGuestConfig", () => {
	it("creates the 0700 vm root, writes guest.json 0600, and round-trips", async () => {
		await withTempDirs((dirs) => {
			saveGuestConfig(dirs, fullConfig);
			const path = guestConfigPath(dirs);
			expect(mode(dirs.root)).toBe(0o700);
			expect(mode(path)).toBe(0o600);
			expect(readFileSync(path, "utf8")).toBe(`${JSON.stringify(fullConfig, null, 2)}\n`);
			expect(loadGuestConfig(dirs)).toEqual(fullConfig);
		});
	});

	it("overwrites atomically — one file remains, no .tmp lingers", async () => {
		await withTempDirs((dirs) => {
			saveGuestConfig(dirs, fullConfig);
			saveGuestConfig(dirs, defaultGuestConfig());
			expect(readdirSync(dirs.root).sort()).toEqual(["guest.json"]);
			expect(loadGuestConfig(dirs)).toEqual(defaultGuestConfig());
		});
	});
});
