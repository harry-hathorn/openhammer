import {
	existsSync,
	writeFileSync as fsWriteFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChannelEntry, Settings } from "./settings.ts";
import { CHANNEL_KINDS, CHANNEL_MODES, defaultSettings, loadSettings, saveSettings, settingsPath } from "./settings.ts";

describe("settingsPath", () => {
	it("resolves <homeDir>/.openhammer/config.json", () => {
		expect(settingsPath("/home/foo")).toBe("/home/foo/.openhammer/config.json");
	});
});

describe("channel kinds & modes", () => {
	it("exposes the known channel kinds as a const object", () => {
		expect(Object.values(CHANNEL_KINDS).sort()).toEqual(["cloudflare", "nginx", "ngrok", "static-url"]);
	});

	it("exposes the two channel modes", () => {
		expect(Object.values(CHANNEL_MODES).sort()).toEqual(["live", "static"]);
	});
});

describe("defaultSettings", () => {
	it("returns the spec defaults", () => {
		expect(defaultSettings()).toEqual({
			version: 1,
			channels: [],
			defaultChannel: null,
			mcp: { allowedClients: [] },
		});
	});
});

describe("loadSettings", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-settings-"));
		path = join(dir, ".openhammer", "config.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Create the `.openhammer` dir and write a raw string to `config.json`. */
	function seedDoc(contents: string): void {
		mkdirSync(dirname(path), { recursive: true });
		fsWriteFileSync(path, contents, { mode: 0o600 });
	}

	it("returns defaults when the file is absent", () => {
		expect(loadSettings(path)).toEqual(defaultSettings());
	});

	it("returns defaults when the JSON is corrupt", () => {
		seedDoc("not valid json {{{");
		expect(loadSettings(path)).toEqual(defaultSettings());
	});

	it("returns defaults when the JSON is valid but not a Settings shape", () => {
		seedDoc(JSON.stringify({}));
		expect(loadSettings(path)).toEqual(defaultSettings());

		seedDoc(JSON.stringify({ version: 1 }));
		expect(loadSettings(path)).toEqual(defaultSettings());
	});

	it("returns defaults when a channel entry is malformed", () => {
		seedDoc(
			JSON.stringify({
				version: 1,
				channels: [{ id: "x", kind: "ngrok" }], // missing mode/options
				defaultChannel: null,
				mcp: { allowedClients: [] },
			}),
		);
		expect(loadSettings(path)).toEqual(defaultSettings());
	});

	it("returns defaults when a channel has an unknown kind", () => {
		seedDoc(
			JSON.stringify({
				version: 1,
				channels: [{ id: "x", kind: "wireguard", mode: "live", options: {} }],
				defaultChannel: null,
				mcp: { allowedClients: [] },
			}),
		);
		expect(loadSettings(path)).toEqual(defaultSettings());
	});

	it("loads a fully valid document (live + static channels)", () => {
		const live: ChannelEntry = { id: "abc", kind: "ngrok", mode: "live", options: { region: "us" } };
		const deployed: ChannelEntry = {
			id: "def",
			kind: "nginx",
			mode: "static",
			label: "prod box",
			options: { publicUrl: "https://oh.example.com" },
		};
		const s: Settings = {
			version: 1,
			channels: [live, deployed],
			defaultChannel: "abc",
			mcp: { allowedClients: ["claude-code"] },
		};
		seedDoc(JSON.stringify(s));
		expect(loadSettings(path)).toEqual(s);
	});
});

describe("saveSettings", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-settings-"));
		path = join(dir, ".openhammer", "config.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	/** Filter `config.json`'s directory for lingering `.tmp` files (should be none). */
	function tempLeftovers(): string[] {
		return readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"));
	}

	it("round-trips a document through loadSettings", () => {
		const s: Settings = {
			version: 1,
			channels: [{ id: "abc", kind: "cloudflare", mode: "live", options: {} }],
			defaultChannel: "abc",
			mcp: { allowedClients: [] },
		};
		saveSettings(path, s);
		expect(loadSettings(path)).toEqual(s);
	});

	it("writes the file at mode 0600 and creates the dir at 0700", () => {
		saveSettings(path, defaultSettings());

		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	});

	it("leaves no temp file behind after a successful write", () => {
		saveSettings(path, defaultSettings());

		expect(tempLeftovers()).toEqual([]);
		expect(readdirSync(dirname(path))).toEqual(["config.json"]);
	});

	it("overwrites a previous document atomically with no leftover temps", () => {
		saveSettings(path, defaultSettings());
		const before = readFileSync(path, "utf-8");

		const next: Settings = {
			version: 1,
			channels: [{ id: "z", kind: "static-url", mode: "static", options: { publicUrl: "https://x.invalid" } }],
			defaultChannel: "z",
			mcp: { allowedClients: ["*"] },
		};
		saveSettings(path, next);

		expect(loadSettings(path)).toEqual(next);
		expect(readFileSync(path, "utf-8")).not.toBe(before);
		expect(tempLeftovers()).toEqual([]);
	});

	it("throws a clear error when the settings directory cannot be created", () => {
		// A regular file as a path component → `mkdir` ENOTDIR regardless of uid
		// (root bypasses a perms-based block, but not ENOTDIR) → deterministic, root-safe.
		const blocker = join(dir, "blocker");
		fsWriteFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "config.json");

		expect(() => saveSettings(blockedPath, defaultSettings())).toThrow(/Cannot create settings directory/);
		// No partial target was created on the failing path.
		expect(existsSync(blockedPath)).toBe(false);
	});
});
