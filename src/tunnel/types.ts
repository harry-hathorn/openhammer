/**
 * Channel provider types — the registry vocabulary (spec 17g).
 *
 * A *channel* is how OpenHammer is reached: **live** (a process OpenHammer
 * starts — ngrok, cloudflared quick-tunnel — whose URL it discovers) or
 * **static/deployed** (a public URL the operator stands up — nginx on a server,
 * a fixed domain, a reverse proxy). Each {@link ChannelProvider} is the blueprint
 * for one channel kind; the registry (`src/tunnel/index.ts`) maps
 * {@link ChannelKind} → provider.
 *
 * This is the scalability seam: a provider declares only its `fields`
 * (a {@link ConfigField[]} the generic wizard renders unchanged) plus its
 * `isAvailable`/`probe`/`start`/`resolve` behavior. Adding a channel is one
 * provider file + one registry line — no wizard or caller edits. `ChannelKind`,
 * `ChannelMode`, and `ChannelEntry` already live in the settings doc
 * (`src/config/settings.ts`, spec 17d) and are reused here, not redefined, so the
 * const object + derived union stays the single source across the loader and the
 * registry. Re-exports {@link ConfigField} so a provider module imports its field
 * schema from the registry layer alone.
 */
import type { ChannelKind, ChannelMode } from "../config/settings.ts";
import type { Result } from "../tools/result.ts";
import type { ConfigField } from "../tui/schema.ts";

export type { ConfigField } from "../tui/schema.ts";

/**
 * A running/exposed channel. `url` is the public endpoint the agent is told to
 * use; `stop` tears down a live channel's spawned process and is absent for
 * static channels (the operator owns the endpoint, so OpenHammer has nothing to
 * kill on shutdown). Built by a provider's `start` (live) or `resolve` (static).
 */
export interface ChannelHandle {
	url: string;
	stop?: () => Promise<void>;
}

/**
 * The blueprint for one channel kind. `kind` keys it in the registry; `mode`
 * picks live (spawns, needs `start`) vs static (declares a URL, needs `resolve`);
 * `fields` is what the wizard renders — there is no per-channel UI. `isAvailable`
 * is the cheap presence check (binary present / authtoken set); `probe` is the
 * optional wizard-time validation (e.g. a short connect + `/health` round-trip);
 * `start` brings a live channel up (or resolves `null` when it can't — the
 * graceful-absent case, never throws, per spec 13); `resolve` turns a static
 * channel's declared options into a {@link ChannelHandle} with no spawn. Exactly
 * one of `start`/`resolve` is meaningful, per `mode`.
 */
export interface ChannelProvider {
	kind: ChannelKind;
	mode: ChannelMode;
	fields: ConfigField[];
	isAvailable(options: Record<string, string>): Promise<boolean>;
	probe?(options: Record<string, string>): Promise<Result<void, Error>>;
	start?(localPort: number, options: Record<string, string>): Promise<ChannelHandle | null>;
	resolve?(options: Record<string, string>): ChannelHandle | null;
}
