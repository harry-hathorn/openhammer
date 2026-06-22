import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

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
