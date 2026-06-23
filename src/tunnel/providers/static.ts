/**
 * The static channel providers (spec 17j) — **static/deployed** channels
 * (`nginx`, `static-url`).
 *
 * A static channel is how OpenHammer is reached when the operator — not
 * OpenHammer — stands up the public endpoint: nginx or a reverse proxy on a
 * server that forwards to the local port OpenHammer binds, or any fixed URL.
 * There is no process for OpenHammer to spawn, so these providers declare **no
 * `start`**: `resolve` lifts the operator-declared `publicUrl` into a
 * {@link ChannelHandle} (with no `stop` — the operator owns the endpoint, so
 * OpenHammer has nothing to tear down on shutdown), and `probe` does a short
 * `fetch(publicUrl/health)` round-trip to confirm the operator's proxy actually
 * reaches the server. `isAvailable` is the cheap "a publicUrl is set" presence
 * check the wizard/doctor use. This makes "deploy to a webserver" a first-class
 * persisted channel, not an afterthought.
 *
 * The two kinds differ only in their field schema: both collect a required
 * `publicUrl`, and `nginx` additionally collects an optional `upstream` hint (the
 * local endpoint nginx forwards to) for the operator's reference. The behavior is
 * identical, so {@link createStaticProvider} is one factory parameterized by
 * `kind` — the "one file, one factory per domain" precedent.
 *
 * **Testability:** {@link createStaticProvider} takes an injectable `fetch`
 * (mirroring the ngrok provider's injection-arg precedent) so the unit tests
 * exercise probe pass/fail hermetically — no network. The production exports
 * {@link nginxProvider} / {@link staticUrlProvider} pass nothing and use the
 * global `fetch`. The providers are registered in `src/tunnel/index.ts` (the "one
 * registry line" a new channel adds).
 */
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider, ConfigField } from "../types.ts";

/** The two static channel kinds this factory builds. */
export type StaticKind = "nginx" | "static-url";

/** Injectable fetch so the `/health` probe is deterministic in tests. */
export interface StaticProviderDeps {
	/** Override the `fetch` the `/health` probe uses (tests inject). */
	fetch?: typeof fetch;
}

/** True iff a non-empty publicUrl is present in the field answers. */
function hasPublicUrl(options: Record<string, string>): boolean {
	const url = options.publicUrl;
	return typeof url === "string" && url.trim() !== "";
}

/** Narrow an unknown catch value to a message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Strip a trailing slash so `${base}/health` never doubles it (`//health`) when
 * the operator's `publicUrl` ends in `/`. nginx collapses double slashes, but a
 * correct URL costs nothing and reads cleanly in logs.
 */
function healthUrl(publicUrl: string): string {
	return `${publicUrl.replace(/\/+$/, "")}/health`;
}

/**
 * The field schema for a static kind. Both collect a required `publicUrl`; `nginx`
 * additionally collects an optional `upstream` hint (the local endpoint the
 * reverse proxy forwards to) for the operator's reference. `static-url` is the
 * kindless variant — any fixed URL.
 */
function staticFields(kind: StaticKind): ConfigField[] {
	const publicUrl: ConfigField = {
		key: "publicUrl",
		label: "public URL",
		kind: "text",
		required: true,
		help: "The public URL the operator's reverse proxy serves (it forwards to the local port OpenHammer binds).",
	};
	if (kind === "nginx") {
		return [
			publicUrl,
			{
				key: "upstream",
				label: "nginx upstream",
				kind: "text",
				required: false,
				help: "Optional: the local endpoint nginx forwards to (e.g. http://127.0.0.1:3000), for your reference.",
			},
		];
	}
	return [publicUrl];
}

/**
 * Build a static provider (`nginx` or `static-url`). `deps` is omitted in
 * production ({@link nginxProvider}/{@link staticUrlProvider}); tests inject
 * `fetch` to exercise the `/health` probe pass/fail hermetically — no network.
 * Both kinds share identical `resolve`/`probe` behavior; only the field schema
 * (and thus the wizard prompts) differ.
 */
export function createStaticProvider(kind: StaticKind, deps: StaticProviderDeps = {}): ChannelProvider {
	const probeFetch = deps.fetch ?? globalThis.fetch;
	return {
		kind,
		mode: "static",
		fields: staticFields(kind),
		isAvailable: async (options) => hasPublicUrl(options),
		// Graceful-absent: no publicUrl → null (mirrors a live provider's `start`),
		// never a throw, so boot can continue localhost-only.
		resolve: (options) => (hasPublicUrl(options) ? { url: options.publicUrl } : null),
		probe: async (options) => {
			if (!hasPublicUrl(options)) return err(new Error("publicUrl is required"));
			try {
				const response = await probeFetch(healthUrl(options.publicUrl));
				return response.ok ? ok(undefined) : err(new Error(`publicUrl /health returned ${response.status}`));
			} catch (e) {
				return err(new Error(`publicUrl /health failed: ${messageOf(e)}`));
			}
		},
	};
}

/** The production nginx provider — static, no spawn, declared publicUrl + an optional upstream hint. */
export const nginxProvider: ChannelProvider = createStaticProvider("nginx");

/** The production static-url provider — static, no spawn, declared publicUrl. */
export const staticUrlProvider: ChannelProvider = createStaticProvider("static-url");
