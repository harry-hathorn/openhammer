/**
 * The cloudflare channel provider (spec 17h) — a **live** channel wrapping the
 * spec-13 quick-tunnel (`startTunnel`).
 *
 * cloudflared's zero-account quick-tunnel needs no credentials, so this provider
 * declares **no fields** (`fields: []` — the channel-add wizard prompts nothing).
 * `isAvailable` is the cheap `isToolAvailable("cloudflared")` presence check the
 * wizard/doctor use to decide whether to even offer the channel; `start` hands the
 * local port to {@link startTunnel} and lifts its `{ url, child }` into a
 * {@link ChannelHandle} whose `stop` tears the spawned cloudflared down on
 * shutdown. `start` resolves `null` when cloudflared is absent (or the tunnel
 * fails) — the unchanged graceful fallback from spec 13, never a throw, so the
 * boot path can continue localhost-only.
 *
 * **Testability:** {@link createCloudflareProvider} takes injectable
 * `isAvailable`/`spawn` deps (mirroring the `ensureToken(config, credPath)` and
 * `startTunnel(port, opts)` injection-arg precedents) so the unit tests reuse
 * `cloudflare.test.ts`'s fake-spawn shape without the real binary — which is
 * absent on the dev box (the documented spec-13 posture). The production export
 * {@link cloudflareProvider} passes nothing and uses the real binary. The
 * provider is registered in `src/tunnel/index.ts` (the "one registry line" a new
 * channel adds).
 */
import { isToolAvailable } from "../../tools/bin.ts";
import { type SpawnCloudflared, startTunnel } from "../cloudflare.ts";
import type { ChannelProvider } from "../types.ts";

/** Injectable presence check / spawn so tests are deterministic. */
export interface CloudflareProviderDeps {
	/** Override `isToolAvailable("cloudflared")` (tests inject; default = real). */
	isAvailable?: () => boolean;
	/** Inject the cloudflared spawn (tests inject a deterministic subprocess). */
	spawn?: SpawnCloudflared;
}

/**
 * Build the cloudflare provider. `deps` is omitted in production
 * ({@link cloudflareProvider}); tests inject `isAvailable`/`spawn` to exercise
 * the present/absent and happy-path branches hermetically. The injected
 * `isAvailable` feeds both the provider's presence check and the `startTunnel`
 * call so they agree (one presence source), and `spawn` threads the
 * `cloudflare.test.ts` fake through the real `startTunnel` plumbing.
 */
export function createCloudflareProvider(deps: CloudflareProviderDeps = {}): ChannelProvider {
	const isAvailable = deps.isAvailable ?? (() => isToolAvailable("cloudflared"));
	return {
		kind: "cloudflare",
		mode: "live",
		fields: [],
		isAvailable: async () => isAvailable(),
		start: async (localPort) => {
			const result = await startTunnel(localPort, { isAvailable, spawn: deps.spawn });
			if (result === null) return null;
			const { url, child } = result;
			return {
				url,
				// Idempotent teardown: a second `stop()` (e.g. a double signal during
				// shutdown) is a no-op rather than a second SIGTERM — matches main.ts's
				// one-shot `shuttingDown` shutdown posture (spec 14b).
				stop: async () => {
					if (!child.killed) child.kill();
				},
			};
		},
	};
}

/** The production cloudflare provider — uses the real `cloudflared` binary. */
export const cloudflareProvider: ChannelProvider = createCloudflareProvider();
