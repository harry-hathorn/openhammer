/**
 * Tier-2 CLI E2E (specs 17n + 17o + 15). Proves the real `openhammer` CLI — run
 * via `tsx src/cli.ts` (the bin is `dist/cli.js`; tsx exercises the identical
 * code path with **no dist build dependency**, mirroring boot.e2e) — as a genuine
 * subprocess: `doctor`/`channel list` print the README banner on an interactive
 * (TTY) launch + the right exit code; `channel list` piped **omits** the banner
 * (proving the `isTTY` gate from the other side); `start` delegates to the
 * spec-14 boot path and exits 0 on a clean `SIGTERM`; an unknown command exits 2.
 *
 * Banner gating: `runCli` prints the README ASCII banner only when
 * `process.stdout.isTTY === true` (spec 17n). A piped child is not a TTY, so the
 * banner-present assertions run the child under a real pseudo-terminal via
 * util-linux `script` — the no-`node-pty`-dependency way to give a Node child a
 * TTY. `stty cols 200 rows 50` widens the PTY so the banner's 89-column lines do
 * not wrap; the PTY's ONLCR (`\n`→`\r\n`) is normalized before asserting, and the
 * **full** `BANNER` constant round-trips intact (verified empirically). When
 * `script` is absent the banner-present tests skip (non-blocking) — the
 * banner-on-TTY logic itself is unit-tested in `src/cli/cli.test.ts` +
 * `src/tui/banner.test.ts`; this suite is the end-to-end proof the bytes reach
 * stdout through the real CLI process.
 *
 * Hermetic: an isolated `HOME` forces settings/credentials/credential into a
 * temp `~/.openhammer`, `MCP_ROOT_DIR` is a temp dir, and the parent
 * `MCP_AUTH_TOKEN` is stripped so the credential-file path is the one exercised.
 * `PATH` is inherited so `tsx`/`rg`/`fd` resolve.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isToolAvailable } from "../../src/tools/bin.ts";
import { BANNER } from "../../src/tui/banner.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const CLI_TS = join(REPO_ROOT, "src/cli.ts");
// util-linux `script` allocates a PTY for the child so `runCli`'s `isTTY` check
// passes and the README banner prints. Present on Linux (dev/CI/container); the
// banner-present tests `skipIf` it is absent (non-blocking).
const HAS_SCRIPT = isToolAvailable("script");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A captured child exit: utf8 stdout/stderr + the exit code/signal. */
interface CliResult {
	stdout: string;
	stderr: string;
	code: number | null;
	signal: NodeJS.Signals | null;
}

/** Hermetic child env: isolated `HOME`, quiet logs, parent `MCP_AUTH_TOKEN` stripped. */
function childEnv(home: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.MCP_AUTH_TOKEN;
	env.HOME = home;
	env.LOG_LEVEL = "warn";
	return env;
}

/**
 * Collect a child's utf8 stdout/stderr and resolve its exit code/signal. For PTY
 * runs the PTY's ONLCR (`\n`→`\r\n`) is normalized on stdout so byte-equality
 * holds against `BANNER`.
 */
function captureExit(child: ChildProcess): Promise<CliResult> {
	let stdout = "";
	let stderr = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderr += chunk;
	});
	return new Promise((resolve) => {
		child.once("exit", (code, signal) => {
			resolve({ stdout: stdout.replace(/\r\n/g, "\n").replace(/\r/g, ""), stderr, code, signal });
		});
	});
}

/**
 * Run `openhammer <args>` under a real PTY (util-linux `script`) so the child's
 * stdout is a TTY and `runCli` prints the README banner. `stty cols 200 rows 50`
 * widens the PTY so the banner's wide lines don't wrap. `script -e` forwards the
 * child's exit code. The `-c` command string is fixed (repo-rooted paths +
 * literal subcommands) — the documented shell-string exception (like `bash` and
 * the tunnel tools); no user-controlled operand is interpolated.
 */
function runCliPty(args: readonly string[], home: string): Promise<CliResult> {
	const command = `stty cols 200 rows 50; "${TSX}" "${CLI_TS}" ${args.join(" ")}`;
	const child = spawn("script", ["-qec", command, "/dev/null"], {
		env: childEnv(home),
		cwd: REPO_ROOT,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return captureExit(child);
}

/** Run `openhammer <args>` with piped stdio (NOT a TTY — no README banner). */
function runCliPiped(args: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
	const child = spawn(TSX, [CLI_TS, ...args], { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	return captureExit(child);
}

/** Bind + release an ephemeral loopback port so the `start` child can listen on it. */
function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

/** Resolve the child's exit code, rejecting if it outlives the timeout. */
function awaitExit(child: ChildProcess, timeoutMs = 10_000): Promise<number | null> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`child did not exit within ${timeoutMs}ms`)), timeoutMs);
		child.once("exit", (code) => {
			clearTimeout(timer);
			resolve(code);
		});
	});
}

/** Best-effort teardown: SIGTERM the child if still alive, then SIGKILL as a backstop. */
async function ensureDead(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	try {
		await awaitExit(child, 5_000);
	} catch {
		child.kill("SIGKILL");
		await awaitExit(child, 2_000).catch(() => {});
	}
}

/** Poll `/health` until 200, failing fast if the child dies mid-boot. */
async function waitForReady(
	child: ChildProcess,
	baseUrl: string,
	stdout: () => string,
	stderr: () => string,
	timeoutMs = 20_000,
): Promise<void> {
	let exited = false;
	let exitCode: number | null = null;
	let exitSignal: NodeJS.Signals | null = null;
	child.once("exit", (code, signal) => {
		exited = true;
		exitCode = code;
		exitSignal = signal;
	});
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (exited) {
			throw new Error(
				`cli exited before /health responded (code=${exitCode}, signal=${exitSignal})\n--- stdout ---\n${stdout()}\n--- stderr ---\n${stderr()}`,
			);
		}
		try {
			const res = await fetch(`${baseUrl}/health`);
			if (res.ok) return;
		} catch {
			// Not listening yet — keep polling.
		}
		await sleep(150);
	}
	throw new Error(
		`cli did not become healthy within ${timeoutMs}ms\n--- stdout ---\n${stdout()}\n--- stderr ---\n${stderr()}`,
	);
}

/** Fresh isolated `HOME`, cleaned up by the caller's `finally`. */
function tempHome(): string {
	return mkdtempSync(join(tmpdir(), "oh-cli-home-"));
}

describe("Tier-2 CLI: real `openhammer` subprocess", () => {
	// `runCli` prints the README banner only on a TTY (spec 17n). A piped child is
	// not a TTY, so these run under a real PTY (util-linux `script`); `skipIf` it
	// is absent (non-blocking — banner-on-TTY is unit-tested in cli.test.ts).
	it.skipIf(!HAS_SCRIPT)(
		"`doctor` prints the README banner + diagnostics and exits 0",
		{ timeout: 30_000 },
		async () => {
			const home = tempHome();
			try {
				const result = await runCliPty(["doctor"], home);
				expect(result.code).toBe(0);
				expect(result.stdout).toContain(BANNER);
				expect(result.stdout).toContain("Ran 5 check(s)");
				expect(result.stdout).toContain("[pass]");
				// Fresh HOME: no jwtSecret yet (no env, never booted) → an advisory warn.
				expect(result.stdout).toContain("[warn]");
				expect(result.stdout).toContain("oauth-jwt-secret:");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	it.skipIf(!HAS_SCRIPT)(
		"`channel list` prints the README banner + the empty-list message and exits 0",
		{ timeout: 30_000 },
		async () => {
			const home = tempHome();
			try {
				const result = await runCliPty(["channel", "list"], home);
				expect(result.code).toBe(0);
				expect(result.stdout).toContain(BANNER);
				expect(result.stdout).toContain("No channels configured. Run `openhammer channel add` to add one.");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		},
	);

	it("`channel list` piped (no TTY) omits the banner but prints the command output, exits 0", {
		timeout: 30_000,
	}, async () => {
		const home = tempHome();
		try {
			const result = await runCliPiped(["channel", "list"], childEnv(home));
			expect(result.code).toBe(0);
			expect(result.stdout).not.toContain(BANNER);
			expect(result.stdout).toContain("No channels configured");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("an unknown command writes usage to stderr and exits 2", { timeout: 30_000 }, async () => {
		const home = tempHome();
		try {
			const result = await runCliPiped(["frobnicate"], childEnv(home));
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("Unknown command: frobnicate");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	it("`start` boots the server (GET /health 200) and exits 0 on a clean SIGTERM", { timeout: 30_000 }, async () => {
		const home = tempHome();
		const rootDir = mkdtempSync(join(tmpdir(), "oh-cli-root-"));
		const port = await getFreePort();
		const env = childEnv(home);
		env.PORT = String(port);
		env.HOST = "127.0.0.1";
		env.MCP_ROOT_DIR = rootDir;
		const child = spawn(TSX, [CLI_TS, "start"], { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		try {
			await waitForReady(
				child,
				`http://127.0.0.1:${port}`,
				() => stdout,
				() => stderr,
			);
			const res = await fetch(`http://127.0.0.1:${port}/health`);
			expect(res.status).toBe(200);
			child.kill("SIGTERM");
			expect(await awaitExit(child)).toBe(0);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
