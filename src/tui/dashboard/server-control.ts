/**
 * Server lifecycle for the dashboard (spec 19e). The dashboard is a *view over
 * the running server* that can also manage the server's lifecycle: {@link ensureServer}
 * starts the server as a child if it isn't already reachable, and the returned
 * {@link ServerControl.stop} tears it down on dashboard exit — making `openhammer`
 * (no args, in a terminal) the single entry that runs both the dashboard and the
 * server, with no orphaned child on quit.
 *
 * **Result spine** (spec 19 line 36): `ensureServer`/`stop` return `Result` — a
 * spawn failure, an early child exit (`EADDRINUSE` surfaces as a non-zero exit
 * code, not a throw), or a ready-timeout is an *expected* failure the dashboard
 * surfaces (stderr + exit 1), never a crash. The graceful cases (the server is
 * already up → attach; the child is already gone → no-op stop) are successes.
 *
 * **Spawn hygiene** (AGENTS.md): the child is spawned with an **arg array**
 * (`[process.execPath, mainPath, ...args]`, no shell), inheriting `process.env`,
 * so forwarded `--tunnel`/`--channel` reach the server with no shell interpolation.
 * The server entry is `dist/main.js` (resolved next to this module); a missing
 * entry is a clear `err` ("run `npm run build`") rather than a confusing ENOENT —
 * the dashboard runs via the built `openhammer` bin, so `dist/main.js` coexists.
 *
 * **No orphan** (spec 19 acceptance): `stop()` sends SIGTERM, awaits the child's
 * exit (with a SIGKILL backstop after a grace period), and is idempotent. A
 * process `exit` safety net (registered on spawn, removed on `stop`) best-effort
 * SIGKILLs a still-live child if the dashboard itself exits abnormally — so an
 * external `kill` or an uncaught throw cannot strand a server child (SIGKILL of
 * the parent is the one unavoidable orphan case, as for any process).
 *
 * **Injection seams** ({@link ServerControlDeps}) follow the `11a`/`13`/`17b`–`19d`
 * precedent — `spawn`/`probeHealth`/`exists`/`token`/timers are all injectable so
 * the unit tests exercise every branch (attach / spawn-and-ready / early-exit /
 * timeout / stop / idempotent) hermetically, with no real server, port, or
 * credential file.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureToken } from "../../auth/token.ts";
import { type Config, loadConfig } from "../../config.ts";
import { err, ok, type Result } from "../../tools/result.ts";

/** Default server entry, resolved next to this compiled module → `dist/main.js`. */
export function defaultMainPath(): string {
	// `dist/tui/dashboard/server-control.js` → two dirs up → `dist/main.js`.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "main.js");
}

/**
 * Build the argv to forward to the spawned server from the launch flags. Only
 * `--tunnel`/`--channel` are server-meaningful (port/host come from the shared env);
 * `start`-time channel selection is the server's job, so the dashboard forwards
 * these verbatim. Pure — unit-tested without a server.
 */
export function serverArgs(tunnel: boolean, channel: string | undefined): string[] {
	const args: string[] = [];
	if (tunnel) args.push("--tunnel");
	if (channel !== undefined) args.push("--channel", channel);
	return args;
}

/**
 * The minimal child surface {@link ensureServer} needs. `node:child_process`'s
 * `ChildProcess` satisfies it; the unit tests inject a fake implementing it. Only
 * `once("exit")` (lifecycle) + `stderr` (diagnostics on early exit) are read — kept
 * structural (no `node:child_process` type import) so a fake is trivial, and there
 * is **no `as`** between the real child and this interface (method bivariance +
 * `Readable | null` → optional-`on` carry the assignability honestly).
 */
export interface ServerChild {
	readonly pid?: number;
	readonly killed: boolean;
	kill(signal?: NodeJS.Signals | number): boolean;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	stderr?: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
}

/** A started server handle: its endpoint + how to tear it down. */
export interface ServerControl {
	/** Did THIS control spawn the server (`true`) or attach to one already up (`false`)? */
	ownsServer: boolean;
	/** The local MCP endpoint, e.g. `http://127.0.0.1:3000/mcp`. */
	localUrl: string;
	/** The bearer token (for the status panel), or `null` if it could not be resolved. */
	token: string | null;
	/**
	 * Stop the spawned child if owned: SIGTERM → await exit (SIGKILL backstop after
	 * the grace period). Idempotent. A no-op (→ `ok`) when this control attached to
	 * an already-running server. `err` only if teardown itself throws (it does not
	 * for a well-behaved child — `kill` is best-effort and returns `false`, not
	 * throws, on an already-gone pid).
	 */
	stop(): Promise<Result<void, Error>>;
}

/** Injection seams for {@link ensureServer} (the `11a`/`13`/`17b`–`19d` precedent). */
export interface ServerControlDeps {
	/** Server entry (`dist/main.js`). Default: {@link defaultMainPath}. */
	mainPath?: string;
	/** Override the entry's existence check (default `existsSync`). Tests stub it. */
	exists?: (path: string) => boolean;
	/** Spawn the server child (default: `node <mainPath> [...args]`, env inherited). */
	spawn?: (mainPath: string, args: string[]) => ServerChild;
	/** Health probe (default: `GET <url>` → `res.ok`, `false` on throw/non-2xx). */
	probeHealth?: (url: string) => Promise<boolean>;
	/** Token for the status panel (default: `ensureToken(config)`, defensively `null`). */
	token?: string | null;
	/** Env for the child (default `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Extra argv forwarded to the server (e.g. `["--tunnel"]`). Default `[]`. */
	args?: string[];
	/** Max ms to wait for `/health` after spawn (default 10_000). */
	readyTimeoutMs?: number;
	/** `/health` poll interval in ms (default 250). */
	readyIntervalMs?: number;
	/** Grace ms after SIGTERM before SIGKILL on {@link ServerControl.stop} (default 3_000). */
	stopGraceMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_READY_INTERVAL_MS = 250;
const DEFAULT_STOP_GRACE_MS = 3_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Narrow an unknown catch value to its message (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Default health probe: `GET <url>` → `true` on 2xx, `false` on throw/non-2xx. */
async function defaultProbeHealth(url: string): Promise<boolean> {
	try {
		const res = await fetch(url);
		return res.ok;
	} catch {
		return false;
	}
}

/** Default spawn: `node <mainPath> [...args]`, stdin ignored, stdout/stderr piped, env inherited. */
function defaultSpawn(mainPath: string, args: string[], env: NodeJS.ProcessEnv): ServerChild {
	return spawn(process.execPath, [mainPath, ...args], {
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

/**
 * Resolve the bearer token for the status panel. Reuses {@link ensureToken} (the
 * single source the server itself resolves with), so the dashboard and the spawned
 * server agree: `MCP_AUTH_TOKEN` (env) short-circuits; else the credential file is
 * reused (and minted if absent — the spawned server reuses the same file). A throw
 * (unwritable credential dir) is swallowed → `null`: the spawned server surfaces the
 * real boot error (it calls `ensureToken` too); the dashboard just omits the token.
 */
async function resolveToken(config: Config, deps: ServerControlDeps): Promise<string | null> {
	if (deps.token !== undefined) return deps.token;
	try {
		const { token } = await ensureToken(config);
		return token;
	} catch (e) {
		void messageOf(e); // best-effort: the spawned server reports the real cause
		return null;
	}
}

/** Wait for `/health` to respond, racing the child's early exit + a deadline. */
async function waitForReady(
	child: ServerChild,
	healthUrl: string,
	probe: (url: string) => Promise<boolean>,
	getStderr: () => string,
	timeoutMs: number,
	intervalMs: number,
): Promise<Result<void, Error>> {
	// A mutable holder (not a `let`) so TS narrows the property reads correctly across
	// the `once` closure — a closure-assigned `let` defeats control-flow narrowing.
	const exited = {
		code: null as number | null,
		signal: null as NodeJS.Signals | null,
		did: false,
	};
	child.once("exit", (code, signal) => {
		exited.code = code;
		exited.signal = signal;
		exited.did = true;
	});
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (exited.did) {
			const why = exited.code !== null ? `exit code ${exited.code}` : `signal ${exited.signal}`;
			const log = getStderr().trim();
			return err(new Error(`server exited before ready (${why})${log ? `:\n${log}` : ""}`));
		}
		if (await probe(healthUrl)) return ok(undefined);
		if (Date.now() >= deadline) {
			return err(new Error(`server did not become ready within ${timeoutMs}ms`));
		}
		await sleep(intervalMs);
	}
}

/** Resolve `true` once the child exits, or `false` after `graceMs` (for the SIGKILL backstop). */
function waitForExit(child: ServerChild, graceMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		child.once("exit", () => {
			if (!settled) {
				settled = true;
				resolve(true);
			}
		});
		const timer = setTimeout(() => {
			if (!settled) {
				settled = true;
				resolve(false);
			}
		}, graceMs);
		void timer; // harmless if the child already exited (`settled` guards both paths)
	});
}

/** Best-effort SIGKILL of a child with a pid. `killed` only means "a signal was
 * sent" (Node sets it on any `kill()`), not "the child is dead" — so it is NOT a
 * guard here: the SIGKILL backstop must fire after a SIGTERM that the child
 * ignored (`killed === true` but still alive). `kill` returns `false` (ESRCH),
 * never throws, on an already-gone pid, so this is safe unconditionally. */
function killChild(child: ServerChild): void {
	if (child.pid !== undefined) child.kill("SIGKILL");
}

/**
 * Ensure the OpenHammer server is reachable at `config`'s port, spawning it as a
 * child if it isn't. Returns a {@link ServerControl} on success (owning the child
 * when it spawned one, or attaching when one was already up) or `err` for an
 * expected failure (missing entry, early child exit, ready-timeout) — never throws.
 *
 * The control's `stop()` tears a spawned child down (SIGTERM → SIGKILL backstop,
 * idempotent) and is a no-op when attached. A process `exit` safety net reaps a
 * still-live child if the dashboard exits abnormally, so no server orphans.
 */
export async function ensureServer(
	config: Config = loadConfig(),
	deps: ServerControlDeps = {},
): Promise<Result<ServerControl, Error>> {
	const base = `http://${config.host}:${config.port}`;
	const healthUrl = `${base}/health`;
	const localUrl = `${base}/mcp`;

	const probeHealth = deps.probeHealth ?? defaultProbeHealth;
	const token = await resolveToken(config, deps);

	// Already up? Attach — never spawn a second server (spec 19 line 18).
	if (await probeHealth(healthUrl)) {
		return ok({ ownsServer: false, localUrl, token, stop: async () => ok(undefined) });
	}

	// Spawn the server child.
	const mainPath = deps.mainPath ?? defaultMainPath();
	const exists = deps.exists ?? existsSync;
	if (!exists(mainPath)) {
		return err(new Error(`server entry not found: ${mainPath} (run \`npm run build\`)`));
	}
	const args = deps.args ?? [];
	const env = deps.env ?? process.env;
	const spawnChild = deps.spawn ?? ((mp: string, sp: string[]) => defaultSpawn(mp, sp, env));
	const child = spawnChild(mainPath, args);

	// Safety net: if the dashboard exits abnormally (external kill, uncaught throw),
	// best-effort SIGKILL a still-live child so it cannot orphan. Removed on `stop`.
	const safetyKill = (): void => killChild(child);
	process.once("exit", safetyKill);

	let stderrBuf = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderrBuf += chunk.toString("utf8");
	});

	const readyTimeoutMs = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
	const readyIntervalMs = deps.readyIntervalMs ?? DEFAULT_READY_INTERVAL_MS;
	const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;

	const ready = await waitForReady(child, healthUrl, probeHealth, () => stderrBuf, readyTimeoutMs, readyIntervalMs);
	if (!ready.ok) {
		// The child failed to become ready — reap it + drop the safety net.
		killChild(child);
		process.off("exit", safetyKill);
		return ready;
	}

	let stopped = false;
	const stop = async (): Promise<Result<void, Error>> => {
		if (stopped) return ok(undefined);
		stopped = true;
		process.off("exit", safetyKill);
		child.kill("SIGTERM");
		const exited = await waitForExit(child, stopGraceMs);
		if (!exited) killChild(child); // SIGKILL backstop for a child that ignores SIGTERM
		return ok(undefined);
	};
	return ok({ ownsServer: true, localUrl, token, stop });
}
