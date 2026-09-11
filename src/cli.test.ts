import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "./cli/args.ts";
import { type CommandIo, dispatch, runCli } from "./cli.ts";
import { getCredentials } from "./config/credentials.ts";
import {
	type ChannelEntry,
	defaultSettings,
	defaultVmSettings,
	loadSettings,
	type Settings,
} from "./config/settings.ts";
import { RequestRecorder } from "./mcp/telemetry.ts";
import { startStatusSocket } from "./observability/status-socket.ts";
import { BANNER } from "./tui/banner.ts";
import { defaultGuestConfig, saveGuestConfig } from "./vm/provision/guest-config.ts";
import { resolveVmDirs } from "./vm/session.ts";

/** A recording `BannerStream` fake: collects writes as a string. */
function recordingStream() {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
	};
	return { stream, text: () => chunks.join("") };
}

/** Build a {@link ParsedArgs} for the dispatch tests without restating every field. */
function parsed(command: string | null, rest: string[] = [], opts: Partial<ParsedArgs> = {}): ParsedArgs {
	return { command, rest, tunnel: false, channel: undefined, help: false, diagnostics: [], ...opts };
}

/** Two distinct channels for the temp-`HOME` settings tests. */
const channelA: ChannelEntry = { id: "aaaaaaaa", kind: "cloudflare", mode: "live", options: {} };
const channelB: ChannelEntry = {
	id: "bbbbbbbb",
	kind: "nginx",
	mode: "static",
	options: { publicUrl: "https://example.invalid" },
};

/** Run `fn` with `HOME` pointed at a fresh temp dir (so `~/.openhammer/config.json` is isolated), restoring + cleaning up after. */
async function withTempHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
	const home = mkdtempSync(join(tmpdir(), "oh-cli-home-"));
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		return await fn(home);
	} finally {
		process.env.HOME = prev;
		rmSync(home, { recursive: true, force: true });
	}
}

/** Seed `~/.openhammer/config.json` under `home` with a settings doc. */
function seedSettings(home: string, settings: Settings): void {
	const dir = join(home, ".openhammer");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), JSON.stringify(settings));
}

/**
 * Seed a minimal BOOTABLE golden under `home` (a valid `manifest.json` — the
 * normalizeManifest shape). The spec-28c no-golden mode guard blocks every
 * `vm.mode` write that resolves to vm/agent without one, so the flag-path tests
 * that write vm fields on a vm-mode doc must install the precondition first.
 */
function seedGolden(home: string): void {
	const dir = join(home, ".openhammer", "vm", "images", "golden-4.0.3-20260911-101112");
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "manifest.json"),
		JSON.stringify({
			id: "golden-4.0.3-20260911-101112",
			flavor: "base",
			guestUser: "sandbox",
			rootDir: "/home/sandbox",
			isoVersion: "4.0.3",
			isoUrl: "https://example.invalid/omarchy-4.0.3.iso",
			isoSha256: "a".repeat(64),
			diskVirtualSizeBytes: 42949672960,
			provisionScriptHashes: null,
			builtAt: "2026-09-11T10:11:12Z",
			encrypt: false,
		}),
	);
}

/** A recording channel/config handler fake — captures the routed `sub` + `rest`. */
function fakeHandler() {
	const calls: Array<{ sub: string | undefined; rest: string[] }> = [];
	const handler = async (sub: string | undefined, rest: string[], _io: CommandIo): Promise<number> => {
		calls.push({ sub, rest });
		return 0;
	};
	return { handler, calls };
}

describe("runCli", () => {
	it("prints the README banner on an interactive (TTY) launch", () => {
		const out = recordingStream();
		const err = recordingStream();
		runCli([], { stdout: out.stream, stderr: err.stream, isTTY: true });
		expect(out.text()).toContain(BANNER);
	});

	it("does NOT print the banner on a non-interactive launch", () => {
		const out = recordingStream();
		const err = recordingStream();
		runCli([], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(out.text()).toBe("");
	});

	it("writes diagnostics to stderr and suppresses the banner when non-interactive", () => {
		const out = recordingStream();
		const err = recordingStream();
		const parsed = runCli(["--bogus"], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(parsed.diagnostics).toHaveLength(1);
		expect(err.text()).toContain("warning: Unknown option: --bogus");
		expect(out.text()).toBe("");
	});

	it("returns the parsed args for the dispatcher", () => {
		const out = recordingStream();
		const err = recordingStream();
		const parsed = runCli(["channel", "list"], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(parsed.command).toBe("channel");
		expect(parsed.rest).toEqual(["list"]);
		expect(parsed.tunnel).toBe(false);
	});
});

describe("dispatch — arg → command routing", () => {
	it("`start` delegates to the boot handler and signals the server is running (no exit code)", async () => {
		let booted = false;
		const code = await dispatch(parsed("start"), {
			boot: async () => {
				booted = true;
			},
		});
		expect(booted).toBe(true);
		expect(code).toBeUndefined();
	});

	it("no command (null) in a non-TTY delegates to boot (headless) and signals running", async () => {
		let booted = false;
		let dashboardCalled = false;
		const code = await dispatch(parsed(null), {
			isTTY: false,
			boot: async () => {
				booted = true;
			},
			dashboard: async () => {
				dashboardCalled = true;
				return 0;
			},
		});
		expect(booted).toBe(true);
		expect(dashboardCalled).toBe(false);
		expect(code).toBeUndefined();
	});

	it("no command (null) in a TTY opens the dashboard (not boot) and returns its exit code", async () => {
		let booted = false;
		// A holder (not a `let`) so TS narrows the property reads across the dashboard closure.
		const captured: { parsed: ParsedArgs | null } = { parsed: null };
		const code = await dispatch(parsed(null, [], { tunnel: true, channel: "abc" }), {
			isTTY: true,
			boot: async () => {
				booted = true;
			},
			dashboard: async (p) => {
				captured.parsed = p;
				return 0;
			},
		});
		expect(booted).toBe(false);
		expect(captured.parsed).not.toBeNull();
		expect(captured.parsed?.command).toBeNull();
		expect(captured.parsed?.tunnel).toBe(true); // flags are forwarded to the dashboard
		expect(captured.parsed?.channel).toBe("abc");
		expect(code).toBe(0);
	});

	it("`start` is headless even in a TTY (the dashboard is the no-args entry)", async () => {
		let booted = false;
		let dashboardCalled = false;
		const code = await dispatch(parsed("start"), {
			isTTY: true,
			boot: async () => {
				booted = true;
			},
			dashboard: async () => {
				dashboardCalled = true;
				return 0;
			},
		});
		expect(booted).toBe(true);
		expect(dashboardCalled).toBe(false);
		expect(code).toBeUndefined();
	});

	it("routes `channel <sub>` to the channel handler with sub + trailing rest", async () => {
		const ch = fakeHandler();
		await dispatch(parsed("channel", ["list"]), { channel: ch.handler });
		expect(ch.calls).toEqual([{ sub: "list", rest: [] }]);
	});

	it("routes `channel remove <id>` with the id as the trailing positional", async () => {
		const ch = fakeHandler();
		await dispatch(parsed("channel", ["remove", "xyz"]), { channel: ch.handler });
		expect(ch.calls).toEqual([{ sub: "remove", rest: ["xyz"] }]);
	});

	it("routes `config set <section>` to the config handler with sub + section", async () => {
		const cfg = fakeHandler();
		await dispatch(parsed("config", ["set", "mcp"]), { config: cfg.handler });
		expect(cfg.calls).toEqual([{ sub: "set", rest: ["mcp"] }]);
	});

	it("routes `doctor` to the doctor handler", async () => {
		let called = false;
		const code = await dispatch(parsed("doctor"), {
			doctor: async () => {
				called = true;
				return 0;
			},
		});
		expect(called).toBe(true);
		expect(code).toBe(0);
	});

	it("routes `monitor` to the monitor handler", async () => {
		let called = false;
		const code = await dispatch(parsed("monitor"), {
			monitor: async () => {
				called = true;
				return 0;
			},
		});
		expect(called).toBe(true);
		expect(code).toBe(0);
	});

	it("routes `auth <sub>` to the auth handler with sub + trailing rest", async () => {
		const auth = fakeHandler();
		await dispatch(parsed("auth", ["remove", "oh_abc"]), { auth: auth.handler });
		expect(auth.calls).toEqual([{ sub: "remove", rest: ["oh_abc"] }]);
	});

	it("--help prints usage to stdout and exits 0 (help wins over the command)", async () => {
		const out = recordingStream();
		const err = recordingStream();
		const code = await dispatch(parsed("channel", ["list"], { help: true }), {
			stdout: out.stream,
			stderr: err.stream,
		});
		expect(code).toBe(0);
		expect(out.text()).toContain("Usage: openhammer");
		expect(err.text()).toBe("");
	});

	it("an unwired command prints usage to stderr and exits 2", async () => {
		const out = recordingStream();
		const err = recordingStream();
		const code = await dispatch(parsed("frobnicate"), { stdout: out.stream, stderr: err.stream });
		expect(code).toBe(2);
		expect(err.text()).toContain("Unknown command: frobnicate");
		expect(err.text()).toContain("Usage: openhammer");
	});
});

describe("dispatch — real handlers against an isolated HOME", () => {
	it("`channel list` prints configured channels, marking the default", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, { ...defaultSettings(), channels: [channelA, channelB], defaultChannel: channelA.id });
			const out = recordingStream();
			const code = await dispatch(parsed("channel", ["list"]), { stdout: out.stream });
			expect(code).toBe(0);
			const text = out.text();
			expect(text).toContain(`* ${channelA.id}`);
			expect(text).toContain(` ${channelB.id}`);
			expect(text).toContain("cloudflare");
			expect(text).toContain("nginx");
		});
	});

	it("`channel list` with no channels says so", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const out = recordingStream();
			await dispatch(parsed("channel", ["list"]), { stdout: out.stream });
			expect(out.text()).toContain("No channels configured");
		});
	});

	it("`channel remove <id>` drops the entry, cascades nothing fatal, and persists", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, { ...defaultSettings(), channels: [channelA, channelB], defaultChannel: channelA.id });
			const out = recordingStream();
			const code = await dispatch(parsed("channel", ["remove", channelB.id]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain(`Removed channel ${channelB.id}`);
			const after = loadSettings();
			expect(after.channels.map((c) => c.id)).toEqual([channelA.id]);
			expect(after.defaultChannel).toBe(channelA.id); // untouched — B was not the default
		});
	});

	it("`channel remove <id>` of the default resets the default to null", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, { ...defaultSettings(), channels: [channelA], defaultChannel: channelA.id });
			const out = recordingStream();
			const code = await dispatch(parsed("channel", ["remove", channelA.id]), { stdout: out.stream });
			expect(code).toBe(0);
			const after = loadSettings();
			expect(after.channels).toEqual([]);
			expect(after.defaultChannel).toBeNull();
		});
	});

	it("`channel remove <unknown>` errors with exit 1 and leaves the file unchanged", async () => {
		await withTempHome(async (home) => {
			const before = { ...defaultSettings(), channels: [channelA], defaultChannel: channelA.id };
			seedSettings(home, before);
			const out = recordingStream();
			const err = recordingStream();
			const code = await dispatch(parsed("channel", ["remove", "no-such-id"]), {
				stdout: out.stream,
				stderr: err.stream,
			});
			expect(code).toBe(1);
			expect(err.text()).toContain("No channel with id no-such-id");
			expect(loadSettings().channels.map((c) => c.id)).toEqual([channelA.id]);
		});
	});

	it("`channel remove` with no id is a usage error (exit 2)", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const err = recordingStream();
			const code = await dispatch(parsed("channel", ["remove"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer channel remove");
		});
	});

	it("`channel use <id>` points the default at an existing channel and persists", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, { ...defaultSettings(), channels: [channelA, channelB], defaultChannel: channelA.id });
			const out = recordingStream();
			const code = await dispatch(parsed("channel", ["use", channelB.id]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain(`Default channel set to ${channelB.id}`);
			expect(loadSettings().defaultChannel).toBe(channelB.id);
		});
	});

	it("`channel use <unknown>` errors with exit 1 and leaves the default unchanged", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, { ...defaultSettings(), channels: [channelA], defaultChannel: channelA.id });
			const err = recordingStream();
			const code = await dispatch(parsed("channel", ["use", "no-such-id"]), { stderr: err.stream });
			expect(code).toBe(1);
			expect(err.text()).toContain("No channel with id no-such-id");
			expect(loadSettings().defaultChannel).toBe(channelA.id);
		});
	});

	it("`config get` prints the allowed-clients list + the default channel", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, {
				...defaultSettings(),
				channels: [channelA],
				defaultChannel: channelA.id,
				mcp: { allowedClients: ["claude-code", "cursor"] },
			});
			const out = recordingStream();
			await dispatch(parsed("config", ["get"]), { stdout: out.stream });
			const text = out.text();
			expect(text).toContain("claude-code, cursor");
			expect(text).toContain(channelA.id);
		});
	});

	it("`config get` shows (any) when the allowlist is empty", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const out = recordingStream();
			await dispatch(parsed("config", ["get"]), { stdout: out.stream });
			expect(out.text()).toContain("(any)");
		});
	});

	it("`doctor` runs the built-in checks against an isolated HOME and exits 0 (a warn does not fail)", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("doctor"), { stdout: out.stream });
			expect(code).toBe(0);
			const text = out.text();
			expect(text).toContain("Ran 5 check(s)");
			expect(text).toContain("[pass]");
			// The jwtSecret is unset on a fresh HOME (no env, never booted) → an advisory warn.
			expect(text).toContain("[warn]");
			expect(text).toContain("oauth-jwt-secret:");
			// The built-in check ids are reported regardless of status.
			expect(text).toContain("config:");
			expect(text).toContain("credentials:");
			expect(text).toContain("rg:");
			expect(text).toContain("fd:");
		});
	});

	it("`config set <unknown section>` is a usage error (exit 2) — no wizard, no write", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const err = recordingStream();
			const code = await dispatch(parsed("config", ["set", "bogus"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Unknown section: bogus");
		});
	});

	it("`auth list` against an isolated HOME prints the empty hint and exits 0", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("auth", ["list"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("No OAuth clients registered");
		});
	});

	it("`channel` with no subcommand is a usage error (exit 2)", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const err = recordingStream();
			const code = await dispatch(parsed("channel"), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer channel");
		});
	});
});

describe("dispatch — non-interactive flag mode (spec 20g)", () => {
	it("`channel add --provider ngrok --authtoken` persists a ngrok channel + its secret + sets default (first)", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("channel", ["add", "--provider", "ngrok", "--authtoken", "T0KEN"]), {
				stdout: out.stream,
			});
			expect(code).toBe(0);
			const after = loadSettings();
			expect(after.channels).toHaveLength(1);
			const ch = after.channels[0];
			expect(ch).toMatchObject({ kind: "ngrok", mode: "live", options: {} });
			expect(after.defaultChannel).toBe(ch?.id); // first channel → default
			// The authtoken is split into the secrets store, keyed by the channel id.
			expect(getCredentials(ch?.id ?? "").authtoken).toBe("T0KEN");
			expect(out.text()).toContain("Added ngrok channel");
			expect(out.text()).toContain("(default)");
		});
	});

	it("`channel add --provider ngrok` without the required authtoken is a usage error (exit 2), no write", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("channel", ["add", "--provider", "ngrok"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Missing required field(s) for ngrok: authtoken");
			expect(loadSettings().channels).toEqual([]);
		});
	});

	it("`channel add --provider <unknown>` is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("channel", ["add", "--provider", "bogus"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Unknown channel provider: bogus");
		});
	});

	it("`channel add` with no flags is unchanged (interactive) — flags presence gates the branch", async () => {
		// No --provider → the interactive branch; with a no-op io this would prompt.
		// Here we only assert the dispatch routes `add` with an empty rest without erroring
		// on flag parsing (the interactive wizard is exercised elsewhere).
		await withTempHome(async () => {
			const err = recordingStream();
			// Inject a channel handler that short-circuits to 0 so no TTY is touched.
			const code = await dispatch(parsed("channel", ["add"]), {
				stderr: err.stream,
				channel: async () => 0,
			});
			expect(code).toBe(0);
			expect(err.text()).toBe("");
		});
	});

	it("`channel add --default` forces the new channel to be the default even when not first", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, homeWithChannel(channelA));
			const out = recordingStream();
			const code = await dispatch(
				parsed("channel", ["add", "--provider", "ngrok", "--authtoken", "T", "--default"]),
				{ stdout: out.stream },
			);
			expect(code).toBe(0);
			const after = loadSettings();
			expect(after.channels).toHaveLength(2);
			// --default points the default at the newly-added channel (not channelA).
			expect(after.defaultChannel).toBe(after.channels[1]?.id);
		});
	});

	it("`config set <section>.<key> <value>` sets one field non-interactively (≡ wizard path)", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("config", ["set", "mcp.allowedClients", "claude-code"]), {
				stdout: out.stream,
			});
			expect(code).toBe(0);
			expect(out.text()).toContain("Set mcp.allowedClients");
			// Same parse the wizard's mcpSection.write applies (parseClientList).
			expect(loadSettings().mcp.allowedClients).toEqual(["claude-code"]);
		});
	});

	it('`config set mcp.allowedClients "a, b ,c"` parses the list like the wizard', async () => {
		await withTempHome(async () => {
			await dispatch(parsed("config", ["set", "mcp.allowedClients", "a, b ,c"]), {
				stdout: recordingStream().stream,
			});
			expect(loadSettings().mcp.allowedClients).toEqual(["a", "b", "c"]);
		});
	});

	it("`config set` flag mode preserves the other settings (the channel list is untouched)", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, homeWithChannel(channelA));
			await dispatch(parsed("config", ["set", "mcp.allowedClients", "claude-code"]), {
				stdout: recordingStream().stream,
			});
			const after = loadSettings();
			expect(after.channels.map((c) => c.id)).toEqual([channelA.id]);
			expect(after.defaultChannel).toBe(channelA.id);
			expect(after.mcp.allowedClients).toEqual(["claude-code"]);
		});
	});

	it("`config set vm.mode vm` sets ONLY mode — the persist select (never answerable by this command) keeps its value", async () => {
		// The 27b invariant: a section with a second select used to cancel the whole
		// write (flagIo returned null for the unanswered persist prompt → "Settings
		// not updated.", exit 1). Every non-target field — select AND text — must
		// keep its seeded current value.
		await withTempHome(async (home) => {
			seedSettings(home, {
				...defaultSettings(),
				channels: [channelA, channelB],
				defaultChannel: channelB.id,
				vm: {
					mode: "agent",
					memoryMb: 6144,
					cpus: 8,
					persist: "retain",
					idleTimeoutMs: 60000,
					agentCmd: "agy",
					secretsDir: "/vm/secrets",
				},
			});
			seedGolden(home); // the spec-28c no-golden guard blocks vm-mode writes without a bootable golden
			const out = recordingStream();
			const code = await dispatch(parsed("config", ["set", "vm.mode", "vm"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("Set vm.mode");
			expect(loadSettings().vm).toEqual({
				mode: "vm", // the only change
				memoryMb: 6144,
				cpus: 8,
				persist: "retain", // the unanswered select — unchanged, not cancelled
				idleTimeoutMs: 60000,
				agentCmd: "agy",
				secretsDir: "/vm/secrets",
			});
			const after = loadSettings();
			expect(after.channels.map((c) => c.id)).toEqual([channelA.id, channelB.id]); // channels intact
			expect(after.defaultChannel).toBe(channelB.id);
		});
	});

	it("`config set vm.persist retain` sets only persist (the other select — same invariant)", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, {
				...defaultSettings(),
				vm: { ...defaultVmSettings(), mode: "agent", persist: "discard" },
			});
			seedGolden(home); // the resolved mode stays "agent" — the spec-28c guard wants a bootable golden
			const out = recordingStream();
			const code = await dispatch(parsed("config", ["set", "vm.persist", "retain"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("Set vm.persist");
			// persist is the only change: mode (now the unanswered select) keeps "agent".
			expect(loadSettings().vm).toEqual({ ...defaultVmSettings(), mode: "agent", persist: "retain" });
		});
	});

	it("`config set vm.agentCmd codex` sets a vm text field non-interactively (the 27b-flagged path)", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("config", ["set", "vm.agentCmd", "codex"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("Set vm.agentCmd");
			const after = loadSettings();
			expect(after.vm.agentCmd).toBe("codex");
			expect(after.vm.mode).toBe("off"); // untouched on a default doc
		});
	});

	it("`config set <unknown-section>.key <value>` is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("config", ["set", "bogus.key", "v"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Unknown section: bogus");
		});
	});

	it("`config set mcp.<unknown-key> <value>` is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("config", ["set", "mcp.nope", "v"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Unknown key: nope");
		});
	});

	it("`config set <section>.<key>` with no value is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("config", ["set", "mcp.allowedClients"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer config set <section>.<key> <value>");
		});
	});
});

describe("dispatch — `vm` subcommands (spec 26c/26d/26e)", () => {
	it("routes `vm install` to the vm handler with sub + trailing rest", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["install"]), { vm: vm.handler });
		expect(vm.calls).toEqual([{ sub: "install", rest: [] }]);
	});

	it("routes `vm install --budget-minutes 5` with the flag tokens passed through", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["install", "--budget-minutes", "5"]), { vm: vm.handler });
		expect(vm.calls).toEqual([{ sub: "install", rest: ["--budget-minutes", "5"] }]);
	});

	it("routes `vm provision` to the vm handler with sub + trailing rest", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["provision"]), { vm: vm.handler });
		expect(vm.calls).toEqual([{ sub: "provision", rest: [] }]);
	});

	it("routes `vm snapshot` to the vm handler with sub + trailing rest", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["snapshot"]), { vm: vm.handler });
		expect(vm.calls).toEqual([{ sub: "snapshot", rest: [] }]);
	});

	it("`vm provision` with any flag/positional is a usage error before anything runs (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["provision", "--nope"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer vm provision\n");
		});
	});

	it("`vm snapshot` with any flag/positional is a usage error before anything runs (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["snapshot", "--nope"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer vm snapshot\n");
		});
	});

	it("`vm snapshot` with no provisioned session is a handled domain failure (exit 1, the actionable error)", async () => {
		await withTempHome(async (home) => {
			const err = recordingStream();
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["snapshot"]), { stdout: out.stream, stderr: err.stream });
			expect(code).toBe(1);
			expect(err.text()).toContain("vm snapshot: no provisioned build session to promote");
			expect(err.text()).toContain("run `openhammer vm install` first");
			expect(err.text()).toContain(join(home, ".openhammer", "vm", "sessions"));
		});
	});

	it("`vm` with no subcommand is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm"), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain(
				"Usage: openhammer vm { install | provision | snapshot | list | reset | gc | status }",
			);
		});
	});

	it("`vm <unknown>` names the unknown subcommand and what exists (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["teleport"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain(
				"vm: unknown subcommand 'teleport' (available: install, provision, snapshot, list, reset, gc, status)",
			);
		});
	});

	it("`vm install` with an unknown flag is a usage error before any install runs (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["install", "--nope"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer vm install [--budget-minutes <n>]");
		});
	});

	it("`vm install --budget-minutes <not-a-number>` is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["install", "--budget-minutes", "soon"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain('--budget-minutes must be a positive number (got "soon")');
		});
	});

	it("--help lists the vm command tree", async () => {
		const out = recordingStream();
		await dispatch(parsed(null, [], { help: true }), { stdout: out.stream });
		const text = out.text();
		expect(text).toContain("vm <subcommand>");
		expect(text).toContain("install");
		expect(text).toContain("provision");
		expect(text).toContain("snapshot");
		expect(text).toContain("Promote the provisioned build to the golden image");
		expect(text).toContain("list");
		expect(text).toContain("reset [--yes]");
		expect(text).toContain("gc [--yes] [--keep-goldens <n>]");
		expect(text).toContain("Show the live VM session state");
	});
});

describe("dispatch — `vm` subcommands (spec 26f: list/reset/gc)", () => {
	/** A manifest that passes readManifest — mirrors snapshot.test.ts's canonical shape. */
	function seedGolden(home: string, id: string, manifest: string): string {
		const dir = join(home, ".openhammer", "vm", "images", id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "manifest.json"), manifest);
		writeFileSync(join(dir, "golden.qcow2"), "fake-golden-disk");
		return dir;
	}

	const VALID_MANIFEST = JSON.stringify({
		id: "golden-4.0.3-20260910-070809",
		flavor: "base",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: "https://iso.omarchy.org/omarchy-4.0.3.iso",
		isoSha256: "03d60bc74306dca51f96e1a84b690871d8d606826b260edd0208962da8507d14",
		diskVirtualSizeBytes: 42_949_672_960,
		provisionScriptHashes: null,
		builtAt: "2026-09-10T07:08:09.000Z",
		encrypt: false,
	});

	it("routes `vm list`/`vm reset`/`vm gc` to the vm handler with sub + trailing rest", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["list"]), { vm: vm.handler });
		await dispatch(parsed("vm", ["reset", "--yes"]), { vm: vm.handler });
		await dispatch(parsed("vm", ["gc", "--keep-goldens", "3"]), { vm: vm.handler });
		expect(vm.calls).toEqual([
			{ sub: "list", rest: [] },
			{ sub: "reset", rest: ["--yes"] },
			{ sub: "gc", rest: ["--keep-goldens", "3"] },
		]);
	});

	it("`vm list`: one golden + one corrupt → the row and the corrupt row on stdout, the WARNING on stderr, exit 0", async () => {
		await withTempHome(async (home) => {
			seedGolden(home, "golden-4.0.3-20260910-070809", VALID_MANIFEST);
			seedGolden(home, "golden-4.0.3-20260901-010101", "{not json");
			const out = recordingStream();
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["list"]), { stdout: out.stream, stderr: err.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("golden-4.0.3-20260910-070809");
			expect(out.text()).toContain("flavor base  user sandbox  built 2026-09-10T07:08:09.000Z  iso 4.0.3");
			expect(out.text()).toContain("corrupt: golden-4.0.3-20260901-010101 — manifest.json missing or invalid");
			expect(err.text()).toContain("vm list: WARNING: golden golden-4.0.3-20260901-010101");
		});
	});

	it("`vm list`: the guest.json-drift note is printed per-row (the spec's next-build edge case)", async () => {
		await withTempHome(async (home) => {
			saveGuestConfig(resolveVmDirs({ homeDir: home }), { ...defaultGuestConfig(), username: "builder" });
			seedGolden(home, "golden-4.0.3-20260910-070809", VALID_MANIFEST);
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["list"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain(
				"note: guest.json changed since this golden was baked (guestUser: sandbox→builder)",
			);
			expect(out.text()).toContain("edits apply on the next vm install");
		});
	});

	it("`vm list` with no goldens: the clean empty line, exit 0", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["list"]), { stdout: out.stream, stderr: err.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("No goldens");
			expect(err.text()).toBe("");
		});
	});

	it("`vm reset` on an empty tree: the dry-run report, exit 0, nothing removed", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["reset"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("reset: DRY RUN — 0 session dir(s), 0 B");
			expect(out.text()).toContain("vm reset: done — 0 session dir(s), 0 B (dry run");
		});
	});

	it("`vm reset --nope` is a usage error before anything runs (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["reset", "--nope"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Usage: openhammer vm reset [--yes]\n");
		});
	});

	it("`vm gc` on an empty tree: the dry-run aggregate report, exit 0", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["gc"]), { stdout: out.stream });
			expect(code).toBe(0);
			expect(out.text()).toContain("gc: DRY RUN");
			expect(out.text()).toContain("sessions 0 (0 B), cidata 0 (0 B), goldens 0 (0 B)");
		});
	});

	it("`vm gc --keep-goldens <not-an-integer>` is a usage error (exit 2)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["gc", "--keep-goldens", "zero"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain('vm gc: --keep-goldens must be an integer >= 1 (got "zero")');
		});
	});

	it("`vm gc --keep-goldens 0` is a usage error too (the newest golden is always kept)", async () => {
		await withTempHome(async () => {
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["gc", "--keep-goldens", "0"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain('--keep-goldens must be an integer >= 1 (got "0")');
		});
	});
});

describe("dispatch — `vm status` (spec 27h: the vm-state row from the live status socket)", () => {
	/** Bind a net server on a Unix path, resolving once it listens. */
	function listen(server: ReturnType<typeof createServer>, path: string): Promise<void> {
		return new Promise((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.off("error", reject);
				resolve();
			});
		});
	}

	it("routes `vm status` to the vm handler with sub + trailing rest", async () => {
		const vm = fakeHandler();
		await dispatch(parsed("vm", ["status"]), { vm: vm.handler });
		expect(vm.calls).toEqual([{ sub: "status", rest: [] }]);
	});

	it("socket unreachable → the no-info line on stdout, exit 0 (a status peek never fails)", async () => {
		await withTempHome(async () => {
			const out = recordingStream();
			const err = recordingStream();
			const code = await dispatch(parsed("vm", ["status"]), { stdout: out.stream, stderr: err.stream });
			expect(code).toBe(0);
			expect(out.text()).toBe("vm: no live session info (server not running or mode off)\n");
			expect(err.text()).toBe("");
		});
	});

	it("reachable socket with a vm-state dump → the rendered row, exit 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oh-vm-status-"));
		const path = join(dir, "openhammer.sock");
		try {
			const handle = await startStatusSocket(new RequestRecorder(), {
				path,
				vmState: () => ({
					type: "vm-state",
					state: "ready",
					sessionId: "vm-20260911T101112Z-ab",
					phase: null,
					sshPort: 42255,
					error: null,
				}),
				warn: () => {},
			});
			expect(handle).not.toBeNull();
			if (handle === null) return;
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["status"]), { stdout: out.stream, vmStatusPath: path });
			expect(code).toBe(0);
			expect(out.text()).toBe("VM  ready · session vm-20260911T101112Z-ab · ssh :42255\n");
			await handle.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("reachable socket with NO vm-state in its dump (an off-mode server) → the no-info line, exit 0", async () => {
		const dir = mkdtempSync(join(tmpdir(), "oh-vm-status-"));
		const path = join(dir, "openhammer.sock");
		const server = createServer((socket) => {
			socket.end(); // an off-mode dump: no vm-state line (here: nothing at all) — then close
		});
		try {
			await listen(server, path);
			const out = recordingStream();
			const code = await dispatch(parsed("vm", ["status"]), { stdout: out.stream, vmStatusPath: path });
			expect(code).toBe(0);
			expect(out.text()).toBe("vm: no live session info (server not running or mode off)\n");
		} finally {
			server.close();
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("`vm status --nope` is a usage error before anything runs (exit 2)", async () => {
		const err = recordingStream();
		const code = await dispatch(parsed("vm", ["status", "--nope"]), { stderr: err.stream });
		expect(code).toBe(2);
		expect(err.text()).toContain("Usage: openhammer vm status\n");
	});
});

/** A fresh default settings doc seeded with one channel (the default), for the `--default` / preserve tests. */
function homeWithChannel(channel: ChannelEntry): Settings {
	return { ...defaultSettings(), channels: [channel], defaultChannel: channel.id };
}
