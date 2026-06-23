import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, type Settings } from "./config/settings.ts";
import { loadConfig, resolveConfig } from "./config.ts";

describe("loadConfig", () => {
	it("returns the documented defaults for an empty env", () => {
		expect(loadConfig({})).toEqual({
			port: 3000,
			host: "127.0.0.1",
			rootDir: resolve(process.cwd()),
			authToken: undefined,
			maxResponseBytes: 512_000,
			logLevel: "info",
		});
	});

	it("coerces PORT and resolves an absolute MCP_ROOT_DIR", () => {
		const config = loadConfig({ PORT: "4242", MCP_ROOT_DIR: "/tmp/x" });
		expect(config.port).toBe(4242);
		expect(config.rootDir).toBe("/tmp/x");
	});

	it("coerces MCP_MAX_RESPONSE_BYTES", () => {
		expect(loadConfig({ MCP_MAX_RESPONSE_BYTES: "1024" }).maxResponseBytes).toBe(1024);
	});

	it("preserves a genuine PORT of 0 (ephemeral port, used by tests)", () => {
		expect(loadConfig({ PORT: "0" }).port).toBe(0);
	});

	it("overrides HOST and LOG_LEVEL", () => {
		const config = loadConfig({ HOST: "0.0.0.0", LOG_LEVEL: "debug" });
		expect(config.host).toBe("0.0.0.0");
		expect(config.logLevel).toBe("debug");
	});

	it("surfaces MCP_AUTH_TOKEN as an override", () => {
		expect(loadConfig({ MCP_AUTH_TOKEN: "secret" }).authToken).toBe("secret");
	});

	it("treats an empty MCP_AUTH_TOKEN as unset (mint on boot)", () => {
		expect(loadConfig({ MCP_AUTH_TOKEN: "" }).authToken).toBeUndefined();
	});

	it("falls back to the default port when PORT is NaN or empty", () => {
		expect(loadConfig({ PORT: "not-a-number" }).port).toBe(3000);
		expect(loadConfig({ PORT: "" }).port).toBe(3000);
	});

	it("falls back to the default maxResponseBytes when NaN or empty", () => {
		expect(loadConfig({ MCP_MAX_RESPONSE_BYTES: "nope" }).maxResponseBytes).toBe(512_000);
		expect(loadConfig({ MCP_MAX_RESPONSE_BYTES: "" }).maxResponseBytes).toBe(512_000);
	});

	it("resolves a relative MCP_ROOT_DIR against the cwd", () => {
		expect(loadConfig({ MCP_ROOT_DIR: "sub/dir" }).rootDir).toBe(resolve(process.cwd(), "sub/dir"));
	});

	it("does not fail boot when MCP_ROOT_DIR points at a missing path", () => {
		const config = loadConfig({ MCP_ROOT_DIR: "/this/does/not/exist/openhammer" });
		expect(config.rootDir).toBe("/this/does/not/exist/openhammer");
	});
});

/** A settings doc with selective overrides over {@link defaultSettings}. */
function settingsWith(overrides: Partial<Settings> = {}): Settings {
	return { ...defaultSettings(), ...overrides };
}

describe("resolveConfig", () => {
	it("applies CLI flags > env > settings: --channel wins, env allowlist wins, env drives the server shape", () => {
		const settings = settingsWith({ defaultChannel: "file-channel", mcp: { allowedClients: ["file-client"] } });
		const resolved = resolveConfig(
			{ channel: "flag-channel" },
			{ MCP_ALLOWED_CLIENTS: "env-client", PORT: "9999" },
			settings,
		);
		expect(resolved.channelId).toBe("flag-channel"); // flag > settings.defaultChannel
		expect(resolved.allowedClients).toEqual(["env-client"]); // env > settings.mcp.allowedClients
		expect(resolved.port).toBe(9999); // env still drives the server shape
	});

	it("fills the gaps from the settings doc when flags and env are absent", () => {
		const settings = settingsWith({ defaultChannel: "default-channel", mcp: { allowedClients: ["a", "b"] } });
		const resolved = resolveConfig({}, {}, settings);
		expect(resolved.channelId).toBe("default-channel"); // settings fills the channel
		expect(resolved.allowedClients).toEqual(["a", "b"]); // settings fills the allowlist
	});

	it("resolves channelId to null when neither --channel nor defaultChannel is set (localhost-only boot)", () => {
		expect(resolveConfig({}, {}, defaultSettings()).channelId).toBeNull();
	});

	it("treats an empty/whitespace MCP_ALLOWED_CLIENTS as unset and falls through to the settings doc", () => {
		const settings = settingsWith({ mcp: { allowedClients: ["file-client"] } });
		expect(resolveConfig({}, { MCP_ALLOWED_CLIENTS: "" }, settings).allowedClients).toEqual(["file-client"]);
		expect(resolveConfig({}, { MCP_ALLOWED_CLIENTS: "   " }, settings).allowedClients).toEqual(["file-client"]);
	});

	it("parses MCP_ALLOWED_CLIENTS on commas and newlines, trimming and dropping empties", () => {
		const resolved = resolveConfig({}, { MCP_ALLOWED_CLIENTS: "claude-code, cursor\n * ,, " }, defaultSettings());
		expect(resolved.allowedClients).toEqual(["claude-code", "cursor", "*"]);
	});

	it("preserves the env-driven server shape (loadConfig layer, backward compatible)", () => {
		const resolved = resolveConfig(
			{},
			{ PORT: "4242", MCP_ROOT_DIR: "/tmp/x", MCP_AUTH_TOKEN: "secret" },
			defaultSettings(),
		);
		expect(resolved.port).toBe(4242);
		expect(resolved.rootDir).toBe("/tmp/x");
		expect(resolved.authToken).toBe("secret");
	});

	it("carries the merged fields on top of the full Config server shape", () => {
		const resolved = resolveConfig({}, {}, defaultSettings());
		expect(resolved).toEqual(
			expect.objectContaining({ port: 3000, host: "127.0.0.1", rootDir: resolve(process.cwd()), logLevel: "info" }),
		);
		expect(resolved.channelId).toBeNull();
		expect(resolved.allowedClients).toEqual([]);
	});
});
