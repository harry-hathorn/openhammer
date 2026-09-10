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
import type { ChannelEntry, Settings, VmSettings } from "./settings.ts";
import {
	CHANNEL_KINDS,
	CHANNEL_MODES,
	defaultSettings,
	defaultVmSettings,
	isVmSettings,
	loadSettings,
	normalizeSettings,
	saveSettings,
	settingsPath,
} from "./settings.ts";

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
			vm: {
				mode: "off",
				memoryMb: 4096,
				cpus: 4,
				persist: "auto",
				idleTimeoutMs: 0,
				agentCmd: "claude",
				secretsDir: null,
			},
		});
	});
});

describe("defaultVmSettings", () => {
	it("returns the spec-27 + 22-measured defaults (off, 4096 MiB / 4 cpus, auto, never reap)", () => {
		expect(defaultVmSettings()).toEqual({
			mode: "off",
			memoryMb: 4096,
			cpus: 4,
			persist: "auto",
			idleTimeoutMs: 0,
			agentCmd: "claude",
			secretsDir: null,
		});
	});
});

describe("isVmSettings", () => {
	it("accepts the defaults and a fully custom section", () => {
		expect(isVmSettings(defaultVmSettings())).toBe(true);
		expect(
			isVmSettings({
				mode: "agent",
				memoryMb: 6144,
				cpus: 2,
				persist: "retain",
				idleTimeoutMs: 3_600_000,
				agentCmd: "claude -p --dangerously-skip-permissions",
				secretsDir: "/srv/openhammer-secrets",
			}),
		).toBe(true);
	});

	it("accepts every mode and persist literal", () => {
		for (const mode of ["off", "vm", "agent"]) {
			expect(isVmSettings({ ...defaultVmSettings(), mode }), `mode=${mode}`).toBe(true);
		}
		for (const persist of ["auto", "retain", "discard"]) {
			expect(isVmSettings({ ...defaultVmSettings(), persist }), `persist=${persist}`).toBe(true);
		}
	});

	it("rejects non-sections and each malformed member", () => {
		const rejects: unknown[] = [
			undefined,
			null,
			"off",
			42,
			[],
			{},
			{ ...defaultVmSettings(), mode: "local" }, // not one of the three literals
			{ ...defaultVmSettings(), mode: 1 },
			{ ...defaultVmSettings(), memoryMb: -4096 }, // negative memory
			{ ...defaultVmSettings(), memoryMb: 0 },
			{ ...defaultVmSettings(), memoryMb: 4096.5 }, // fractional
			{ ...defaultVmSettings(), cpus: 0 }, // zero cpus
			{ ...defaultVmSettings(), cpus: -2 },
			{ ...defaultVmSettings(), persist: "keep" }, // not one of the three literals
			{ ...defaultVmSettings(), idleTimeoutMs: -1 }, // negative idle
			{ ...defaultVmSettings(), agentCmd: "" }, // empty command
			{ ...defaultVmSettings(), agentCmd: 7 },
			{ ...defaultVmSettings(), secretsDir: 42 }, // number, not string|null
			{ ...defaultVmSettings(), secretsDir: undefined }, // absent member ≠ null
		];
		for (const v of rejects) {
			expect(isVmSettings(v), `rejects ${JSON.stringify(v)}`).toBe(false);
		}
	});
});

describe("normalizeSettings — vm default-fill (breakage-critical)", () => {
	/** A valid pre-spec-27 doc: everything but the vm key. */
	const preVmDoc = {
		version: 1,
		channels: [{ id: "abc", kind: "ngrok", mode: "live", options: { region: "us" } }],
		defaultChannel: "abc",
		mcp: { allowedClients: ["claude-code"] },
	};

	it("fills defaults when vm is absent", () => {
		expect(normalizeSettings(preVmDoc)?.vm).toEqual(defaultVmSettings());
	});

	it("preserves a valid vm field-for-field", () => {
		const vm: VmSettings = {
			mode: "vm",
			memoryMb: 6144,
			cpus: 2,
			persist: "retain",
			idleTimeoutMs: 3_600_000,
			agentCmd: "claude -p",
			secretsDir: "/srv/keys",
		};
		expect(normalizeSettings({ ...preVmDoc, vm })?.vm).toEqual(vm);
	});

	it("default-fills a wrong-shape vm while the rest of the doc survives (channel intact in every row)", () => {
		const badVms: unknown[] = [
			null,
			"off",
			42,
			[],
			{},
			{ ...defaultVmSettings(), mode: "container" }, // wrong mode
			{ ...defaultVmSettings(), memoryMb: -4096 }, // negative memory
			{ ...defaultVmSettings(), cpus: 0 }, // zero cpus
			{ ...defaultVmSettings(), persist: "keep" }, // bad persist
			{ ...defaultVmSettings(), idleTimeoutMs: -1 }, // negative idle
			{ ...defaultVmSettings(), agentCmd: "" }, // empty agentCmd
			{ ...defaultVmSettings(), secretsDir: 42 }, // secretsDir as number
		];
		for (const vm of badVms) {
			const s = normalizeSettings({ ...preVmDoc, vm });
			expect(s, `doc survives vm=${JSON.stringify(vm)}`).not.toBeNull();
			expect(s?.vm, `vm defaults for vm=${JSON.stringify(vm)}`).toEqual(defaultVmSettings());
			// The rest of the doc is preserved — a mangled vm never wipes the channels.
			expect(s?.channels).toEqual(preVmDoc.channels);
			expect(s?.defaultChannel).toBe("abc");
			expect(s?.mcp).toEqual({ allowedClients: ["claude-code"] });
		}
	});

	it("never throws on vm garbage", () => {
		for (const vm of [
			undefined,
			null,
			"off",
			42,
			[],
			{},
			{ mode: "off" },
			{ ...defaultVmSettings(), secretsDir: {} },
		]) {
			expect(() => normalizeSettings({ ...preVmDoc, vm })).not.toThrow();
		}
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

	it("loads a pre-VM config.json with every channel intact and vm defaulted (the breakage-critical regression)", () => {
		// A REAL pre-spec-27 doc: channels + mcp + defaultChannel set, NO vm key. A
		// required `vm` member (or a whole-doc-strict vm check) would null this doc
		// and `loadSettings` would reset the user's saved channels to defaults — the
		// exact regression spec 27's migration note calls breakage-critical. vm must
		// default-fill; everything else must survive byte-for-byte.
		const live: ChannelEntry = { id: "abc", kind: "ngrok", mode: "live", options: { region: "us" } };
		const deployed: ChannelEntry = {
			id: "def",
			kind: "nginx",
			mode: "static",
			label: "prod box",
			options: { publicUrl: "https://oh.example.com" },
		};
		seedDoc(
			JSON.stringify({
				version: 1,
				channels: [live, deployed],
				defaultChannel: "abc",
				mcp: { allowedClients: ["claude-code", "cursor"] },
			}),
		);
		const loaded = loadSettings(path);
		expect(loaded.channels).toEqual([live, deployed]); // every channel field, both entries
		expect(loaded.defaultChannel).toBe("abc");
		expect(loaded.mcp).toEqual({ allowedClients: ["claude-code", "cursor"] });
		expect(loaded.version).toBe(1);
		expect(loaded.vm).toEqual(defaultVmSettings());
	});

	it("loads a fully valid document (live + static channels + vm)", () => {
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
			vm: {
				mode: "vm",
				memoryMb: 6144,
				cpus: 2,
				persist: "retain",
				idleTimeoutMs: 3_600_000,
				agentCmd: "claude -p",
				secretsDir: "/srv/keys",
			},
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

	it("round-trips a document (with a vm section set) through loadSettings", () => {
		const s: Settings = {
			version: 1,
			channels: [{ id: "abc", kind: "cloudflare", mode: "live", options: {} }],
			defaultChannel: "abc",
			mcp: { allowedClients: [] },
			vm: {
				mode: "agent",
				memoryMb: 6144,
				cpus: 2,
				persist: "discard",
				idleTimeoutMs: 1_800_000,
				agentCmd: "claude --agent",
				secretsDir: null,
			},
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
			vm: defaultVmSettings(),
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
