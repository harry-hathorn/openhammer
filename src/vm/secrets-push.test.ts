// secrets-push tests — spec 29's session-start push. Two layers:
//
// 1. Push-sequence units over a recording fs-backend fake: the dual env files' bytes, the
//    per-file write-then-chmod-600 sequence (asserted as the exact runArgv order), the
//    missing-host-file skip, and the throw-on-backend-failure contract.
//
// 2. THE COMPOSITION FIXTURE (spec 29's explicit requirement): the two written files +
//    backend.ts's runShell prefix must COMPOSE — the env var visible in all three contexts
//    (environment.d parse, sourced file, prefixed exec). Hermetic, no VM: the push runs
//    against the recording fake, its bytes are materialized under a temp HOME at the
//    guest's relative layout, and REAL local bash proves the var in each context.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolBackend } from "../tools/backend.ts";
import { err, ok } from "../tools/result.ts";
import { GUEST_ENV_REL_PATH, GUEST_ENVIRONMENT_D_REL_PATH, pushSecrets, serializeEnvLines } from "./secrets-push.ts";

/** The fake VmBackend's guest home (the real one derives it from the manifest's user). */
const GUEST_HOME = "/home/sandbox";
const ENV_PATH = join(GUEST_HOME, GUEST_ENV_REL_PATH);
const CONF_PATH = join(GUEST_HOME, GUEST_ENVIRONMENT_D_REL_PATH);

interface RecordingBackend extends ToolBackend {
	/** Guest path → written bytes (the wire payload a real VmBackend would carry). */
	readonly writes: Map<string, Buffer>;
	/** fs.mkdir calls, in order (-p semantics — the recorded dirs). */
	readonly mkdirs: string[];
	/** runArgv calls, in order — the chmod sequence the perms contract rides. */
	readonly argvs: string[][];
}

function fakeBackend(
	options: { homedir?: string; failWriteFrom?: string; argvExitCode?: number } = {},
): RecordingBackend {
	const writes = new Map<string, Buffer>();
	const mkdirs: string[] = [];
	const argvs: string[][] = [];
	const notUsed = (): Promise<never> => Promise.reject(new Error("not used in this test"));
	return {
		kind: "vm",
		homedir: () => options.homedir ?? GUEST_HOME,
		fs: {
			readFile: notUsed,
			access: notUsed,
			stat: notUsed,
			readdir: notUsed,
			writeFile: async (path, data) => {
				if (path === options.failWriteFrom) return err(new Error("guest disk full"));
				writes.set(path, Buffer.from(data));
				return ok(undefined);
			},
			mkdir: async (path) => {
				mkdirs.push(path);
				return ok(undefined);
			},
			exists: async () => ok(false),
		},
		runShell: notUsed,
		runArgv: async (bin, args) => {
			argvs.push([bin, ...args]);
			return { exitCode: options.argvExitCode ?? 0, timedOut: false };
		},
		probe: () => false,
		probeFlag: () => false,
		overflowPath: () => "/tmp/.openhammer/unused.log",
		close: async () => {},
		writes,
		mkdirs,
		argvs,
	};
}

describe("serializeEnvLines", () => {
	it("emits the store's exact format: keys SORTED, `KEY=value` lines", () => {
		expect(serializeEnvLines({ ZED: "1", ANTHROPIC_API_KEY: "sk-ant-test" })).toBe(
			"ANTHROPIC_API_KEY=sk-ant-test\nZED=1\n",
		);
		expect(serializeEnvLines({})).toBe("");
	});

	it("splits values on the FIRST `=` only (the store's parse rule, mirrored on write)", () => {
		expect(serializeEnvLines({ WITH_EQUALS: "a=b=c" })).toBe("WITH_EQUALS=a=b=c\n");
	});
});

describe("pushSecrets — the push sequence", () => {
	it("writes BOTH env files with identical sorted bytes and chmods 600 each — the dual injection", async () => {
		const backend = fakeBackend();
		const report = await pushSecrets(backend, { env: { ZED: "1", ANTHROPIC_API_KEY: "sk-ant-test" }, files: [] });

		const bytes = "ANTHROPIC_API_KEY=sk-ant-test\nZED=1\n";
		expect(backend.writes.get(ENV_PATH)?.toString("utf8")).toBe(bytes);
		expect(backend.writes.get(CONF_PATH)?.toString("utf8")).toBe(bytes);
		expect(backend.mkdirs).toEqual([join(GUEST_HOME, ".openhammer"), join(GUEST_HOME, ".config/environment.d")]);
		expect(backend.argvs).toEqual([
			["chmod", "600", ENV_PATH],
			["chmod", "600", CONF_PATH],
		]);
		expect(report).toEqual({ envPairs: 2, filesPushed: 0, filesSkipped: [] });
	});

	it("pushes each credential file to its mapped guest path — host bytes via the default read, then chmod 600", async () => {
		const hostDir = mkdtempSync(join(tmpdir(), "openhammer-push-host-"));
		try {
			const credentialsPath = join(hostDir, ".credentials.json");
			const netrcPath = join(hostDir, ".netrc");
			writeFileSync(credentialsPath, '{"token": "t"}');
			writeFileSync(netrcPath, "machine example.com login me password p\n");
			const backend = fakeBackend();
			const report = await pushSecrets(backend, {
				env: {},
				files: [
					{ hostPath: credentialsPath, guestPath: "/home/sandbox/.claude/.credentials.json" },
					{ hostPath: netrcPath, guestPath: "/home/sandbox/.netrc" },
				],
			});

			expect(report.filesPushed).toBe(2);
			expect(backend.writes.get("/home/sandbox/.claude/.credentials.json")?.toString("utf8")).toBe('{"token": "t"}');
			expect(backend.writes.get("/home/sandbox/.netrc")?.toString("utf8")).toBe(
				"machine example.com login me password p\n",
			);
			// The full sequence: the two env files first, then the store's files in order.
			expect(backend.argvs).toEqual([
				["chmod", "600", ENV_PATH],
				["chmod", "600", CONF_PATH],
				["chmod", "600", "/home/sandbox/.claude/.credentials.json"],
				["chmod", "600", "/home/sandbox/.netrc"],
			]);
		} finally {
			rmSync(hostDir, { recursive: true, force: true });
		}
	});

	it("a missing host file is a REPORTED skip, not an error — the other file still pushes", async () => {
		const hostDir = mkdtempSync(join(tmpdir(), "openhammer-push-host-"));
		try {
			const existsPath = join(hostDir, "exists.key");
			const missingPath = join(hostDir, "missing.key");
			writeFileSync(existsPath, "key material");
			const backend = fakeBackend();
			const report = await pushSecrets(backend, {
				env: {},
				files: [
					{ hostPath: existsPath, guestPath: "/home/sandbox/exists.key" },
					{ hostPath: missingPath, guestPath: "/home/sandbox/missing.key" },
				],
			});

			expect(report.filesPushed).toBe(1);
			expect(report.filesSkipped).toEqual([{ hostPath: missingPath, reason: expect.stringContaining("ENOENT") }]);
			expect(backend.writes.has("/home/sandbox/missing.key")).toBe(false);
			expect(backend.writes.get("/home/sandbox/exists.key")?.toString("utf8")).toBe("key material");
			expect(backend.argvs).not.toContainEqual(["chmod", "600", "/home/sandbox/missing.key"]);
		} finally {
			rmSync(hostDir, { recursive: true, force: true });
		}
	});

	it("an injected host read rides deps.readHostFile; its failure is a skip with its reason", async () => {
		const backend = fakeBackend();
		const pushed = await pushSecrets(
			backend,
			{ env: {}, files: [{ hostPath: "/host/cred", guestPath: "/home/sandbox/cred" }] },
			{ readHostFile: async () => Buffer.from("injected") },
		);
		expect(backend.writes.get("/home/sandbox/cred")?.toString("utf8")).toBe("injected");
		expect(pushed.filesPushed).toBe(1);

		const denied = fakeBackend();
		const skipped = await pushSecrets(
			denied,
			{ env: {}, files: [{ hostPath: "/host/cred", guestPath: "/home/sandbox/cred" }] },
			{
				readHostFile: async () => {
					throw new Error("EACCES: permission denied");
				},
			},
		);
		expect(skipped).toEqual({
			envPairs: 0,
			filesPushed: 0,
			filesSkipped: [{ hostPath: "/host/cred", reason: "EACCES: permission denied" }],
		});
		expect(denied.writes.has("/home/sandbox/cred")).toBe(false);
	});

	it("an empty store is a zero-effect push: empty files, no credential ops", async () => {
		const backend = fakeBackend();
		const report = await pushSecrets(backend, { env: {}, files: [] });
		expect(report).toEqual({ envPairs: 0, filesPushed: 0, filesSkipped: [] });
		expect(backend.writes.get(ENV_PATH)?.toString("utf8")).toBe("");
		expect(backend.writes.get(CONF_PATH)?.toString("utf8")).toBe("");
		expect(backend.argvs).toEqual([
			["chmod", "600", ENV_PATH],
			["chmod", "600", CONF_PATH],
		]);
	});

	it("a backend fs failure throws with the guest path (the wiring decides fatal vs logged)", async () => {
		const backend = fakeBackend({ failWriteFrom: ENV_PATH });
		await expect(pushSecrets(backend, { env: { KEY: "value" }, files: [] })).rejects.toThrow(
			`secrets push: cannot write ${ENV_PATH}: guest disk full`,
		);
	});

	it("a non-zero chmod throws with the exit and the guest's stderr", async () => {
		const backend = fakeBackend({ argvExitCode: 2 });
		// The fake's runArgv collects no stderr — the message degrades to the exit code alone.
		await expect(pushSecrets(backend, { env: { KEY: "value" }, files: [] })).rejects.toThrow(
			`secrets push: chmod 600 ${ENV_PATH} exited 2`,
		);
	});
});

describe("composition — the dual injection is provable (spec 29's requirement)", () => {
	it("the two pushed files + the runShell prefix surface one value in all three env contexts (real bash)", async () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-compose-"));
		try {
			const value = "spike-20260912-compose";
			// The push against the recording fs — the bytes a real VmBackend puts on the wire.
			const backend = fakeBackend();
			const report = await pushSecrets(backend, {
				env: { OH_COMPOSITION_PROOF: value, OH_WITH_EQUALS: "a=b=c" },
				files: [],
			});
			expect(report.envPairs).toBe(2);

			// Materialize exactly what the push wrote, at the same paths under a temp HOME —
			// `~` then expands to the temp HOME inside bash: the guest's layout, host-grown.
			for (const [guestPath, data] of backend.writes) {
				const hostPath = join(home, guestPath.slice(GUEST_HOME.length));
				mkdirSync(dirname(hostPath), { recursive: true });
				writeFileSync(hostPath, data);
			}
			// The two written files carry the store's exact sorted KEY=value bytes, identical.
			const envBytes = readFileSync(join(home, GUEST_ENV_REL_PATH), "utf8");
			const confBytes = readFileSync(join(home, GUEST_ENVIRONMENT_D_REL_PATH), "utf8");
			expect(envBytes).toBe(`OH_COMPOSITION_PROOF=${value}\nOH_WITH_EQUALS=a=b=c\n`);
			expect(confBytes).toBe(envBytes);

			const bash = (script: string): string | undefined =>
				spawnSync("bash", ["-c", script], { env: { ...process.env, HOME: home }, encoding: "utf8" }).stdout;

			// Context 1 — environment.d: replicate systemd's parse. The user manager reads
			// KEY=value LINES itself (systemd-environment-d-generator); this loop is that
			// parse — split on the FIRST `=` (IFS== read's leftover fields rejoin with `=`),
			// deliberately NOT a shell source. (The manager reads the file at START, so the
			// live proof needed a reboot — 22-measured gate 4; this pins the file's parse.)
			const fromEnvironmentD = bash(
				'while IFS== read -r k v; do case "$k" in ""|"#"*) ;; *) export "$k=$v";; esac; ' +
					'done < ~/.config/environment.d/openhammer.conf; printf "%s" "$OH_COMPOSITION_PROOF|$OH_WITH_EQUALS"',
			);
			// Context 2 — the sourced file (26d's ENV_SOURCE_LINE shape: interactive shells).
			const fromSourcedFile = bash(
				'[ -f ~/.openhammer/env ] && . ~/.openhammer/env; printf "%s" "$OH_COMPOSITION_PROOF|$OH_WITH_EQUALS"',
			);
			// Context 3 — the runShell prefix (backend.ts's RUN_SHELL_SCRIPT env line): the
			// non-interactive ssh context, `set -a` exporting while it sources.
			const fromPrefixedExec = bash(
				"set -a; [ ! -f ~/.openhammer/env ] || . ~/.openhammer/env; set +a; " +
					'printf "%s" "$OH_COMPOSITION_PROOF|$OH_WITH_EQUALS"',
			);

			// One value, every context — including the `=`-carrying pair (split on FIRST `=`).
			expect(fromEnvironmentD).toBe(`${value}|a=b=c`);
			expect(fromSourcedFile).toBe(`${value}|a=b=c`);
			expect(fromPrefixedExec).toBe(`${value}|a=b=c`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
