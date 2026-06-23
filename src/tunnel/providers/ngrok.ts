/**
 * The ngrok channel provider (spec 17i, **revised in 17u**) — a **live** channel
 * driven by the **`ngrok` system CLI**, not the `@ngrok/ngrok` SDK.
 *
 * The SDK's bundled core defaults to QUIC/UDP, which hangs on the dev network, and
 * its JS API exposes no transport knob to flip it; the system CLI works locally and
 * its local inspector API (`http://127.0.0.1:4040/api/tunnels`) returns the public
 * URL as JSON — so the provider reads the URL programmatically with **no
 * stdout-scraping**. Tradeoff: the operator needs the `ngrok` binary on PATH
 * (presence-checked, graceful `null` when absent — the same model `cloudflared` uses).
 *
 * The provider declares one **secret field** (`authtoken`) the channel-add wizard
 * collects and `setCredentials` persists. `isAvailable` is the cheap
 * `isToolAvailable("ngrok")` binary check — availability = "the CLI is installed",
 * full stop (the same presence-check as cloudflare); the authtoken is a
 * `start`/`probe` concern, validated then. `start` spawns `ngrok http <port>` with
 * the authtoken passed to the child as `NGROK_AUTHTOKEN` env (not a CLI arg — a
 * secret must never appear in a `ps` listing), polls the inspector API for
 * `tunnels[].public_url`, and lifts it into a {@link ChannelHandle} whose `stop`
 * kills the spawned process on shutdown. `start` resolves `null` for every failure
 * (no authtoken, absent binary, no URL in time, child death) — the unchanged
 * graceful-absent posture from spec 13, never a throw, so boot continues
 * localhost-only. `probe` is the wizard-time validation: spawn + URL + a short
 * `fetch(/health)` round-trip that surfaces a bad authtoken as `err` (where `start`
 * would silently fall back) before the channel is persisted.
 *
 * **Testability:** {@link createNgrokProvider} takes injectable `isAvailable`/`spawn`/
 * `fetch` deps + `inspectorUrl`/`timeoutMs`/`pollIntervalMs`/`probePort` knobs
 * (mirroring the `ensureToken`/`startTunnel`/`createCloudflareProvider` injection-arg
 * precedents) so the unit tests exercise start/probe hermetically. The spawn fake
 * runs a real `node -e` subprocess (real `.kill()`/`exitCode` plumbing, like
 * `cloudflare.test.ts`'s `fakeCloudflared`) while the public URL comes from an
 * injected fake `fetch` — the `:4040` model means the URL is HTTP, not stderr, so a
 * fake subprocess can't synthesize it; the inspector response is the seam. The
 * production export {@link ngrokProvider} passes nothing and uses the real CLI +
 * global `fetch`. The provider is registered in `src/tunnel/index.ts` (the "one
 * registry line" a new channel adds).
 *
 * **Deviation recorded (17u):**
 * - `isAvailable` dropped its authtoken gate and is now binary-presence only
 *   (`isToolAvailable("ngrok")`), matching the revised spec 17i ("same presence-check
 *   as cloudflare"). The authtoken is validated at `start`/`probe` time — a missing
 *   authtoken resolves `null` from `start` (graceful-absent) and `err` from `probe`
 *   (surfaced) — so doctor's live-channel check reports "ngrok ready" iff the CLI is
 *   installed. (doctor's per-channel comment was updated to match: both live kinds
 *   are now binary-presence.)
 * - The authtoken rides as `NGROK_AUTHTOKEN` env on the spawned child (not a
 *   `--authtoken` arg) so it never shows in a process listing. The default spawn
 *   merges it onto `process.env`, so an env-set `NGROK_AUTHTOKEN` (the boot override,
 *   17q) and a wizard-persisted secret (from `credentials.json`) both reach the CLI
 *   through the single `options.authtoken` seam.
 * - The poll bails the instant the child exits (`exitCode`/`signalCode` set) rather
 *   than spinning to the timeout — a bad authtoken makes `ngrok` exit at once.
 *   `child.kill()` on an already-exited child returns `false` without throwing
 *   (verified), so the null-path teardown needs no `try`/`catch`.
 * - Like the SDK version, `ora` is **not** imported here (it is a devDependency; the
 *   prod server calls `start`) — the spinner is a caller/wizard concern (17k).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { isToolAvailable } from "../../tools/bin.ts";
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider } from "../types.ts";

const DEFAULT_NGROK_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_INSPECTOR_URL = "http://127.0.0.1:4040/api/tunnels";

/** A `spawn()`-shaped dependency so tests can swap in a deterministic subprocess. */
export type NgrokSpawn = (args: string[], env: Record<string, string>) => ChildProcess;

/** Injectable seams so `start`/`probe` are hermetically unit-testable. */
export interface NgrokProviderDeps {
	/** Override `isToolAvailable("ngrok")` (tests inject; default = real binary check). */
	isAvailable?: () => boolean;
	/** Inject the ngrok CLI spawn (tests inject a deterministic subprocess). */
	spawn?: NgrokSpawn;
	/** Override the `fetch` the inspector poll + `/health` probe use (tests inject). */
	fetch?: typeof fetch;
	/** The ngrok inspector API URL polled for the public URL (default `:4040/api/tunnels`). */
	inspectorUrl?: string;
	/** Override the ~15s URL-wait timeout (tests pass a small value). */
	timeoutMs?: number;
	/** Override the inspector poll interval (tests pass a small value). */
	pollIntervalMs?: number;
	/** Local port the probe forwards (the running server). Required for `probe`. */
	probePort?: number;
}

/** `setTimeout`-based sleep for the inspector poll loop. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** True iff a non-empty ngrok authtoken is present in the field answers. */
function hasAuthtoken(options: Record<string, string>): boolean {
	const token = options.authtoken;
	return typeof token === "string" && token.trim() !== "";
}

/** Narrow an unknown value to a plain string-keyed record (no `as`). */
function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Narrow a catch value to a message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Pull the public URL out of an ngrok inspector `GET /api/tunnels` body. Prefers the
 * first `https://` `public_url` (ngrok may also expose an `http://` variant); falls
 * back to the first tunnel's URL. Pure so it is unit-tested directly. Returns `null`
 * when the body is not the expected shape or no tunnel has a URL yet — the inspector
 * binds `:4040` before the tunnel is provisioned, replying `{ tunnels: [] }` meanwhile.
 */
export function extractNgrokUrl(data: unknown): string | null {
	if (!isRecord(data)) return null;
	const tunnels = data.tunnels;
	if (!Array.isArray(tunnels)) return null;
	const urls: string[] = [];
	for (const tunnel of tunnels) {
		if (isRecord(tunnel)) {
			const url = tunnel.public_url;
			if (typeof url === "string") urls.push(url);
		}
	}
	if (urls.length === 0) return null;
	const httpsUrl = urls.find((url) => url.startsWith("https://"));
	return httpsUrl ?? urls[0];
}

/** True iff the spawned ngrok process has exited (by exit code or signal). */
function hasExited(child: ChildProcess): boolean {
	return child.exitCode !== null || child.signalCode !== null;
}

interface PollDeps {
	fetch: typeof fetch;
	inspectorUrl: string;
	timeoutMs: number;
	pollIntervalMs: number;
	isDead: () => boolean;
}

/**
 * Poll the ngrok inspector API for the public URL until it appears, the child dies,
 * or the timeout elapses. The inspector responds once the tunnel is provisioned;
 * until then it returns `{ tunnels: [] }` (or connection-refused), so we retry. Bails
 * the instant the child exits — a bad authtoken makes `ngrok` exit at once — rather
 * than spinning to the timeout.
 */
async function waitForNgrokUrl(deps: PollDeps): Promise<string | null> {
	const deadline = Date.now() + deps.timeoutMs;
	while (Date.now() < deadline) {
		if (deps.isDead()) return null;
		try {
			const response = await deps.fetch(deps.inspectorUrl);
			if (response.ok) {
				const data: unknown = await response.json();
				const url = extractNgrokUrl(data);
				if (url) return url;
			}
		} catch {
			// Inspector not up yet / connection refused / non-JSON body → keep polling.
		}
		await sleep(deps.pollIntervalMs);
	}
	return null;
}

/**
 * Build the ngrok provider. `deps` is omitted in production ({@link ngrokProvider});
 * tests inject `isAvailable`/`spawn`/`fetch` to exercise start/probe hermetically. The
 * injected `isAvailable` feeds the provider's presence check **and** the start/probe
 * short-circuits so they agree (one presence source); `spawn` threads a deterministic
 * subprocess through the real poll/kill plumbing.
 */
export function createNgrokProvider(deps: NgrokProviderDeps = {}): ChannelProvider {
	const checkAvailable = deps.isAvailable ?? (() => isToolAvailable("ngrok"));
	const doSpawn =
		deps.spawn ??
		((args, env) =>
			spawn("ngrok", args, {
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, ...env },
			}));
	const doFetch = deps.fetch ?? globalThis.fetch;
	const inspectorUrl = deps.inspectorUrl ?? DEFAULT_INSPECTOR_URL;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_NGROK_TIMEOUT_MS;
	const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const { probePort } = deps;
	return {
		kind: "ngrok",
		mode: "live",
		fields: [
			{ key: "authtoken", label: "ngrok authtoken", kind: "secret", required: true, help: "dashboard.ngrok.com" },
		],
		// Binary presence (the same model as cloudflare) — the authtoken is a start/probe concern.
		isAvailable: async () => checkAvailable(),
		start: async (localPort, options) => {
			// No authtoken → graceful-absent (never spawn a process doomed to fail).
			if (!hasAuthtoken(options)) return null;
			// Absent binary → graceful-absent (mirrors startTunnel's presence short-circuit).
			if (!checkAvailable()) return null;
			const child = doSpawn(["http", String(localPort)], { NGROK_AUTHTOKEN: options.authtoken });
			const url = await waitForNgrokUrl({
				fetch: doFetch,
				inspectorUrl,
				timeoutMs,
				pollIntervalMs,
				isDead: () => hasExited(child),
			});
			if (url === null) {
				// No URL (timeout / child death) — tear the process down. `kill()` on an
				// already-exited child returns false without throwing (verified), so the
				// `!killed` guard is all the safety this needs.
				if (!child.killed) child.kill();
				return null;
			}
			let stopped = false;
			return {
				url,
				// Idempotent teardown: a second `stop()` (a double signal during shutdown)
				// is a no-op — matches main.ts's one-shot `shuttingDown` posture (spec 14b).
				stop: async () => {
					if (stopped) return;
					stopped = true;
					if (!child.killed) child.kill();
				},
			};
		},
		probe: async (options) => {
			if (!hasAuthtoken(options)) return err(new Error("ngrok authtoken is required"));
			if (probePort === undefined) return err(new Error("ngrok probe requires a local server port"));
			if (!checkAvailable()) return err(new Error("ngrok binary not found on PATH"));
			const child = doSpawn(["http", String(probePort)], { NGROK_AUTHTOKEN: options.authtoken });
			try {
				const url = await waitForNgrokUrl({
					fetch: doFetch,
					inspectorUrl,
					timeoutMs,
					pollIntervalMs,
					isDead: () => hasExited(child),
				});
				if (url === null) return err(new Error("ngrok probe did not produce a URL in time"));
				const response = await doFetch(`${url}/health`);
				return response.ok ? ok(undefined) : err(new Error(`ngrok probe /health returned ${response.status}`));
			} catch (e) {
				// `waitForNgrokUrl` swallows its own fetch errors, so this is the `/health` fetch.
				return err(new Error(`ngrok probe /health failed: ${messageOf(e)}`));
			} finally {
				if (!child.killed) child.kill();
			}
		},
	};
}

/** The production ngrok provider — uses the real `ngrok` CLI + global `fetch`. */
export const ngrokProvider: ChannelProvider = createNgrokProvider();
