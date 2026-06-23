/**
 * The ngrok channel provider (spec 17i) — a **live** channel backed by the
 * `@ngrok/ngrok` SDK.
 *
 * Unlike cloudflare's zero-account quick-tunnel, ngrok needs an authtoken, so this
 * provider declares one **secret field** (`authtoken`) the channel-add wizard
 * collects and `setCredentials` persists; `isAvailable` is "the authtoken is set".
 * `start` lazily `import()`s the SDK (so the prod server never loads the ngrok
 * native binding at boot unless ngrok is actually configured), mints a session with
 * `authtoken(t)`, `connect()`s the local port to a public `*.ngrok.app` URL, and
 * lifts the listener into a {@link ChannelHandle} whose `stop` closes it on
 * shutdown. `start` resolves `null` for every failure (no authtoken, bad authtoken,
 * network, no URL) — the unchanged graceful-absent posture from spec 13, never a
 * throw, so boot can continue localhost-only. `probe` is the wizard-time
 * validation: a short `connect()` + `fetch(/health)` round-trip that surfaces a bad
 * authtoken as `err` (where `start` would silently fall back) before the channel is
 * persisted.
 *
 * **Testability:** {@link createNgrokProvider} takes injectable `loadModule` (the
 * lazy SDK, or a fake), `fetch` (the `/health` probe), and `probePort` (mirroring
 * the `ensureToken`/`startTunnel` injection-arg precedents) so the unit tests
 * exercise start/probe hermetically — no native binding, no network. The production
 * export {@link ngrokProvider} passes nothing and uses the real SDK + global
 * `fetch`. The provider is registered in `src/tunnel/index.ts` (the "one registry
 * line" a new channel adds).
 *
 * **Deviation recorded:**
 * - `ora` is **not** imported here. The spec describes the probe as running "under
 *   an `ora` spinner", but `ora` is a **devDependency** (CLI-only, §2.1 footprint)
 *   while this module runs in the **prod server** (boot calls `start`); importing
 *   it would crash the `npm ci --omit=dev` prod image. The spinner is a
 *   caller/wizard concern (17k wraps the `probe()` call in `ora`), so the provider
 *   stays a pure `Result`-returning function — the spinner is added by the caller.
 * - The probe's local port comes from the factory's `probePort`, **not** the
 *   `probe(options)` signature (which carries only field answers — no port).
 *   main.ts (17q) / the wizard (17k) create a configured provider with `probePort`
 *   set when they need probe; the bare registry {@link ngrokProvider} is for
 *   listing/field-discovery + `start` (which receives `localPort` directly), so its
 *   `probe` errs on the missing port until wired. Reconciled when 17k/17q land.
 */
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider } from "../types.ts";

/**
 * The ngrok SDK surface this provider uses — a minimal structural slice so the unit
 * tests inject a trivial fake (no native binding, no full-SDK type coupling). The
 * real `import("@ngrok/ngrok")` namespace structurally satisfies it: `authtoken`
 * + `connect` are named exports, and `Listener.url()`/`close()` are its methods.
 */
interface NgrokModule {
	authtoken(token: string): Promise<void>;
	connect(config: { addr: number | string }): Promise<NgrokListener>;
}

/** The listener `connect` returns: its public URL plus a `close()` teardown. */
interface NgrokListener {
	url(): string | null;
	close(): Promise<void>;
}

/** Injectable SDK loader / fetch / probe port so tests are deterministic. */
export interface NgrokProviderDeps {
	/** Lazy ngrok module loader (tests inject a fake; default = dynamic import). */
	loadModule?: () => Promise<NgrokModule>;
	/** Override the `fetch` the `/health` probe uses (tests inject). */
	fetch?: typeof fetch;
	/** Local port the probe connects to (the running server). Required for `probe`. */
	probePort?: number;
}

/** True iff a non-empty ngrok authtoken is present in the field answers. */
function hasAuthtoken(options: Record<string, string>): boolean {
	const token = options.authtoken;
	return typeof token === "string" && token.trim() !== "";
}

/** Narrow an unknown catch value to a message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Build the ngrok provider. `deps` is omitted in production
 * ({@link ngrokProvider}); tests inject `loadModule`/`fetch`/`probePort` to
 * exercise start/probe hermetically — no native binding, no network. The default
 * `loadModule` is the lazy `import("@ngrok/ngrok")`, so the native binding loads
 * only when `start`/`probe` actually run with an authtoken present.
 */
export function createNgrokProvider(deps: NgrokProviderDeps = {}): ChannelProvider {
	const loadModule = deps.loadModule ?? (async (): Promise<NgrokModule> => import("@ngrok/ngrok"));
	const probeFetch = deps.fetch ?? globalThis.fetch;
	const { probePort } = deps;
	return {
		kind: "ngrok",
		mode: "live",
		fields: [
			{ key: "authtoken", label: "ngrok authtoken", kind: "secret", required: true, help: "dashboard.ngrok.com" },
		],
		isAvailable: async (options) => hasAuthtoken(options),
		start: async (localPort, options) => {
			// No authtoken → graceful-absent: never throw, never load the binding.
			if (!hasAuthtoken(options)) return null;
			let listener: NgrokListener;
			try {
				const ngrok = await loadModule();
				await ngrok.authtoken(options.authtoken);
				listener = await ngrok.connect({ addr: localPort });
			} catch {
				// Bad authtoken / network / connect failure → fall back localhost-only.
				return null;
			}
			const url = listener.url();
			if (!url) {
				await listener.close().catch(() => {});
				return null;
			}
			let stopped = false;
			return {
				url,
				// Idempotent teardown: a second `stop()` (a double signal during
				// shutdown) is a no-op — matches main.ts's one-shot `shuttingDown`
				// shutdown posture (spec 14b). Best-effort close (the established
				// `.catch(() => {})` teardown idiom — not an empty catch block).
				stop: async () => {
					if (stopped) return;
					stopped = true;
					await listener.close().catch(() => {});
				},
			};
		},
		probe: async (options) => {
			if (!hasAuthtoken(options)) return err(new Error("ngrok authtoken is required"));
			if (probePort === undefined) return err(new Error("ngrok probe requires a local server port"));
			let listener: NgrokListener;
			try {
				const ngrok = await loadModule();
				await ngrok.authtoken(options.authtoken);
				listener = await ngrok.connect({ addr: probePort });
			} catch (e) {
				// A connect rejection is the authtoken validation signal — surface it
				// (start would silently fall back; probe must tell the operator).
				return err(new Error(`ngrok probe failed to connect: ${messageOf(e)}`));
			}
			try {
				const url = listener.url();
				if (!url) return err(new Error("ngrok probe returned no URL"));
				const response = await probeFetch(`${url}/health`);
				return response.ok ? ok(undefined) : err(new Error(`ngrok probe /health returned ${response.status}`));
			} catch (e) {
				return err(new Error(`ngrok probe /health failed: ${messageOf(e)}`));
			} finally {
				await listener.close().catch(() => {});
			}
		},
	};
}

/** The production ngrok provider — uses the real `@ngrok/ngrok` SDK + global `fetch`. */
export const ngrokProvider: ChannelProvider = createNgrokProvider();
