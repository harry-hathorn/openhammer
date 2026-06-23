import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ParsedArgs } from "./cli/args.ts";
import { type CommandIo, dispatch, runCli } from "./cli.ts";
import { type ChannelEntry, defaultSettings, loadSettings, type Settings } from "./config/settings.ts";
import { BANNER } from "./tui/banner.ts";

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

	it("no command (null) delegates to boot (the default) and signals running", async () => {
		let booted = false;
		const code = await dispatch(parsed(null), {
			boot: async () => {
				booted = true;
			},
		});
		expect(booted).toBe(true);
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

	it("`config set <unknown section>` is a usage error (exit 2) — no wizard, no write", async () => {
		await withTempHome(async (home) => {
			seedSettings(home, defaultSettings());
			const err = recordingStream();
			const code = await dispatch(parsed("config", ["set", "bogus"]), { stderr: err.stream });
			expect(code).toBe(2);
			expect(err.text()).toContain("Unknown section: bogus");
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
