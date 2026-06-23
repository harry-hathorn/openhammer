/**
 * Boot-time channel resolution (spec 17q). Selects which channel a booting
 * server should expose and turns it into a running {@link ChannelHandle} — or
 * `null`, for a localhost-only boot — through the channel registry.
 * `src/main.ts` delegates here instead of calling `startTunnel` directly, so
 * `--channel <id>` / `defaultChannel` / `MCP_TUNNEL_PROVIDER` / the legacy
 * `--tunnel` all funnel through one precedence path.
 *
 * The precedence is split from the handle resolution so each half is testable:
 * {@link selectChannel} is a pure-ish decision over the inputs (the only side
 * effect is the injectable secret-store read); {@link resolveChannelHandle}
 * adds the registry lookup + the live `start` / static `resolve` dispatch. Every
 * dependency is injectable (`getChannel`/`getCredentials`) — the
 * `11a`/`13`/`17b`–`17m` injection-arg precedent — so the full resolution is
 * hermetic too (a fake provider instead of a real ngrok/cloudflared).
 *
 * **Null-safe, never throws.** A channel that is absent, unregistered, or fails
 * to start resolves `handle: null` with a human-readable `notice` (the localhost
 * fallback the spec names). The boot boundary (`main.ts`) logs the `notice` and
 * continues serving on the local socket — the bearer gate is the real gate, and
 * a missing channel is a graceful degradation, not a boot failure.
 */
import { getCredentials } from "../config/credentials.ts";
import { CHANNEL_KINDS, type ChannelEntry, type ChannelKind } from "../config/settings.ts";
import { getChannel } from "./index.ts";
import type { ChannelHandle, ChannelProvider } from "./types.ts";

/** The known channel kinds as a runtime set — backs the {@link isChannelKind} guard. */
const KNOWN_KIND_VALUES: ReadonlySet<string> = new Set(Object.values(CHANNEL_KINDS));

/**
 * Narrow a string to a {@link ChannelKind} (no `as`): mirrors the loader's
 * private guard in `settings.ts` so an env `MCP_TUNNEL_PROVIDER` value is
 * validated against the single const object before it reaches the registry.
 */
function isChannelKind(v: string): v is ChannelKind {
	return KNOWN_KIND_VALUES.has(v);
}

/** A selected channel + its merged options (non-secret `options` overlaid with its secrets). */
export interface SelectedChannel {
	kind: ChannelKind;
	options: Record<string, string>;
}

/** The {@link selectChannel} outcome — three mutually-exclusive states. */
export type ChannelSelection =
	| { status: "selected"; channel: SelectedChannel }
	| { status: "not-found"; channelId: string }
	| { status: "unknown-provider"; provider: string }
	| { status: "none" };

/** Injectable seams so selection + resolution are hermetically unit-testable. */
export interface ResolveChannelDeps {
	/** Registry lookup (defaults to {@link getChannel}). */
	getChannel?: (kind: ChannelKind) => ChannelProvider | undefined;
	/** Secret-store read (defaults to {@link getCredentials}). */
	getCredentials?: (id: string) => Record<string, string>;
}

/** Inputs to {@link selectChannel}. */
export interface ChannelSelectInput {
	/**
	 * The resolved channel id — `--channel` > `settings.defaultChannel` (folded
	 * together by `resolveConfig`, 17f); `null` when neither is set.
	 */
	channelId: string | null;
	/** The persisted channel entries (`settings.channels`). */
	channels: ChannelEntry[];
	/** The boot env (for `MCP_TUNNEL_PROVIDER` / `NGROK_AUTHTOKEN` overrides). */
	env: NodeJS.ProcessEnv;
	/** Legacy `--tunnel` flag (the cloudflare quick-tunnel). */
	wantTunnel: boolean;
}

/** Inputs to {@link resolveChannelHandle} — the selection inputs plus the local port a live channel forwards from. */
export interface ResolveChannelInput extends ChannelSelectInput {
	/** The local port a live channel forwards from (passed to `provider.start`). */
	localPort: number;
}

/** A channel's merged options: non-secret `options` overlaid with its secret values (secrets win, as in doctor 17p). */
function mergeOptions(entry: ChannelEntry, secrets: Record<string, string>): Record<string, string> {
	return { ...entry.options, ...secrets };
}

/**
 * Select which channel to expose at boot, applying the §3.4 precedence
 * (CLI flag > env > persisted file) with the legacy `--tunnel` as the last
 * resort:
 *
 * 1. `channelId` (from `--channel <id>` or `settings.defaultChannel`) — the
 *    persisted channel with that id. `not-found` when the id names no entry
 *    (a misconfiguration — e.g. a stale `defaultChannel`).
 * 2. `MCP_TUNNEL_PROVIDER` (env) — a provider kind name, started with the
 *    `NGROK_AUTHTOKEN` env secret when present (the env-driven override that
 *    lets a CI deploy boot a tunnel without a settings doc). `unknown-provider`
 *    when the value isn't a known kind.
 * 3. `--tunnel` (legacy) — the cloudflare quick-tunnel (backward compatible).
 *
 * `none` when nothing is selected (the localhost-only default). Pure given
 * `deps.getCredentials`; `localPort` is a {@link resolveChannelHandle} concern.
 */
export function selectChannel(input: ChannelSelectInput, deps: ResolveChannelDeps = {}): ChannelSelection {
	const readSecrets = deps.getCredentials ?? getCredentials;
	const { channelId, channels, env, wantTunnel } = input;

	// 1. A persisted channel id (the --channel flag, or defaultChannel folded in by resolveConfig).
	if (channelId !== null) {
		const entry = channels.find((channel) => channel.id === channelId);
		if (entry !== undefined) {
			return {
				status: "selected",
				channel: { kind: entry.kind, options: mergeOptions(entry, readSecrets(entry.id)) },
			};
		}
		return { status: "not-found", channelId };
	}

	// 2. The env override — a provider kind by name (CI deploy without a settings doc).
	const providerKind = env.MCP_TUNNEL_PROVIDER;
	if (providerKind !== undefined && providerKind.trim() !== "") {
		const kind = providerKind.trim();
		if (!isChannelKind(kind)) {
			return { status: "unknown-provider", provider: kind };
		}
		const options: Record<string, string> = {};
		const authtoken = env.NGROK_AUTHTOKEN;
		if (authtoken !== undefined && authtoken !== "") {
			options.authtoken = authtoken;
		}
		return { status: "selected", channel: { kind, options } };
	}

	// 3. The legacy --tunnel flag — the cloudflare quick-tunnel.
	if (wantTunnel) {
		return { status: "selected", channel: { kind: "cloudflare", options: {} } };
	}

	return { status: "none" };
}

/** The boot-time channel resolution: a running/declared handle, or `null` (localhost-only). */
export interface ChannelResolution {
	/** The resolved handle, or `null` (the boot continues localhost-only). */
	handle: ChannelHandle | null;
	/**
	 * A short, human-readable notice for the boot log when a channel was selected
	 * but yielded no handle (or could not be resolved). `null` when nothing was
	 * selected — a localhost-only boot is the default and is silent.
	 */
	notice: string | null;
}

/**
 * Resolve the boot channel into a {@link ChannelHandle} (or `null`). Runs
 * {@link selectChannel} for the precedence, then dispatches to the selected
 * provider's `start` (live) or `resolve` (static) via the registry. Every
 * non-success path yields `handle: null` + a `notice` the boot boundary logs
 * (never throws — the spec-13 graceful-absent posture extended to all channels):
 * not-found, unknown-provider, an unregistered kind, or a `null` start/resolve.
 */
export async function resolveChannelHandle(
	input: ResolveChannelInput,
	deps: ResolveChannelDeps = {},
): Promise<ChannelResolution> {
	const selection = selectChannel(input, deps);
	if (selection.status === "none") {
		return { handle: null, notice: null };
	}
	if (selection.status === "not-found") {
		return { handle: null, notice: `channel ${selection.channelId} not found — continuing localhost-only.` };
	}
	if (selection.status === "unknown-provider") {
		return { handle: null, notice: `unknown tunnel provider "${selection.provider}" — continuing localhost-only.` };
	}

	const { kind, options } = selection.channel;
	const lookup = deps.getChannel ?? getChannel;
	const provider = lookup(kind);
	if (provider === undefined) {
		return { handle: null, notice: `no provider registered for channel kind "${kind}" — continuing localhost-only.` };
	}

	const handle =
		provider.mode === "live"
			? ((await provider.start?.(input.localPort, options)) ?? null)
			: (provider.resolve?.(options) ?? null);
	if (handle === null) {
		return { handle: null, notice: `${kind} channel unavailable — continuing localhost-only.` };
	}
	return { handle, notice: null };
}
