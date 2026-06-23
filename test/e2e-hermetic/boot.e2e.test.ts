/**
 * Tier-2 boot E2E (specs 14 + 15). Proves the **real entrypoint** — `tsx
 * src/main.ts` — boots as a genuine subprocess: it reads env, mints/reuses the
 * credential, binds Fastify, prints the startup banner, and survives until a
 * signal arrives. Where the Tier-1 suites (`harness.canary`, `mcp.e2e`) drive an
 * in-process `buildFastify`, this suite drives the OS process: a free port is
 * handed to the child, `/health` is polled for readiness, the banner's printed
 * token is asserted on, and `SIGINT`/`SIGTERM` are observed to exit 0.
 *
 * Hermetic by construction: an isolated `HOME` forces `ensureToken` to mint into
 * a temp `~/.openhammer` (so token reuse is real, not a parent-process artifact),
 * `MCP_ROOT_DIR` is a temp dir, and any parent `MCP_AUTH_TOKEN` is stripped so
 * the credential-file path is the one exercised. The tunnel-child reap is
 * covered hermetically by its determinism-safe slice — booting `--tunnel` with
 * `cloudflared` **absent** (the dev/CI default): `startTunnel` returns `null`
 * before spawning, main.ts logs the localhost-only notice, and the clean
 * shutdown is asserted. A live `cloudflared` child can't be reaped
 * deterministically here, so that branch is `skipIf`-gated to `T-tunnel-e2e`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { type AddressInfo, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { Credential } from "../../src/auth/token.ts";
import { type Settings, saveSettings, settingsPath } from "../../src/config/settings.ts";
import { isToolAvailable } from "../../src/tools/bin.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const MAIN_TS = join(REPO_ROOT, "src/main.ts");

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Bind + release an ephemeral loopback port so the child can listen on it. */
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

/** Pull the printed token out of the startup banner — the line after "Bearer token". */
function extractToken(stdout: string): string | undefined {
	const lines = stdout.split("\n");
	const idx = lines.findIndex((line) => line.includes("Bearer token"));
	const tokenLine = idx >= 0 ? lines[idx + 1] : undefined;
	return tokenLine === undefined ? undefined : tokenLine.trim();
}

interface BootResult {
	child: ChildProcess;
	baseUrl: string;
	port: number;
	stdout: () => string;
	stderr: () => string;
}

interface BootOptions {
	home: string;
	rootDir: string;
	tunnel?: boolean;
}

/**
 * Spawn the real entrypoint via `tsx` on a free port with a hermetic env, then
 * poll `/health` until the child is serving. Fails fast (with captured output)
 * if the child exits before it is ready. Returns the child + an `stdout`/`stderr`
 * accessor for banner/token/warn assertions.
 */
async function boot(opts: BootOptions): Promise<BootResult> {
	const port = await getFreePort();
	const args = [MAIN_TS];
	if (opts.tunnel) args.push("--tunnel");
	// Curate the child env: isolated HOME (temp `~/.openhammer`), free port, temp
	// tool root, quiet logs, and the parent `MCP_AUTH_TOKEN` stripped so the
	// credential-file path is the one exercised (no override leaks from the test
	// runner). PATH is inherited so `tsx` + the bash/grep tools still resolve.
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.MCP_AUTH_TOKEN;
	env.PORT = String(port);
	env.HOST = "127.0.0.1";
	env.MCP_ROOT_DIR = opts.rootDir;
	env.LOG_LEVEL = "warn";
	env.HOME = opts.home;

	const child = spawn(TSX, args, { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	let stdoutBuf = "";
	let stderrBuf = "";
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		stdoutBuf += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		stderrBuf += chunk;
	});

	const baseUrl = `http://127.0.0.1:${port}`;
	await waitForReady(
		child,
		baseUrl,
		() => stdoutBuf,
		() => stderrBuf,
	);
	return { child, baseUrl, port, stdout: () => stdoutBuf, stderr: () => stderrBuf };
}

/** Poll `/health` until 200, but fail fast if the child dies mid-boot (EADDRINUSE, thrown boot error, …). */
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
				`entrypoint exited before /health responded (code=${exitCode}, signal=${exitSignal})\n--- stdout ---\n${stdout()}\n--- stderr ---\n${stderr()}`,
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
		`entrypoint did not become healthy within ${timeoutMs}ms\n--- stdout ---\n${stdout()}\n--- stderr ---\n${stderr()}`,
	);
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

/** Wait for the banner token to flush to stdout (listen resolves before `printStartup` runs). */
async function waitForToken(stdout: () => string, timeoutMs = 5_000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const token = extractToken(stdout());
		if (token) return token;
		await sleep(50);
	}
	throw new Error(`token never appeared in the startup banner\n--- stdout ---\n${stdout()}`);
}

/** Fresh isolated `HOME` + tool root, cleaned up by the caller's `finally`. */
function tempDirs(): { home: string; rootDir: string } {
	return {
		home: mkdtempSync(join(tmpdir(), "oh-boot-home-")),
		rootDir: mkdtempSync(join(tmpdir(), "oh-boot-root-")),
	};
}

describe("Tier-2 boot: real entrypoint via tsx", () => {
	it("boots and serves GET /health 200 (no auth)", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const { child, baseUrl } = await boot({ home, rootDir });
		try {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ status: "ok" });
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("reuses the persisted bearer token across two boots", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		try {
			// Boot #1: no credential yet → ensureToken mints + writes credential.json.
			const first = await boot({ home, rootDir });
			const token1 = await waitForToken(first.stdout);
			await ensureDead(first.child);
			expect(token1).toBeTruthy();

			// Boot #2: same HOME → ensureToken reads the credential back verbatim.
			const second = await boot({ home, rootDir });
			const token2 = await waitForToken(second.stdout);
			await ensureDead(second.child);

			expect(token2).toBe(token1);
			const cred = JSON.parse(readFileSync(join(home, ".openhammer", "credential.json"), "utf8")) as Credential;
			expect(cred.token).toBe(token1);
		} finally {
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("shuts down cleanly on SIGINT (exit 0)", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const { child } = await boot({ home, rootDir });
		try {
			child.kill("SIGINT");
			expect(await awaitExit(child)).toBe(0);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("shuts down cleanly on SIGTERM (exit 0)", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const { child } = await boot({ home, rootDir });
		try {
			child.kill("SIGTERM");
			expect(await awaitExit(child)).toBe(0);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	// `--tunnel` with cloudflared absent is the only determinism-safe slice of the
	// tunnel path for the hermetic trio: startTunnel returns null before spawning,
	// so there is no real child to leak/reap. A live cloudflared child (and thus the
	// real "no orphan tunnel child" assertion) belongs to the gated T-tunnel-e2e.
	it.skipIf(isToolAvailable("cloudflared"))(
		"continues localhost-only under --tunnel when cloudflared is absent, then shuts down cleanly",
		{ timeout: 30_000 },
		async () => {
			const { home, rootDir } = tempDirs();
			const { child, baseUrl, stdout } = await boot({ home, rootDir, tunnel: true });
			try {
				const res = await fetch(`${baseUrl}/health`);
				expect(res.status).toBe(200);
				expect(stdout()).toContain("continuing localhost-only");
				child.kill("SIGTERM");
				expect(await awaitExit(child)).toBe(0);
			} finally {
				await ensureDead(child);
				rmSync(home, { recursive: true, force: true });
				rmSync(rootDir, { recursive: true, force: true });
			}
		},
	);

	// The registry path (17q): a persisted static channel as `defaultChannel` is
	// resolved at boot and its declared URL is printed in the banner. Deterministic
	// — a static channel's `resolve` is pure (no spawn, no network) — so this is the
	// hermetic proof that `main.ts` funnels `--channel`/`defaultChannel` through the
	// channel registry instead of calling `startTunnel` directly. A live channel's
	// real round-trip is the gated T-tunnel-e2e / T-ngrok-channel-e2e.
	it("resolves a persisted static channel via the registry and prints its URL", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const publicUrl = "https://openhammer-static.example.test";
		const settings: Settings = {
			version: 1,
			channels: [{ id: "deployed", kind: "static-url", mode: "static", options: { publicUrl } }],
			defaultChannel: "deployed",
			mcp: { allowedClients: [] },
		};
		saveSettings(settingsPath(home), settings);
		const { child, baseUrl, stdout } = await boot({ home, rootDir });
		try {
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			expect(stdout()).toContain(`Tunnel URL:         ${publicUrl}/mcp`);
			child.kill("SIGTERM");
			expect(await awaitExit(child)).toBe(0);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
