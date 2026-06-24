/**
 * The dashboard's static-channel probe (spec 19c-probe): the dashboard side of
 * "channel live-state" for channels the running server does NOT authoritatively
 * report. The server can only report the **active** channel — the one it booted
 * with (spec 19c-channel) — so every other configured channel is `unknown` on
 * the wire. This module fills that gap for **static** channels (nginx /
 * static-url, whose public endpoint the operator stands up): it reuses each
 * provider's registry `probe` (a short `fetch(publicUrl/health)` round-trip) so
 * the channels panel shows live `up`/`down` + URL instead of `unknown`.
 *
 * **A view over the running server, not a second host.** The probe reaches the
 * operator's declared public endpoints directly — the same `/health` the static
 * provider probes at wizard/doctor time ({@link getChannel}'s `probe` is the
 * single source of truth for the reachability check). **Live** non-active
 * channels (cloudflare/ngrok) are skipped: their URL exists only once OpenHammer
 * starts them, so there is nothing to probe until they are the active channel
 * (reported by the server). Mirrors the dashboard's "reuse, don't reimplement"
 * rule — the probe *calls the existing* provider `probe`; it does not fork it.
 *
 * **The `probeChannels` seam.** {@link createChannelProbe} returns the exact
 * `(report, isReported) => () => void` shape {@link runDashboard}'s
 * `DashboardDeps.probeChannels` declares: `report` folds a channel's
 * `{ id, up, url }` into the dashboard's `channelState` snapshot; `isReported`
 * lets the probe skip a channel the server has already reported (the active
 * channel) so the server stays authoritative **and** the probe wastes no fetch
 * on it. Returns an idempotent unsubscribe (clears the re-probe timer) so a
 * dashboard quit leaves no dangling timer — the same `subscribe` teardown shape.
 *
 * **Graceful, never throws.** Each channel's probe is isolated: an errored probe
 * (the provider returns `err`) reports `down` for that channel and the sweep
 * continues; a thrown probe (a misbehaving provider) is caught and also reports
 * `down`. A channel whose kind has no registered provider — or whose provider
 * has no `probe` — is skipped (it stays `unknown`); a **live** channel is
 * skipped outright. Mirrors the null-safe `startTunnel`/`createSocketSubscriber`
 * posture (a local convenience, never a boot gate).
 *
 * **Injection seams** ({@link ChannelProbeDeps}) follow the `11a`/`13`/`17b`–`17t`
 * precedent — `lookup` (registry {@link getChannel}), `getCredentials`, the
 * re-probe `intervalMs`, are all injectable so the unit tests exercise the sweep
 * hermetically (fake providers + a recording `report`, no network). The
 * production export returns the real-registry impl; 19e wires
 * `probeChannels: createChannelProbe({ channels: settings.channels })`.
 */
import { type CredentialValues, getCredentials } from "../../config/credentials.ts";
import type { ChannelEntry } from "../../config/settings.ts";
import { type ChannelProvider, getChannel } from "../../tunnel/index.ts";

/** Default re-probe cadence — a static channel's reachability is re-checked every 10s. */
export const DEFAULT_CHANNEL_PROBE_INTERVAL_MS = 10_000;

/**
 * One channel's probe outcome, reported into the dashboard's `channelState`.
 * `up` is reachability (the provider `probe` resolved `ok`); `url` is the
 * channel's declared `publicUrl` (or `null` when none is set). This is the
 * dashboard-side complement to the server's {@link ChannelStateLine} (19c-channel).
 */
export interface ChannelProbeState {
	id: string;
	up: boolean;
	url: string | null;
}

/** Injection seams for {@link createChannelProbe} (the `11a`/`13`/`17b`–`17t` precedent). */
export interface ChannelProbeDeps {
	/** The configured channels to consider (from the settings doc). */
	channels: ChannelEntry[];
	/** Override channel-kind resolution (defaults to the registry {@link getChannel}). */
	lookup?: (kind: ChannelEntry["kind"]) => ChannelProvider | undefined;
	/** Override secret lookup (defaults to {@link getCredentials}; merged into the options bag). */
	getCredentials?: (id: string) => CredentialValues;
	/** Re-probe cadence in ms. `0` = probe once on subscribe (no timer). Defaults to 10s. */
	intervalMs?: number;
}

/**
 * Probe one channel via its registry provider, returning its live state (or
 * `null` to skip — a live channel, an unregistered kind, or a provider without a
 * `probe`). Never throws: an errored/thrown probe reports `down`. The options bag
 * merges the entry's non-secret `options` with its secrets (`getCredentials`),
 * exactly as `doctor`'s `createChannelCheck` does, so a secret-gated `probe`
 * (none today, but the seam is uniform) sees its values.
 */
async function probeOne(
	entry: ChannelEntry,
	lookup: (kind: ChannelEntry["kind"]) => ChannelProvider | undefined,
	getCreds: (id: string) => CredentialValues,
): Promise<ChannelProbeState | null> {
	// Only static channels are dashboard-probed: a live channel's URL exists only
	// once OpenHammer starts it (the server reports it then); a static channel's
	// endpoint stands regardless, so reachability is probeable now.
	if (entry.mode !== "static") return null;
	const provider = lookup(entry.kind);
	const probe = provider?.probe;
	if (probe === undefined) return null; // unregistered kind / no probe → stays unknown
	const options = { ...entry.options, ...getCreds(entry.id) };
	let up = false;
	try {
		up = (await probe(options)).ok;
	} catch {
		// A misbehaving provider (a throw, not a Result err) is treated as down; the
		// sweep continues. Well-behaved providers return `err` (handled by `.ok`),
		// so this is a defensive isolation net, not the expected path.
		up = false;
	}
	return { id: entry.id, up, url: entry.options.publicUrl ?? null };
}

/**
 * Build the dashboard's `probeChannels` seam. The returned function, when the
 * dashboard subscribes (once, on start), runs an immediate probe sweep then (if
 * `intervalMs > 0`) re-probes on a timer. Each sweep probes every **static**
 * channel the server has not already reported (`!isReported(id)`); results reach
 * the dashboard via `report`. Returns an idempotent unsubscribe that stops the
 * timer + lets an in-flight sweep no-op. Never throws.
 *
 * `report` is required; `isReported` defaults to "nothing reported" (probe all
 * static channels) so the single-arg `probe(report)` form works when the server
 * feed is absent.
 */
export function createChannelProbe(
	deps: ChannelProbeDeps,
): (report: (state: ChannelProbeState) => void, isReported?: (id: string) => boolean) => () => void {
	const lookup = deps.lookup ?? getChannel;
	const getCreds = deps.getCredentials ?? getCredentials;
	const intervalMs = deps.intervalMs ?? DEFAULT_CHANNEL_PROBE_INTERVAL_MS;

	/**
	 * Probe every static channel the server has not reported, reporting each
	 * outcome. Bails the instant the subscription is stopped, and re-checks
	 * `isReported` after each `await` so a channel the server reports mid-sweep
	 * (the active channel) is not overwritten by the probe.
	 */
	const sweep = async (
		report: (state: ChannelProbeState) => void,
		isReported: (id: string) => boolean,
		isStopped: () => boolean,
	): Promise<void> => {
		for (const entry of deps.channels) {
			if (isStopped()) return;
			if (isReported(entry.id)) continue; // server-authoritative (the active channel)
			const state = await probeOne(entry, lookup, getCreds);
			// Re-check after the await: the server may have reported this channel
			// (or the dashboard quit) while the probe was in flight.
			if (isStopped() || state === null || isReported(entry.id)) continue;
			report(state);
		}
	};

	return (report, isReported) => {
		const reported = isReported ?? (() => false);
		let stopped = false;
		let timer: ReturnType<typeof setInterval> | undefined;

		void sweep(report, reported, () => stopped);
		if (intervalMs > 0) {
			timer = setInterval(() => {
				if (!stopped) void sweep(report, reported, () => stopped);
			}, intervalMs);
		}

		return () => {
			stopped = true;
			if (timer !== undefined) clearInterval(timer);
			timer = undefined;
		};
	};
}
