/**
 * The channel registry (spec 17g).
 *
 * Maps {@link ChannelKind} → {@link ChannelProvider}. The four kinds ship with
 * providers: 17h (cloudflare), 17i (ngrok), and 17j (static nginx /
 * static-url). {@link registerChannel} is the single mutation point each provider
 * (and a test's fake) calls, and {@link getChannel} resolves a kind. The
 * channel-add wizard (`src/tui/wizards/channel.ts`, 17k) selects from this
 * registry and the boot path (`src/main.ts`, 17q) resolves the persisted/default
 * channel through it — both stay unchanged by a new provider, which is the
 * scalability payoff.
 *
 * **Deviation recorded:** the spec's `CHANNELS: Record<ChannelKind,
 * ChannelProvider>` assumes all four kinds are populated. In 17g none are, so the
 * honest type is `Partial<Record<...>>` and {@link getChannel} returns
 * `... | undefined`. With `noUncheckedIndexedAccess` off (the deferred port
 * setting), a full `Record` index would *hide* the absent-kind case as
 * `ChannelProvider`; `Partial` keeps the lookup type-honest at runtime. This
 * stays correct once providers land — `getChannel` returning `undefined` for an
 * unregistered/unknown kind is the graceful path, not a defect.
 */
import type { ChannelKind } from "../config/settings.ts";
import { cloudflareProvider } from "./providers/cloudflare.ts";
import { ngrokProvider } from "./providers/ngrok.ts";
import { nginxProvider, staticUrlProvider } from "./providers/static.ts";
import type { ChannelProvider } from "./types.ts";

export type { ChannelHandle, ChannelProvider } from "./types.ts";

/**
 * The registered providers, keyed by {@link ChannelKind}. Populated at module
 * load by the four providers (17h/i/j). Mutate via
 * {@link registerChannel} / {@link unregisterChannel}.
 */
export const CHANNELS: Partial<Record<ChannelKind, ChannelProvider>> = {};

// Each provider self-registers here — the "one registry line" a new channel adds
// (17h cloudflare; 17i ngrok; 17j nginx + static-url). Declared after CHANNELS
// so the call runs in source order (no TDZ); the provider modules only export a
// const, never call registerChannel themselves (the ESM-cycle trap).
registerChannel(cloudflareProvider);
registerChannel(ngrokProvider);
registerChannel(nginxProvider);
registerChannel(staticUrlProvider);

/**
 * Register a provider under its `kind` (a later registration overwrites an
 * earlier one). Each provider module calls this once — the "one registry line" a
 * new channel adds. Exposed (not a private helper) so a test registers a fake
 * provider the same way a real one will.
 */
export function registerChannel(provider: ChannelProvider): void {
	CHANNELS[provider.kind] = provider;
}

/** Remove a registered provider (restores registry state — used by tests). */
export function unregisterChannel(kind: ChannelKind): void {
	delete CHANNELS[kind];
}

/** Resolve a channel provider by kind, or `undefined` when none is registered. */
export function getChannel(kind: ChannelKind): ChannelProvider | undefined {
	return CHANNELS[kind];
}
