import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSettings, defaultVmSettings, type Settings, type VmSettings } from "./config/settings.ts";
import { loadConfig, type ResolveConfigDeps, resolveConfig } from "./config.ts";

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

/** A vm section with selective overrides over {@link defaultVmSettings}. */
function vmWith(overrides: Partial<VmSettings> = {}): VmSettings {
	return { ...defaultVmSettings(), ...overrides };
}

/** Settings whose vm section is `vm` (the other families at defaults). */
function settingsWithVm(vm: VmSettings): Settings {
	return { ...defaultSettings(), vm };
}

/** A guest-user seam that counts its calls (off mode must make zero). */
function countingGuestUser(user: string): { deps: ResolveConfigDeps; calls: () => number } {
	let n = 0;
	const deps: ResolveConfigDeps = {
		guestUser: () => {
			n += 1;
			return user;
		},
	};
	return { deps, calls: () => n };
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

describe("resolveConfig — vm precedence (flags > env > settings, per field)", () => {
	it("resolves mode flag > env > settings doc, falling through when a layer is silent", () => {
		const { deps } = countingGuestUser("grey");
		const doc = settingsWithVm(vmWith({ mode: "vm" }));
		// flag beats env and doc
		expect(resolveConfig({ vmMode: "agent" }, { MCP_VM_MODE: "off" }, doc, deps).vm.mode).toBe("agent");
		expect(resolveConfig({ vmMode: "vm" }, {}, settingsWithVm(vmWith({ mode: "off" })), deps).vm.mode).toBe("vm");
		// env beats doc
		expect(resolveConfig({}, { MCP_VM_MODE: "agent" }, settingsWithVm(vmWith({ mode: "off" })), deps).vm.mode).toBe(
			"agent",
		);
		// doc fills the gap
		expect(resolveConfig({}, {}, doc, deps).vm.mode).toBe("vm");
		// nothing set → off (the default boot)
		expect(resolveConfig({}, {}, defaultSettings(), deps).vm.mode).toBe("off");
	});

	it("resolves every settings-backed field env > doc", () => {
		const { deps } = countingGuestUser("grey");
		const doc = settingsWithVm(
			vmWith({
				memoryMb: 2048,
				cpus: 2,
				persist: "discard",
				idleTimeoutMs: 1000,
				agentCmd: "codex",
				secretsDir: "/doc/secrets",
			}),
		);
		const resolved = resolveConfig(
			{},
			{
				MCP_VM_MODE: "vm",
				MCP_VM_MEMORY: "8192",
				MCP_VM_CPUS: "6",
				MCP_VM_PERSIST: "retain",
				MCP_VM_IDLE_TIMEOUT_MS: "900000",
				MCP_VM_AGENT_CMD: "agy",
				MCP_VM_SECRETS_DIR: "/env/secrets",
			},
			doc,
			deps,
		);
		expect(resolved.vm.memoryMb).toBe(8192);
		expect(resolved.vm.cpus).toBe(6);
		expect(resolved.vm.persist).toBe("retain");
		expect(resolved.vm.idleTimeoutMs).toBe(900000);
		expect(resolved.vm.agentCmd).toBe("agy");
		expect(resolved.vm.secretsDir).toBe("/env/secrets");
	});

	it("gap-fills: env that mentions memory only leaves the doc's other fields standing", () => {
		const { deps } = countingGuestUser("grey");
		const doc = settingsWithVm(vmWith({ memoryMb: 2048, cpus: 2, persist: "discard", agentCmd: "codex" }));
		const resolved = resolveConfig({}, { MCP_VM_MODE: "vm", MCP_VM_MEMORY: "8192" }, doc, deps);
		expect(resolved.vm.memoryMb).toBe(8192); // env wins where it speaks
		expect(resolved.vm.cpus).toBe(2); // doc survives where env is silent
		expect(resolved.vm.persist).toBe("discard");
		expect(resolved.vm.agentCmd).toBe("codex");
	});

	it("treats a blank env value as unset and falls through to the doc", () => {
		const { deps } = countingGuestUser("grey");
		const doc = settingsWithVm(vmWith({ memoryMb: 2048, agentCmd: "codex" }));
		const resolved = resolveConfig({}, { MCP_VM_MODE: "vm", MCP_VM_MEMORY: "   ", MCP_VM_AGENT_CMD: "" }, doc, deps);
		expect(resolved.vm.memoryMb).toBe(2048);
		expect(resolved.vm.agentCmd).toBe("codex");
	});

	it("parses the full env table", () => {
		const { deps } = countingGuestUser("grey");
		const resolved = resolveConfig(
			{},
			{
				MCP_VM_MODE: "vm",
				MCP_VM_IMAGE: "/vm/images/golden.qcow2",
				MCP_VM_MEMORY: "8192",
				MCP_VM_CPUS: "6",
				MCP_VM_SSH_PORT: "2222",
				MCP_VM_PERSIST: "retain",
				MCP_VM_SESSION_ID: "stable-id",
				MCP_VM_DISPLAY: "headless",
				MCP_VM_BOOT_TIMEOUT_MS: "60000",
				MCP_VM_BOOT_BLOCK_MS: "5000",
				MCP_VM_DISK_CAP_GB: "60",
				MCP_VM_IDLE_TIMEOUT_MS: "900000",
				MCP_VM_AGENT_CMD: "codex",
				MCP_VM_SECRETS_DIR: "/vm/secrets",
			},
			defaultSettings(),
			deps,
		);
		expect(resolved.vm).toEqual({
			mode: "vm",
			image: "/vm/images/golden.qcow2",
			memoryMb: 8192,
			cpus: 6,
			sshPort: 2222,
			persist: "retain",
			sessionId: "stable-id",
			display: "headless",
			bootTimeoutMs: 60000,
			bootBlockMs: 5000,
			diskCapGb: 60,
			idleTimeoutMs: 900000,
			agentCmd: "codex",
			secretsDir: "/vm/secrets",
		});
	});

	it("MCP_VM_MODE alone yields the documented defaults (settings values + env-only defaults)", () => {
		const { deps } = countingGuestUser("grey");
		const resolved = resolveConfig({}, { MCP_VM_MODE: "vm" }, defaultSettings(), deps);
		expect(resolved.vm).toEqual({
			mode: "vm",
			image: null,
			memoryMb: 4096, // settings default (22-measured)
			cpus: 4,
			sshPort: 0, // ephemeral
			persist: "auto",
			sessionId: null,
			display: "headless",
			bootTimeoutMs: 180_000,
			bootBlockMs: 0,
			diskCapGb: 45,
			idleTimeoutMs: 0, // never
			agentCmd: "claude",
			secretsDir: null,
		});
	});
});

describe("resolveConfig — vm env validation (fail-fatal, actionable)", () => {
	it("throws naming the variable for a malformed integer", () => {
		const { deps } = countingGuestUser("grey");
		const env = { MCP_VM_MODE: "vm" } as NodeJS.ProcessEnv;
		expect(() => resolveConfig({}, { ...env, MCP_VM_MEMORY: "4o96" }, defaultSettings(), deps)).toThrow(
			'MCP_VM_MEMORY must be an integer >= 1 (got "4o96")',
		);
		expect(() => resolveConfig({}, { ...env, MCP_VM_CPUS: "two" }, defaultSettings(), deps)).toThrow(/MCP_VM_CPUS/);
		expect(() => resolveConfig({}, { ...env, MCP_VM_SSH_PORT: "-1" }, defaultSettings(), deps)).toThrow(
			/MCP_VM_SSH_PORT/,
		);
		expect(() => resolveConfig({}, { ...env, MCP_VM_DISK_CAP_GB: "abc" }, defaultSettings(), deps)).toThrow(
			/MCP_VM_DISK_CAP_GB/,
		);
		expect(() => resolveConfig({}, { ...env, MCP_VM_BOOT_TIMEOUT_MS: "soon" }, defaultSettings(), deps)).toThrow(
			/MCP_VM_BOOT_TIMEOUT_MS/,
		);
		expect(() => resolveConfig({}, { ...env, MCP_VM_MEMORY: "3.5" }, defaultSettings(), deps)).toThrow(
			/MCP_VM_MEMORY/,
		); // non-integer
	});

	it("throws for an invalid mode/persist/display literal", () => {
		const { deps } = countingGuestUser("grey");
		// MCP_VM_MODE is parsed unconditionally (it decides the mode), so it throws standalone.
		expect(() => resolveConfig({}, { MCP_VM_MODE: "sandbox" }, defaultSettings(), deps)).toThrow(
			'MCP_VM_MODE must be one of off, vm, agent (got "sandbox")',
		);
		expect(() => resolveConfig({}, { MCP_VM_MODE: "vm", MCP_VM_PERSIST: "always" }, defaultSettings(), deps)).toThrow(
			'MCP_VM_PERSIST must be one of auto, retain, discard (got "always")',
		);
		// "headless" is the 22-measured winner and the only valid display value.
		expect(() => resolveConfig({}, { MCP_VM_MODE: "vm", MCP_VM_DISPLAY: "gl" }, defaultSettings(), deps)).toThrow(
			'MCP_VM_DISPLAY must be "headless" (got "gl")',
		);
	});

	it("off mode never reads the MCP_VM_* table — a malformed var cannot fail a local boot (zero-change pin)", () => {
		const { deps } = countingGuestUser("grey");
		const resolved = resolveConfig(
			{},
			{ MCP_VM_MEMORY: "not-a-number", MCP_VM_DISPLAY: "gl", MCP_VM_PERSIST: "always" },
			defaultSettings(),
			deps,
		);
		expect(resolved.vm.mode).toBe("off");
		expect(resolved.vm.memoryMb).toBe(4096); // settings default — the env table was unread
		expect(resolved.rootDir).toBe(resolve(process.cwd())); // host resolution, byte-for-byte
	});
});

describe("resolveConfig — guest-root reinterpretation (spec 27)", () => {
	it("off mode keeps loadConfig's host rootDir byte-for-byte and never invokes the seam", () => {
		const { deps, calls } = countingGuestUser("grey");
		expect(resolveConfig({}, {}, defaultSettings(), deps).rootDir).toBe(resolve(process.cwd()));
		expect(resolveConfig({}, { MCP_ROOT_DIR: "/srv/data" }, defaultSettings(), deps).rootDir).toBe("/srv/data");
		expect(calls()).toBe(0);
	});

	it("vm mode uses a set MCP_ROOT_DIR AS the guest root (a stale host value is the reinterpretation)", () => {
		const { deps, calls } = countingGuestUser("grey");
		expect(
			resolveConfig({}, { MCP_VM_MODE: "vm", MCP_ROOT_DIR: "/home/sandbox/project" }, defaultSettings(), deps)
				.rootDir,
		).toBe("/home/sandbox/project");
		expect(
			resolveConfig({ vmMode: "vm" }, { MCP_ROOT_DIR: "/stale/host/path" }, defaultSettings(), deps).rootDir,
		).toBe("/stale/host/path");
		// Normalized like the host path: a trailing slash collapses.
		expect(
			resolveConfig({}, { MCP_VM_MODE: "vm", MCP_ROOT_DIR: "/guest/root/" }, defaultSettings(), deps).rootDir,
		).toBe("/guest/root");
		expect(calls()).toBe(0); // a set value never consults the seam
	});

	it("vm mode with MCP_ROOT_DIR unset (or blank) defaults to /home/<guestUser> via the seam", () => {
		const { deps, calls } = countingGuestUser("grey");
		expect(resolveConfig({}, { MCP_VM_MODE: "vm" }, defaultSettings(), deps).rootDir).toBe("/home/grey");
		expect(resolveConfig({}, { MCP_VM_MODE: "vm", MCP_ROOT_DIR: "  " }, defaultSettings(), deps).rootDir).toBe(
			"/home/grey",
		);
		expect(calls()).toBe(2); // called exactly once per unset resolve
	});

	it("agent mode reinterprets the same way", () => {
		const { deps } = countingGuestUser("grey");
		expect(
			resolveConfig({}, { MCP_VM_MODE: "agent", MCP_ROOT_DIR: "/guest/root" }, defaultSettings(), deps).rootDir,
		).toBe("/guest/root");
		expect(resolveConfig({}, { MCP_VM_MODE: "agent" }, defaultSettings(), deps).rootDir).toBe("/home/grey");
	});

	it("a settings-doc vm mode keys the reinterpretation too (the RESOLVED mode, not just env/flags)", () => {
		expect(resolveConfig({}, {}, settingsWithVm(vmWith({ mode: "vm" })), { guestUser: () => "grey" }).rootDir).toBe(
			"/home/grey",
		);
	});

	it("a relative MCP_ROOT_DIR normalizes against the host cwd in vm mode (documented; preflight judges)", () => {
		const { deps } = countingGuestUser("grey");
		expect(resolveConfig({}, { MCP_VM_MODE: "vm", MCP_ROOT_DIR: "sub/dir" }, defaultSettings(), deps).rootDir).toBe(
			resolve(process.cwd(), "sub/dir"),
		);
	});
});
