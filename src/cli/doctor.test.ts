import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureJwtSecret } from "../auth/oauth/clients.ts";
import {
	type ChannelEntry,
	type ChannelMode,
	defaultSettings,
	defaultVmSettings,
	type Settings,
	type VmSettings,
} from "../config/settings.ts";
import { err, ok } from "../tools/result.ts";
import type { ChannelProvider } from "../tunnel/index.ts";
import type { PreflightDeps } from "../vm/preflight.ts";
import { ISO_SHA256, ISO_URL } from "../vm/provision/iso.ts";
import type { GoldenSummary } from "../vm/provision/manage.ts";
import type { Manifest } from "../vm/provision/snapshot.ts";
import { missingBinaryHint, QEMU_BIN } from "../vm/qemu/process.ts";
import {
	createBinaryCheck,
	createChannelCheck,
	createConfigCheck,
	createCredentialsCheck,
	createDefaultChecks,
	createJwtSecretCheck,
	createVmChecks,
	createVmFootprintCheck,
	createVmGoldenCheck,
	createVmPreflightCheck,
	createVmRamCheck,
	createVmRootCheck,
	type DiagnosticReport,
	doctorCommand,
	formatDoctor,
	parseMemAvailable,
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
	it("builds the ten built-ins in a stable order — the vm family registered last", () => {
		const checks = createDefaultChecks({ isAvailable: () => true });
		expect(checks.map((c) => c.id)).toEqual([
			"config",
			"credentials",
			"oauth-jwt-secret",
			"rg",
			"fd",
			"vm-preflight",
			"vm-golden",
			"vm-ram",
			"vm-footprint",
			"vm-root",
		]);
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

// ---- the vm check family (spec 27d) -------------------------------------------

const GIB = 1024 ** 3;
const NEWEST_GOLDEN = "golden-4.0.3-20260901-120000";
const GOLDEN_REMEDY = "run: openhammer vm install && openhammer vm provision && openhammer vm snapshot";

/** A fresh temp HOME (removed by the caller's `finally`). */
function vmHome(): string {
	return mkdtempSync(join(tmpdir(), "oh-doctor-vm-"));
}

/**
 * The vm-family test scope: a fresh temp HOME installed as `process.env.HOME` for
 * the checks' LAZY defaults (homedir-based path resolution reads it at run time)
 * and removed after — everything else is per-test injection.
 */
async function withVmHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
	const home = vmHome();
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		return await fn(home);
	} finally {
		process.env.HOME = prev;
		rmSync(home, { recursive: true, force: true });
	}
}

/** Settings with the vm section's mode set (everything else at defaults). */
function vmSettings(mode: VmSettings["mode"], over: Partial<VmSettings> = {}): Settings {
	return { ...defaultSettings(), vm: { ...defaultVmSettings(), mode, ...over } };
}

/** A valid unencrypted manifest (the snapshot.ts shape) — the real readManifest must accept it. */
function manifestOf(id: string): Manifest {
	return {
		id,
		flavor: "base",
		agent: "claude",
		guestUser: "sandbox",
		rootDir: "/home/sandbox",
		isoVersion: "4.0.3",
		isoUrl: ISO_URL,
		isoSha256: ISO_SHA256,
		diskVirtualSizeBytes: 42_949_672_960,
		provisionScriptHashes: null,
		builtAt: "2026-09-01T12:00:00Z",
		encrypt: false,
	};
}

/** Seed one golden dir under the home (a REAL manifest.json, so the real readers validate it). */
function seedGolden(home: string, id: string, corrupt = false): void {
	const dir = join(home, ".openhammer", "vm", "images", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), corrupt ? "{ not json" : `${JSON.stringify(manifestOf(id), null, 2)}\n`);
}

/** 26f's `GoldenSummary` row (vm-golden's listing seam). */
function goldenRow(over: Partial<GoldenSummary> = {}): GoldenSummary {
	return {
		id: NEWEST_GOLDEN,
		manifestOk: true,
		flavor: "base",
		guestUser: "sandbox",
		encrypt: false,
		builtAt: "2026-09-01T12:00:00Z",
		isoVersion: "4.0.3",
		diskVirtualSizeBytes: 42_949_672_960,
		diskActualBytes: Math.round(6.6 * GIB),
		note: null,
		...over,
	};
}

/** Every preflight seam at its passing value (preflight.test.ts's harness shape). */
function greenPreflight(home: string): Omit<PreflightDeps, "homeDir"> {
	const anyStats = statSync(home);
	return {
		platform: "linux",
		qemuOnPath: () => true,
		qemuImgOnPath: () => true,
		stat: () => anyStats,
		access: () => undefined,
		freeBytes: () => 100 * GIB,
	};
}

/** `/proc/meminfo` text with `MemAvailable` at exactly the given bytes. */
function meminfoOf(bytes: number): string {
	return `MemTotal:  32000000 kB\nMemAvailable:  ${Math.floor(bytes / 1024)} kB\n`;
}

describe("vm check family", () => {
	it("is entirely absent on a default isolated HOME (off, no golden) — the built-in five unchanged", async () => {
		await withVmHome(async () => {
			// Everything at production defaults (only env isolated + binaries faked): the
			// config/credentials paths and the vm checks' home all resolve lazily via HOME.
			const checks = createDefaultChecks({ env: {}, isAvailable: () => true });
			const reports = await runDiagnostics({ settings: defaultSettings(), checks });
			expect(reports.map((r) => r.id)).toEqual(["config", "credentials", "oauth-jwt-secret", "rg", "fd"]);
			// Absent checks carry no count: the default install still reports exactly five.
			expect(formatDoctor(reports).startsWith("Ran 5 check(s): 0 fail, 1 warn, 4 pass.")).toBe(true);
		});
	});

	it("runs the whole family alongside the built-ins in vm mode — present checks counted", async () => {
		await withVmHome(async (home) => {
			seedGolden(home, NEWEST_GOLDEN);
			const checks = createDefaultChecks({
				isAvailable: () => true,
				settings: vmSettings("vm"),
				env: {},
				homeDir: () => home,
				preflight: greenPreflight(home),
				listGoldens: () => Promise.resolve([goldenRow()]),
				readMeminfo: () => meminfoOf(16 * GIB),
				duOf: () => Promise.resolve(0),
			});
			const reports = await runDiagnostics({ settings: vmSettings("vm"), checks });
			expect(reports.map((r) => r.id)).toEqual([
				"config",
				"credentials",
				"oauth-jwt-secret",
				"rg",
				"fd",
				"vm-preflight",
				"vm-golden",
				"vm-ram",
				"vm-footprint",
				"vm-root",
			]);
			// The one warn is oauth-jwt-secret (isolated env, never booted) — every vm row passes.
			expect(formatDoctor(reports).startsWith("Ran 10 check(s): 0 fail, 1 warn, 9 pass.")).toBe(true);
		});
	});

	it("resolves lazily — repointing the homeDir seam after construction changes the world the checks see", async () => {
		const homeA = vmHome();
		const homeB = vmHome();
		try {
			seedGolden(homeB, NEWEST_GOLDEN); // B: a golden (and a vm tree); A: nothing
			let home = homeA;
			const checks = createVmChecks({
				env: {},
				settings: vmSettings("off"), // off: presence rides on the golden/tree
				homeDir: () => home,
				listGoldens: (h) => Promise.resolve(h === homeB ? [goldenRow()] : []),
			});
			const byId = new Map(checks.map((c) => [c.id, c]));
			expect(byId.get("vm-preflight")!.present()).toBe(false);
			expect(byId.get("vm-golden")!.present()).toBe(false);
			expect(byId.get("vm-footprint")!.present()).toBe(false);
			// Repoint the SAME instances at B (no rebuild): every predicate flips.
			home = homeB;
			expect(byId.get("vm-preflight")!.present()).toBe(true);
			expect(byId.get("vm-footprint")!.present()).toBe(true);
			expect(await byId.get("vm-golden")!.run()).toEqual({
				status: "pass",
				message: "golden-4.0.3-20260901-120000 (flavor base, 6.6G actual, built 2026-09-01)",
			});
		} finally {
			rmSync(homeA, { recursive: true, force: true });
			rmSync(homeB, { recursive: true, force: true });
		}
	});

	it("a present() that throws defers to run()'s fail — a malformed MCP_VM_MODE never crashes doctor", async () => {
		await withVmHome(async (home) => {
			const checks = createVmChecks({
				env: { MCP_VM_MODE: "bogus" },
				settings: vmSettings("off"),
				homeDir: () => home,
			});
			// vm-footprint is tree-based (absent on the bare home); the four mode-based
			// checks defer their throw to run(), where safeRun makes it the fail row.
			const reports = await runDiagnostics({ settings: defaultSettings(), checks });
			expect(reports.map((r) => r.id)).toEqual(["vm-preflight", "vm-golden", "vm-ram", "vm-root"]);
			for (const report of reports) {
				expect(report.result.status).toBe("fail");
				expect(report.result.message).toContain('MCP_VM_MODE must be one of off, vm, agent (got "bogus")');
			}
		});
	});
});

describe("vm-preflight check", () => {
	it("fails with preflight's one-liner when the boot gate fails", async () => {
		await withVmHome(async (home) => {
			seedGolden(home, NEWEST_GOLDEN);
			const check = createVmPreflightCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				preflight: { ...greenPreflight(home), qemuOnPath: () => false },
			});
			expect(check.present()).toBe(true);
			expect(await check.run()).toEqual({ status: "fail", message: missingBinaryHint(QEMU_BIN) });
		});
	});

	it("passes with the mode + guest root when the gate is green (vm and agent)", async () => {
		await withVmHome(async (home) => {
			seedGolden(home, NEWEST_GOLDEN);
			for (const mode of ["vm", "agent"] as const) {
				const result = await createVmPreflightCheck({
					env: {},
					settings: vmSettings(mode),
					homeDir: () => home,
					preflight: greenPreflight(home),
				}).run();
				expect(result).toEqual({ status: "pass", message: `${mode} mode active — guest root /home/sandbox` });
			}
		});
	});

	it("is absent when mode is off and no golden exists; idle-but-present when one does", async () => {
		await withVmHome(async (home) => {
			const check = createVmPreflightCheck({ env: {}, settings: vmSettings("off"), homeDir: () => home });
			expect(check.present()).toBe(false);
			seedGolden(home, NEWEST_GOLDEN);
			expect(check.present()).toBe(true); // the SAME instance — presence re-resolves at call time
			expect(await check.run()).toEqual({ status: "pass", message: "vm mode off — VM stack idle" });
		});
	});
});

describe("vm-golden check", () => {
	it("warns with the build pipeline when a vm mode has no golden", async () => {
		await withVmHome(async (home) => {
			const check = createVmGoldenCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				listGoldens: () => Promise.resolve([]),
			});
			expect(check.present()).toBe(true);
			expect(await check.run()).toEqual({ status: "warn", message: `no golden image — ${GOLDEN_REMEDY}` });
		});
	});

	it("passes with the newest golden's row (flavor, live-measured actual, built date)", async () => {
		await withVmHome(async (home) => {
			const result = await createVmGoldenCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				listGoldens: () => Promise.resolve([goldenRow()]),
			}).run();
			expect(result).toEqual({
				status: "pass",
				message: "golden-4.0.3-20260901-120000 (flavor base, 6.6G actual, built 2026-09-01)",
			});
		});
	});

	it("drops the actual clause when qemu-img could not measure (0 = unmeasured)", async () => {
		await withVmHome(async (home) => {
			const result = await createVmGoldenCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				listGoldens: () => Promise.resolve([goldenRow({ diskActualBytes: 0 })]),
			}).run();
			expect(result).toEqual({
				status: "pass",
				message: "golden-4.0.3-20260901-120000 (flavor base, built 2026-09-01)",
			});
		});
	});

	it("warns naming a corrupt newest golden (never silently skipped past)", async () => {
		await withVmHome(async (home) => {
			const result = await createVmGoldenCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				listGoldens: () => Promise.resolve([goldenRow({ manifestOk: false })]),
			}).run();
			expect(result).toEqual({
				status: "warn",
				message: `newest golden ${NEWEST_GOLDEN} has a corrupt manifest — ${GOLDEN_REMEDY}`,
			});
		});
	});
});

describe("vm-ram check", () => {
	it("warns just under the memory+2GiB line, with the freeze hint (warn is strictly-below)", async () => {
		await withVmHome(async (home) => {
			const check = createVmRamCheck({
				env: {},
				settings: vmSettings("vm", { memoryMb: 4096 }),
				homeDir: () => home,
				readMeminfo: () => meminfoOf(6 * GIB - 1),
			});
			expect(await check.run()).toEqual({
				status: "warn",
				message:
					"free RAM 6G, vm mode wants 6G — close heavy apps (the guest freezes rather than dies when it thrashes)",
			});
		});
	});

	it("passes AT the exact boundary (free == memory + 2GiB)", async () => {
		await withVmHome(async (home) => {
			const check = createVmRamCheck({
				env: {},
				settings: vmSettings("vm", { memoryMb: 4096 }),
				homeDir: () => home,
				readMeminfo: () => meminfoOf(6 * GIB),
			});
			expect(await check.run()).toEqual({ status: "pass", message: "free RAM 6G (vm mode wants 6G)" });
		});
	});

	it("passes with room to spare (fractional want formats exactly)", async () => {
		await withVmHome(async (home) => {
			const check = createVmRamCheck({
				env: {},
				settings: vmSettings("vm", { memoryMb: 2560 }), // 2.5G guest + 2G headroom
				homeDir: () => home,
				readMeminfo: () => meminfoOf(16 * GIB),
			});
			expect(await check.run()).toEqual({ status: "pass", message: "free RAM 16G (vm mode wants 4.5G)" });
		});
	});

	it("passes unmeasurable when /proc/meminfo is unreadable", async () => {
		await withVmHome(async (home) => {
			const check = createVmRamCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				readMeminfo: () => undefined,
			});
			expect(await check.run()).toEqual({ status: "pass", message: "free RAM unmeasurable (no /proc/meminfo)" });
		});
	});

	it("parseMemAvailable reads the MemAvailable kB line into bytes", () => {
		expect(parseMemAvailable("MemTotal:  32000000 kB\nMemAvailable:  2048 kB\nBuffers:  1 kB\n")).toBe(2048 * 1024);
	});

	it("parseMemAvailable is undefined without a MemAvailable line", () => {
		expect(parseMemAvailable("MemTotal:  32000000 kB\n")).toBeUndefined();
	});
});

describe("vm-footprint check", () => {
	it("is absent when the vm tree does not exist (mode does not matter)", async () => {
		await withVmHome(async (home) => {
			const check = createVmFootprintCheck({ env: {}, settings: vmSettings("vm"), homeDir: () => home });
			expect(check.present()).toBe(false);
		});
	});

	it("passes at the 40G budget boundary (warn is strictly-over)", async () => {
		await withVmHome(async (home) => {
			seedGolden(home, NEWEST_GOLDEN); // creates ~/.openhammer/vm — the tree exists
			const check = createVmFootprintCheck({
				env: {},
				settings: vmSettings("vm"),
				homeDir: () => home,
				duOf: () => Promise.resolve(40 * GIB),
			});
			expect(check.present()).toBe(true);
			expect(await check.run()).toEqual({ status: "pass", message: "vm tree is 40G" });
		});
	});

	it("warns over the budget with the gc hint", async () => {
		await withVmHome(async (home) => {
			seedGolden(home, NEWEST_GOLDEN);
			const check = createVmFootprintCheck({
				env: {},
				settings: vmSettings("off"), // bytes on disk are on disk whatever the mode says
				homeDir: () => home,
				duOf: () => Promise.resolve(45 * GIB + 1),
			});
			expect(await check.run()).toEqual({ status: "warn", message: "vm tree is 45G — run: openhammer vm gc" });
		});
	});
});

describe("vm-root check", () => {
	it("is absent in off mode and shows the effective guest root in vm modes", async () => {
		await withVmHome(async (home) => {
			const off = createVmRootCheck({ env: {}, settings: vmSettings("off"), homeDir: () => home });
			expect(off.present()).toBe(false);
			const result = await createVmRootCheck({ env: {}, settings: vmSettings("vm"), homeDir: () => home }).run();
			expect(result).toEqual({
				status: "pass",
				message: "effective guest root: /home/sandbox (MCP_ROOT_DIR reinterpreted in vm modes)",
			});
		});
	});

	it("reinterprets a set MCP_ROOT_DIR as the guest path (the 27b rule)", async () => {
		await withVmHome(async (home) => {
			const result = await createVmRootCheck({
				env: { MCP_ROOT_DIR: "/home/me/work" },
				settings: vmSettings("agent"),
				homeDir: () => home,
			}).run();
			expect(result).toEqual({
				status: "pass",
				message: "effective guest root: /home/me/work (MCP_ROOT_DIR reinterpreted in vm modes)",
			});
		});
	});
});
