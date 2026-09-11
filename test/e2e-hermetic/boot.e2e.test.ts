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
import { type AddressInfo, createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";

import type { Credential } from "../../src/auth/token.ts";
import { defaultVmSettings, type Settings, saveSettings, settingsPath } from "../../src/config/settings.ts";
import { isToolAvailable } from "../../src/tools/bin.ts";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSX = join(REPO_ROOT, "node_modules/.bin/tsx");
const MAIN_TS = join(REPO_ROOT, "src/main.ts");
// 27f's VM driver: the REAL main() with the VM boot seams injected (a scripted
// gate + a scripted-ssh guest) — see the driver's module header.
const VM_DRIVER_TS = join(REPO_ROOT, "test/e2e-hermetic/vm-boot-driver.ts");

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
			vm: defaultVmSettings(),
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

// ---- vm modes (spec 27f) — the REAL main() over an injected scripted gate ----

/** One scripted VM posture the driver can boot into (vm-boot-driver.ts's OH_TEST_VM_MODE). */
type VmDriverMode = "preflight-fail" | "never-ready" | "ready";

interface VmDriverOptions {
	home: string;
	/** The GUEST root main resolves (a guest absolute path in vm modes — 27b). */
	rootDir: string;
	mode: VmDriverMode;
	/** The not-ready message the gate answers (never-ready mode). */
	message?: string;
	/** The scripted runShell stdout (ready mode). */
	output?: string;
}

/**
 * Spawn the VM driver WITHOUT waiting for readiness — the preflight-fail posture
 * exits before it ever listens, so its test needs the raw child + buffers. Env is
 * curated like `boot()` (isolated HOME, free port, quiet logs, MCP_AUTH_TOKEN
 * stripped) plus the whole `MCP_VM_*` surface removed: the driver is the single
 * source of the vm-mode story, so a stray runner env var can never change the boot
 * under test.
 */
function spawnVmDriver(opts: VmDriverOptions, port: number): BootResult {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.MCP_AUTH_TOKEN;
	for (const key of Object.keys(env)) {
		if (key.startsWith("MCP_VM_")) delete env[key];
	}
	env.PORT = String(port);
	env.HOST = "127.0.0.1";
	env.MCP_ROOT_DIR = opts.rootDir;
	env.LOG_LEVEL = "warn";
	env.HOME = opts.home;
	env.OH_TEST_VM_MODE = opts.mode;
	if (opts.message !== undefined) env.OH_TEST_VM_MESSAGE = opts.message;
	if (opts.output !== undefined) env.OH_TEST_VM_OUTPUT = opts.output;

	const child = spawn(TSX, [VM_DRIVER_TS], { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
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
	return {
		child,
		baseUrl: `http://127.0.0.1:${port}`,
		port,
		stdout: () => stdoutBuf,
		stderr: () => stderrBuf,
	};
}

/** Boot the VM driver to /health-readiness (the listening postures). */
async function bootVm(opts: VmDriverOptions): Promise<BootResult> {
	const port = await getFreePort();
	const result = spawnVmDriver(opts, port);
	await waitForReady(result.child, result.baseUrl, result.stdout, result.stderr);
	return result;
}

/** The first content block's text out of a `callTool` result (the mcp.e2e narrowing, "" on none). */
function firstText(result: unknown): string {
	if (typeof result !== "object" || result === null || !("content" in result)) return "";
	const { content } = result;
	if (!Array.isArray(content)) return "";
	const block = content[0];
	if (
		block !== null &&
		typeof block === "object" &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	) {
		return block.text;
	}
	return "";
}

/**
 * Connect to the booted server's status socket and collect its NDJSON lines
 * (the status-socket.test.ts helper, trimmed to the e2e's needs) — used to read
 * a connection's dump (channel-state + vm-state + recorded history).
 */
function collectSocketLines(path: string): {
	lines: string[];
	waitFor: (n: number, ms?: number) => Promise<void>;
	close: () => void;
} {
	const lines: string[] = [];
	let buf = "";
	const waiters: Array<{ n: number; resolve: () => void }> = [];
	const socket = createConnection(path);
	socket.on("data", (chunk) => {
		buf += chunk.toString("utf8");
		let idx = buf.indexOf("\n");
		while (idx >= 0) {
			lines.push(buf.slice(0, idx));
			buf = buf.slice(idx + 1);
			idx = buf.indexOf("\n");
		}
		for (const w of waiters.splice(0)) {
			if (lines.length >= w.n) w.resolve();
			else waiters.push(w); // not yet satisfied — keep it for the next chunk
		}
	});
	return {
		lines,
		waitFor(n, ms = 5000) {
			if (lines.length >= n) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`timed out waiting for ${n} lines (got ${lines.length})`)),
					ms,
				);
				waiters.push({
					n,
					resolve: () => {
						clearTimeout(timer);
						resolve();
					},
				});
			});
		},
		close: () => socket.destroy(),
	};
}

/** Drive one `bash` tools/call over the FULL HTTP stack (the mcp.e2e client pattern). */
async function callBash(baseUrl: string, token: string, command: string): Promise<{ isError: boolean; text: string }> {
	const client = new Client({ name: "vm-boot-e2e", version: "0.0.0" }, { capabilities: {} });
	// The bearer rides every request via `requestInit` headers — no authProvider,
	// so the SDK never tries the OAuth discovery flow.
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: { headers: { authorization: `Bearer ${token}` } },
	});
	await client.connect(transport);
	try {
		const result: unknown = await client.callTool({ name: "bash", arguments: { command } });
		const isError = typeof result === "object" && result !== null && "isError" in result && result.isError === true;
		return { isError, text: firstText(result) };
	} finally {
		await client.close();
	}
}

describe("Tier-2 boot: vm modes (spec 27f — real main, scripted gate, zero KVM/QEMU)", () => {
	it("preflight miss → exit 1 with preflight's ONE line on stderr (no stack)", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const port = await getFreePort();
		const driver = spawnVmDriver({ home, rootDir, mode: "preflight-fail" }, port);
		try {
			// The driver owns main's entrypoint contract: the catch prints the
			// one-liner + exits 1 — exactly src/main.ts's auto-run block.
			expect(await awaitExit(driver.child)).toBe(1);
			const lines = driver.stderr().trim().split("\n");
			expect(lines).toHaveLength(1);
			expect(lines[0]).toBe(
				"OpenHammer failed to start: vm driver: preflight refused (the scripted miss — 27f's one-line exit pin)",
			);
		} finally {
			await ensureDead(driver.child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("real entrypoint, real preflight: a vm boot without the prerequisites is the one-line non-zero failure", {
		timeout: 30_000,
	}, async () => {
		const { home, rootDir } = tempDirs();
		const port = await getFreePort();
		const env: NodeJS.ProcessEnv = { ...process.env };
		delete env.MCP_AUTH_TOKEN;
		for (const key of Object.keys(env)) {
			if (key.startsWith("MCP_VM_")) delete env[key];
		}
		env.PORT = String(port);
		env.HOST = "127.0.0.1";
		env.MCP_ROOT_DIR = rootDir; // a host temp path, reinterpreted as the guest root (27b)
		env.LOG_LEVEL = "warn";
		env.HOME = home; // an empty HOME: no goldens can exist under it
		env.MCP_VM_MODE = "vm";
		const child = spawn(TSX, [MAIN_TS], { env, cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
		let stderrBuf = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderrBuf += chunk;
		});
		try {
			expect(await awaitExit(child)).toBe(1);
			const lines = stderrBuf.trim().split("\n");
			// WHICH preflight row fires depends on the machine (qemu present or
			// not — under an empty HOME the golden row is the usual first miss);
			// every row is one of preflight's actionable one-liners.
			expect(lines).toHaveLength(1);
			expect(lines[0]).toMatch(/^OpenHammer failed to start: /);
			expect(lines[0]).toMatch(/(qemu|OVMF|KVM|golden image|MCP_VM_)/);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("booting sandbox: /health serves instantly; a bash call gets the actionable booting err through the full stack", {
		timeout: 30_000,
	}, async () => {
		const { home, rootDir } = tempDirs();
		const message = "sandbox booting, 3s of 180s — retry";
		const { child, baseUrl, stdout } = await bootVm({ home, rootDir, mode: "never-ready", message });
		try {
			// Server health ≠ VM health (spec 27): the eager-async spawn never
			// blocked listen(), so /health answers while no guest exists.
			const res = await fetch(`${baseUrl}/health`);
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ status: "ok" });
			expect(stdout()).toContain("vm-driver: start (mode=never-ready)"); // the spawn was kicked off

			const token = await waitForToken(stdout);
			const call = await callBash(baseUrl, token, "uname -a");
			expect(call.isError).toBe(true);
			expect(call.text).toContain(message);
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("ready sandbox: a bash call executes against the guest backend through the full stack", {
		timeout: 30_000,
	}, async () => {
		const { home, rootDir } = tempDirs();
		const { child, baseUrl, stdout } = await bootVm({
			home,
			rootDir,
			mode: "ready",
			output: "hello-from-the-fake-guest",
		});
		try {
			const token = await waitForToken(stdout);
			const call = await callBash(baseUrl, token, "echo guest");
			expect(call.isError).toBe(false);
			expect(call.text).toBe("hello-from-the-fake-guest");
			// The delegation reached the scripted guest with the command verbatim.
			expect(stdout()).toContain("vm-driver: guest runShell: echo guest");

			// 27h wiring: the status socket's dump carries the vm-state line of the
			// settled boot. The socket binds AFTER the eager-async start() (the
			// driver's gate settles synchronously on start), so this pins the
			// latest-state getter — the dump reflects the post-boot state, not a
			// bind-time copy (the driver's scripted status: ready, session
			// "vm-driver", ssh :41733, no phase, no error).
			const dump = collectSocketLines(join(home, ".openhammer", "openhammer.sock"));
			try {
				await dump.waitFor(2); // the vm-state dump + at least the bash call's event
				expect(JSON.parse(dump.lines[0] ?? "{}")).toMatchObject({
					type: "vm-state",
					state: "ready",
					sessionId: "vm-driver",
					phase: null,
					sshPort: 41733,
					error: null,
				});
			} finally {
				dump.close();
			}
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});

	it("SIGINT teardown: stop serving FIRST, then stop the sandbox — exit 0", { timeout: 30_000 }, async () => {
		const { home, rootDir } = tempDirs();
		const { child, stdout } = await bootVm({ home, rootDir, mode: "ready" });
		try {
			child.kill("SIGINT");
			expect(await awaitExit(child)).toBe(0);
			// The VM stop observed the HTTP server already refusing connections —
			// fastify.close() ran BEFORE the backend's close() reached the gate.
			expect(stdout()).toContain("vm-driver: stop: health=closed");
		} finally {
			await ensureDead(child);
			rmSync(home, { recursive: true, force: true });
			rmSync(rootDir, { recursive: true, force: true });
		}
	});
});
