import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureJwtSecret } from "../auth/oauth/clients.ts";
import { type ChannelEntry, type ChannelMode, defaultSettings, type Settings } from "../config/settings.ts";
import { err, ok } from "../tools/result.ts";
import type { ChannelProvider } from "../tunnel/index.ts";
import {
	createBinaryCheck,
	createChannelCheck,
	createConfigCheck,
	createCredentialsCheck,
	createDefaultChecks,
	createJwtSecretCheck,
	type DiagnosticReport,
	doctorCommand,
	formatDoctor,
	runDiagnostics,
} from "./doctor.ts";

/** A fresh temp file path under a temp dir (the dir is removed by `cleanup`). */
function tempFile(name: string): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "oh-doctor-"));
	return { path: join(dir, name), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A fake live/static provider with controllable availability + probe. */
function fakeProvider(opts: {
	kind?: ChannelProvider["kind"];
	mode: ChannelMode;
	isAvailable?: ChannelProvider["isAvailable"];
	probe?: ChannelProvider["probe"];
}): ChannelProvider {
	return {
		kind: opts.kind ?? "ngrok",
		mode: opts.mode,
		fields: [],
		isAvailable: opts.isAvailable ?? (async () => true),
		probe: opts.probe,
	};
}

describe("config check", () => {
	it("passes when config.json is absent (defaults are fine)", async () => {
		const { path, cleanup } = tempFile("config.json");
		try {
			const result = await createConfigCheck(path).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("absent");
		} finally {
			cleanup();
		}
	});

	it("passes when config.json is valid JSON and a valid settings doc", async () => {
		const { path, cleanup } = tempFile("config.json");
		try {
			writeFileSync(path, JSON.stringify(defaultSettings()));
			const result = await createConfigCheck(path).run();
			expect(result).toEqual({ status: "pass", message: "config.json is a valid settings document" });
		} finally {
			cleanup();
		}
	});

	it("fails when config.json is not valid JSON", async () => {
		const { path, cleanup } = tempFile("config.json");
		try {
			writeFileSync(path, "not valid json {{{");
			const result = await createConfigCheck(path).run();
			expect(result.status).toBe("fail");
			expect(result.message).toContain("not valid JSON");
		} finally {
			cleanup();
		}
	});

	it("fails when config.json is valid JSON but not a valid settings doc", async () => {
		const { path, cleanup } = tempFile("config.json");
		try {
			writeFileSync(path, JSON.stringify({ channels: "not-an-array" }));
			const result = await createConfigCheck(path).run();
			expect(result.status).toBe("fail");
			expect(result.message).toContain("not a valid settings document");
		} finally {
			cleanup();
		}
	});
});

describe("credentials check", () => {
	it("passes when credentials.json is absent (no secrets stored)", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			const result = await createCredentialsCheck(path).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("absent");
		} finally {
			cleanup();
		}
	});

	it("passes when credentials.json perms are 0600", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			writeFileSync(path, "{}");
			chmodSync(path, 0o600); // umask-proof: chmod bypasses the process umask.
			const result = await createCredentialsCheck(path).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("0600");
		} finally {
			cleanup();
		}
	});

	it("warns when credentials.json perms are too open", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			writeFileSync(path, "{}");
			chmodSync(path, 0o644); // umask-proof: forces group/other-readable.
			const result = await createCredentialsCheck(path).run();
			expect(result.status).toBe("warn");
			expect(result.message).toContain("expected 0600");
		} finally {
			cleanup();
		}
	});
});

describe("binary check", () => {
	it("passes when the binary is present", async () => {
		expect(await createBinaryCheck("rg", () => true).run()).toEqual({ status: "pass", message: "rg present" });
	});

	it("fails when rg is absent (grep unavailable)", async () => {
		const result = await createBinaryCheck("rg", () => false).run();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("grep");
	});

	it("fails when fd is absent (find unavailable)", async () => {
		const result = await createBinaryCheck("fd", () => false).run();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("find");
	});
});

describe("jwt secret check", () => {
	it("passes (env source) when OAUTH_JWT_SECRET is set", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			const result = await createJwtSecretCheck({
				env: { OAUTH_JWT_SECRET: "env-secret" },
				credentialsPath: path,
			}).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("OAUTH_JWT_SECRET");
			// The env value wins before any persistence.
			expect(existsSync(path)).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("passes (persisted source) when a jwtSecret is in credentials.json", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			ensureJwtSecret(path); // mint + persist a real jwtSecret
			const result = await createJwtSecretCheck({ env: {}, credentialsPath: path }).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("credentials.json");
		} finally {
			cleanup();
		}
	});

	it("warns when neither env nor a persisted secret is present — and does NOT mint", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			const result = await createJwtSecretCheck({ env: {}, credentialsPath: path }).run();
			expect(result.status).toBe("warn");
			expect(result.message).toContain("minted on first use");
			// Read-only: the check must not have created the secrets file.
			expect(existsSync(path)).toBe(false);
		} finally {
			cleanup();
		}
	});

	it("treats a whitespace-only env value as unset (falls back to the persisted secret)", async () => {
		const { path, cleanup } = tempFile("credentials.json");
		try {
			ensureJwtSecret(path);
			const result = await createJwtSecretCheck({ env: { OAUTH_JWT_SECRET: "   " }, credentialsPath: path }).run();
			expect(result.status).toBe("pass");
			expect(result.message).toContain("credentials.json");
		} finally {
			cleanup();
		}
	});
});

describe("createDefaultChecks", () => {
	it("builds the five built-in checks in a stable order", () => {
		const checks = createDefaultChecks({ isAvailable: () => true });
		expect(checks.map((c) => c.id)).toEqual(["config", "credentials", "oauth-jwt-secret", "rg", "fd"]);
	});

	it("threads the injected isAvailable into the binary checks", async () => {
		const checks = createDefaultChecks({ isAvailable: () => false });
		const rg = await checks.find((c) => c.id === "rg")!.run();
		expect(rg.status).toBe("fail");
	});

	it("threads the injected env into the jwt-secret check (env-set → pass)", async () => {
		const checks = createDefaultChecks({ isAvailable: () => true, env: { OAUTH_JWT_SECRET: "x" } });
		const jwt = await checks.find((c) => c.id === "oauth-jwt-secret")!.run();
		expect(jwt.status).toBe("pass");
		expect(jwt.message).toContain("OAUTH_JWT_SECRET");
	});
});

describe("channel check", () => {
	const entry = (over: Partial<ChannelEntry> = {}): ChannelEntry => ({
		id: "chan1",
		kind: "ngrok",
		mode: "live",
		options: {},
		...over,
	});

	it("live + available → pass", async () => {
		const provider = fakeProvider({ mode: "live", isAvailable: async () => true });
		const result = await createChannelCheck(entry(), { getChannel: () => provider }).run();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("ready");
	});

	it("live + not available → warn", async () => {
		const provider = fakeProvider({ mode: "live", isAvailable: async () => false });
		const result = await createChannelCheck(entry(), { getChannel: () => provider }).run();
		expect(result.status).toBe("warn");
		expect(result.message).toContain("not available");
	});

	it("merges secrets from getCredentials into the options bag (secret-gated availability)", async () => {
		let seen: Record<string, string> = {};
		const provider = fakeProvider({
			mode: "live",
			isAvailable: async (o) => {
				seen = o;
				return o.authtoken === "real-secret";
			},
		});
		// entry.options is empty; the authtoken comes only from getCredentials.
		const result = await createChannelCheck(entry(), {
			getChannel: () => provider,
			getCredentials: () => ({ authtoken: "real-secret" }),
		}).run();
		expect(seen.authtoken).toBe("real-secret");
		expect(result.status).toBe("pass");
	});

	it("static + reachable → pass", async () => {
		const provider = fakeProvider({ mode: "static", probe: async () => ok(undefined) });
		const result = await createChannelCheck(entry({ kind: "nginx", mode: "static" }), {
			getChannel: () => provider,
		}).run();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("reachable");
	});

	it("static + unreachable → warn (surfaces the probe message)", async () => {
		const provider = fakeProvider({ mode: "static", probe: async () => err(new Error("/health returned 502")) });
		const result = await createChannelCheck(entry({ kind: "nginx", mode: "static" }), {
			getChannel: () => provider,
		}).run();
		expect(result.status).toBe("warn");
		expect(result.message).toContain("/health returned 502");
	});

	it("static + no probe → pass (configured)", async () => {
		const provider = fakeProvider({ mode: "static" });
		const result = await createChannelCheck(entry({ kind: "nginx", mode: "static" }), {
			getChannel: () => provider,
		}).run();
		expect(result.status).toBe("pass");
		expect(result.message).toContain("configured");
	});

	it("unknown kind (no provider registered) → fail", async () => {
		const result = await createChannelCheck(entry(), { getChannel: () => undefined }).run();
		expect(result.status).toBe("fail");
		expect(result.message).toContain("no provider registered");
	});
});

describe("runDiagnostics", () => {
	it("runs the static checks then the per-channel checks, in order", async () => {
		const settings: Settings = {
			...defaultSettings(),
			channels: [
				{ id: "aaa", kind: "cloudflare", mode: "live", options: {} },
				{ id: "bbb", kind: "nginx", mode: "static", options: { publicUrl: "https://x.invalid" } },
			],
		};
		const provider = fakeProvider({ mode: "live", isAvailable: async () => true });
		const reports = await runDiagnostics({
			settings,
			checks: [
				{ id: "static-a", run: async () => ({ status: "pass", message: "a" }) },
				{ id: "static-b", run: async () => ({ status: "pass", message: "b" }) },
			],
			getChannel: () => provider,
			getCredentials: () => ({}),
		});
		expect(reports.map((r) => r.id)).toEqual(["static-a", "static-b", "channel:aaa", "channel:bbb"]);
	});

	it("isolates a throwing check — a throw becomes a fail, not an abort", async () => {
		const reports = await runDiagnostics({
			settings: defaultSettings(),
			checks: [
				{ id: "boom", run: async () => Promise.reject(new Error("kaboom")) },
				{ id: "ok", run: async () => ({ status: "pass", message: "fine" }) },
			],
		});
		expect(reports).toHaveLength(2);
		expect(reports[0]!.result.status).toBe("fail");
		expect(reports[0]!.result.message).toContain("kaboom");
		expect(reports[1]!.result.status).toBe("pass");
	});

	it("with no channels and an empty static set runs nothing", async () => {
		const reports = await runDiagnostics({ settings: defaultSettings(), checks: [] });
		expect(reports).toEqual([]);
	});
});

describe("formatDoctor", () => {
	const report = (id: string, status: DiagnosticReport["result"]["status"], message = "msg"): DiagnosticReport => ({
		id,
		result: { status, message },
	});

	it("groups results fail → warn → pass with a summary line", () => {
		const text = formatDoctor([
			report("config", "pass"),
			report("rg", "fail", "missing"),
			report("credentials", "warn", "perms"),
			report("fd", "pass"),
		]);
		expect(text.startsWith("Ran 4 check(s): 1 fail, 1 warn, 2 pass.")).toBe(true);
		// Order: fail block before warn before pass.
		expect(text.indexOf("[fail]")).toBeLessThan(text.indexOf("[warn]"));
		expect(text.indexOf("[warn]")).toBeLessThan(text.indexOf("[pass]"));
		expect(text).toContain("  rg: missing");
		expect(text).toContain("  credentials: perms");
	});

	it("omits empty status groups", () => {
		const text = formatDoctor([report("config", "pass"), report("rg", "pass")]);
		expect(text).not.toContain("[fail]");
		expect(text).not.toContain("[warn]");
		expect(text).toContain("[pass]");
	});

	it("handles an empty report", () => {
		expect(formatDoctor([])).toBe("Ran 0 check(s): 0 fail, 0 warn, 0 pass.");
	});
});

describe("doctorCommand", () => {
	function recordingStdout() {
		const chunks: string[] = [];
		const stream = {
			write(c: string | Uint8Array): boolean {
				chunks.push(typeof c === "string" ? c : Buffer.from(c).toString());
				return true;
			},
		};
		return { stream, text: () => chunks.join("") };
	}

	it("prints the grouped report and exits 0 when all checks pass", async () => {
		const out = recordingStdout();
		const code = await doctorCommand(
			{ stdout: out.stream },
			{
				settings: defaultSettings(),
				checks: [{ id: "config", run: async () => ({ status: "pass", message: "ok" }) }],
			},
		);
		expect(code).toBe(0);
		expect(out.text()).toContain("Ran 1 check(s)");
		expect(out.text()).toContain("[pass]");
	});

	it("exits 1 when any check fails (a warn alone does not fail)", async () => {
		const out = recordingStdout();
		const code = await doctorCommand(
			{ stdout: out.stream },
			{
				settings: defaultSettings(),
				checks: [
					{ id: "config", run: async () => ({ status: "pass", message: "ok" }) },
					{ id: "credentials", run: async () => ({ status: "warn", message: "perms" }) },
					{ id: "rg", run: async () => ({ status: "fail", message: "missing" }) },
				],
			},
		);
		expect(code).toBe(1);
		expect(out.text()).toContain("[fail]");
		expect(out.text()).toContain("[warn]");
	});
});
