/**
 * The optional cloudflared quick-tunnel (spec 13).
 *
 * Exposes the localhost server at an ephemeral public `https://*.trycloudflare.com`
 * URL via cloudflared's zero-account quick-tunnel, so a remote agent can reach the
 * tools without a tunnel account or config file. Hard-depends on the `cloudflared`
 * binary; if it is absent the server simply continues localhost-only — `startTunnel`
 * resolves `null` and never throws on a missing binary. Every failure mode (absent
 * binary, timeout, early child death) yields `null` so the boot path in `main.ts`
 * (spec 14) can fall back gracefully.
 *
 * cloudflared prints the quick-tunnel URL on **stderr** (not stdout); we accumulate
 * stderr chunks and scan for the first `https://…trycloudflare.com` URL. A ~15s
 * timeout kills the child and resolves `null` so a misbehaving cloudflared can never
 * hang boot. On success the live `child` is handed back so `main.ts` keeps it alive
 * for the server's lifetime and kills it on shutdown (no orphaned cloudflared).
 *
 * Returns `null` rather than a `Result` error: this is a graceful optional feature,
 * not a tool execution — absence is the common, non-exceptional case. The optional
 * `opts` arg (injectable `spawn`/`isAvailable`/`timeoutMs`/`onLog`) mirrors the
 * `ensureToken(config, credPath)` precedent from `11a`: the public `startTunnel(port)`
 * call shape `main.ts` uses stays clean while tests inject a deterministic subprocess.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { isToolAvailable } from "../tools/bin.ts";

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;
const DEFAULT_TUNNEL_TIMEOUT_MS = 15_000;

/** A successful quick-tunnel: the public URL plus the live cloudflared child. */
export interface TunnelResult {
	url: string;
	child: ChildProcess;
}

/** A `spawn()`-shaped dependency so tests can swap in a deterministic subprocess. */
export type SpawnCloudflared = (args: string[]) => ChildProcess;

/** Optional knobs for `startTunnel`; tests inject `spawn`/`isAvailable`/`timeoutMs`. */
export interface StartTunnelOptions {
	/** Override the ~15s URL-wait timeout (tests pass a small value). */
	timeoutMs?: number;
	/** Inject the cloudflared spawn (tests inject a deterministic subprocess). */
	spawn?: SpawnCloudflared;
	/** Inject the presence check (tests inject; default uses `isToolAvailable`). */
	isAvailable?: () => boolean;
	/** Forwarded cloudflared stderr chunks (pre-URL chatter) for diagnosability. */
	onLog?: (message: string) => void;
}

/**
 * Pull the first quick-tunnel URL out of accumulated cloudflared stderr. Pure so it is
 * unit-tested directly; `startTunnel` feeds it stderr as chunks arrive (it re-scans the
 * whole buffer so a URL split across chunk boundaries is still caught). Returns the base
 * URL with no trailing path — exactly the spec's `https://[a-z0-9-]+\.trycloudflare\.com`.
 */
export function extractTunnelUrl(stderr: string): string | null {
	const match = TUNNEL_URL_PATTERN.exec(stderr);
	return match ? match[0] : null;
}

/**
 * Start a cloudflared quick-tunnel for the given localhost port. Resolves `{ url, child }`
 * once the public `trycloudflare.com` URL appears on stderr, or `null` if cloudflared is
 * absent, dies early, or does not produce a URL in time. Never throws — callers fall back
 * to localhost-only on `null`.
 */
export async function startTunnel(port: number, opts: StartTunnelOptions = {}): Promise<TunnelResult | null> {
	const isAvailable = opts.isAvailable ?? (() => isToolAvailable("cloudflared"));
	if (!isAvailable()) return null;

	const timeoutMs = opts.timeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS;
	const doSpawn = opts.spawn ?? ((args) => spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"] }));
	const onLog = opts.onLog;

	// cloudflared quick-tunnel: ephemeral URL, no account, no config file, no auto-update.
	const child = doSpawn(["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"]);

	return new Promise<TunnelResult | null>((resolve) => {
		let settled = false;
		let stderr = "";
		let timeoutHandle: NodeJS.Timeout | undefined;

		const done = (result: TunnelResult | null): void => {
			if (settled) return;
			settled = true;
			if (timeoutHandle) clearTimeout(timeoutHandle);
			resolve(result);
		};

		// No URL within the timeout → kill the child and give up (never hang boot).
		timeoutHandle = setTimeout(() => {
			if (!child.killed) child.kill();
			done(null);
		}, timeoutMs);

		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			stderr += text;
			// Surface pre-URL chatter for diagnosability (main.ts wires this to its logger).
			onLog?.(text);
			const url = extractTunnelUrl(stderr);
			if (url) done({ url, child });
		});

		// Child died (spawn error / early exit) before printing a URL → give up. The child
		// is already gone here, so no kill is needed; the timeout path owns the kill.
		child.on("error", () => done(null));
		child.on("close", () => done(null));
	});
}
