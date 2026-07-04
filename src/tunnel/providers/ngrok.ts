/**
 * The ngrok channel provider (spec 17i, **re-revised in 17w**) — a **live** channel
 * driven by the **`@ngrok/ngrok` SDK** (an in-process napi agent), not the system CLI.
 *
 * Going native reverses the 17u CLI switch. The agent ships as an npm dependency —
 * `@ngrok/ngrok` plus a per-platform `optionalDependencies` napi package
 * (`linux-x64-gnu`, `linux-arm64-gnu`/`-musl`, `linux-arm-gnueabihf` for a 32-bit Pi,
 * `darwin-*`, `win32-*`) — so the operator never installs, pins, or checksums a
 * binary: `npx openhammer` brings it. `forward({ addr, authtoken })` resolves straight
 * to the public HTTPS URL an MCP client points at — no spawned process, no `:4040`
 * inspector polling, no stdout scraping. The trade-off flipped: in 17u the CLI won
 * because the SDK hung; in 17w the SDK wins because "no external binary" is the goal
 * and the hang is now bounded (below).
 *
 * **The 17u hang, bounded not solved.** The SDK's bundled core still defaults to
 * QUIC/UDP and its JS API (1.7.0 `.d.ts`) still exposes no transport knob, so on a
 * network that blocks QUIC `forward()` can stall. The provider no longer lets that
 * stall the process: `forward()` is raced against a `timeoutMs` deadline, so a hang
 * degrades to a graceful `null` (localhost-only) instead of freezing boot. `start`
 * and `probe` never throw — the unchanged graceful-absent posture from spec 13. (The
 * empirical "does it still hang on the target network?" check is a deployment gate,
 * not a code property; the timeout is the defense that holds either way.)
 *
 * **Teardown.** The SDK's documented per-listener teardown is `listener.close()`; the
 * module-level `disconnect()` (close all listeners) sweeps the session and is the fix
 * for ngrok's free-tier "1 simultaneous session" limit, so a kill/restart cycle never
 * wedges on a lingering session. `stop` does both, best-effort and idempotent, and
 * retains the listener reference so the JS handle is not GC'd before close.
 *
 * **Lazy import.** `import("@ngrok/ngrok")` lives inside `start`/`probe`, never at
 * module load, so importing this module (and therefore the registry build at
 * `index.ts`) never touches the napi binary. `npx openhammer` imports cleanly even
 * where the platform package is absent (the `#21` smoke gate); a failed import simply
 * surfaces as `null` from `start`, like any other miss.
 *
 * **Availability.** There is no binary to presence-check, so `isAvailable` is
 * "authtoken present" (the only field, the only gate) — not an `isToolAvailable`
 * PATH probe. `doctor` therefore reports an unconfigured ngrok channel as "missing
 * credentials," not "missing binary." The authtoken is collected by the channel-add
 * wizard and persisted by `setCredentials`; it is passed to `forward` here, never as
 * a CLI arg or env that a process listing could leak (it is an in-process call).
 *
 * **Testability.** {@link createNgrokProvider} takes injectable `forward`/`disconnect`
 * seams plus `probePort`/`timeoutMs` knobs (mirroring the
 * `createCloudflareProvider`/`ensureToken` injection-arg precedents), so the unit
 * tests exercise start/probe hermetically — a fake `forward` returns a fake listener
 * whose `url()`/`close()` are deterministic; no live network, no real napi binary.
 * The production export {@link ngrokProvider} passes nothing and lazy-imports the real
 * SDK. Registered in `src/tunnel/index.ts` (keys by `kind`, so unchanged).
 */
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider } from "../types.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Minimal structural view of the `@ngrok/ngrok` `Listener` (1.7.0 `.d.ts`): the two
 * members this provider touches. Narrowed rather than importing the SDK types so the
 * module loads without the napi binary present (the lazy-import posture above).
 */
export interface NgrokListener {
	url(): string | null;
	close(): Promise<void>;
}

/**
 * The slice of the SDK's `Config` we forward (the 1.7.0 binding mixes casing —
 * `proto`/`schemes` are snake_case, the callbacks are camelCase `onStatusChange`/
 * `onLogEvent`). `addr` is the local port; `authtoken` is the gate.
 */
export interface NgrokForwardConfig {
	addr: number;
	authtoken: string;
	proto?: string;
	schemes?: string | string[];
	onStatusChange?: (status: string) => void;
	onLogEvent?: (data: string) => void;
}

/** Injectable SDK seams so `start`/`probe` are hermetically unit-testable. */
export interface NgrokProviderDeps {
	/** Raise a listener for `addr`+`authtoken`. Default lazy-imports `@ngrok/ngrok`. */
	forward?: (config: NgrokForwardConfig) => Promise<NgrokListener>;
	/** Close all listeners / sweep the session. Default lazy-imports `@ngrok/ngrok`. */
	disconnect?: () => Promise<void>;
	/** Local port to forward during an add-time probe (absent at channel-add time). */
	probePort?: number;
	/** Per-attempt connect timeout; a hang degrades to `null` rather than freezing. */
	timeoutMs?: number;
}

/** True iff a non-empty ngrok authtoken is present in the field answers. */
function hasAuthtoken(options: Record<string, string>): boolean {
	const token = options.authtoken;
	return typeof token === "string" && token.trim() !== "";
}

/** Narrow a catch value to a message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** Default `forward`: lazy-import the SDK so module load never touches the napi binary. */
const realForward = async (config: NgrokForwardConfig): Promise<NgrokListener> => {
	const ngrok = await import("@ngrok/ngrok");
	return (await ngrok.forward(config)) as NgrokListener;
};

/** Default `disconnect`: close all listeners (frees the session for the free tier). */
const realDisconnect = async (): Promise<void> => {
	const ngrok = await import("@ngrok/ngrok");
	await ngrok.disconnect();
};

/**
 * Raise a listener, racing `forward` against a timeout. Resolves `{ url, listener }`
 * on success or an `Error` on any failure (timeout, agent error, no URL). Never
 * throws. A listener that produces no URL is closed so it does not leak; a successful
 * listener is returned alive (its teardown is `stop`'s job).
 */
async function raise(
	forward: (config: NgrokForwardConfig) => Promise<NgrokListener>,
	addr: number,
	authtoken: string,
	timeoutMs: number,
): Promise<{ url: string; listener: NgrokListener } | Error> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const listener = await Promise.race([
			forward({ addr, authtoken, proto: "http" }),
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error("ngrok did not connect in time")), timeoutMs);
			}),
		]);
		const url = listener.url();
		if (!url) {
			await listener.close().catch(() => {});
			return new Error("ngrok listener produced no URL");
		}
		return { url, listener };
	} catch (e) {
		return new Error(`ngrok connect failed: ${messageOf(e)}`);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Build the ngrok provider. `deps` is omitted in production ({@link ngrokProvider});
 * tests inject `forward`/`disconnect` to exercise start/probe hermetically. The
 * injected `forward` is the single raise-the-tunnel seam; `disconnect` is the single
 * teardown-the-session seam — both default to a lazy import of the real SDK.
 */
export function createNgrokProvider(deps: NgrokProviderDeps = {}): ChannelProvider {
	const forward = deps.forward ?? realForward;
	const disconnect = deps.disconnect ?? realDisconnect;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const { probePort } = deps;
	return {
		kind: "ngrok",
		mode: "live",
		fields: [
			{ key: "authtoken", label: "ngrok authtoken", kind: "secret", required: true, help: "dashboard.ngrok.com" },
		],
		// No binary to presence-check — the authtoken (and a reachable ngrok edge at
		// `start`) is the gate. doctor reports "missing credentials," not "missing binary."
		isAvailable: async (options) => hasAuthtoken(options),
		start: async (localPort, options) => {
			// No authtoken → graceful-absent (never raise a tunnel doomed to fail).
			if (!hasAuthtoken(options)) return null;
			const raised = await raise(forward, localPort, options.authtoken, timeoutMs);
			if (raised instanceof Error) return null; // timeout / agent error / no URL → localhost-only
			let stopped = false;
			return {
				url: raised.url,
				// Idempotent teardown: a second `stop()` (a double signal during shutdown)
				// is a no-op — matches main.ts's one-shot `shuttingDown` posture (spec 14b).
				// The listener ref is captured here so the JS handle is not GC'd before
				// close; `listener.close()` is the SDK's documented teardown, `disconnect()`
				// sweeps the session (free-tier restart safety).
				stop: async () => {
					if (stopped) return;
					stopped = true;
					await raised.listener.close().catch(() => {});
					await disconnect().catch(() => {});
				},
			};
		},
		probe: async (options) => {
			if (!hasAuthtoken(options)) return err(new Error("ngrok authtoken is required"));
			if (probePort === undefined) return err(new Error("ngrok probe requires a local server port"));
			const raised = await raise(forward, probePort, options.authtoken, timeoutMs);
			if (raised instanceof Error) return err(raised);
			// Tear the probe listener + session down win or lose.
			await raised.listener.close().catch(() => {});
			await disconnect().catch(() => {});
			return ok(undefined);
		},
	};
}

/** The production ngrok provider — lazy-imports the real `@ngrok/ngrok` SDK. */
export const ngrokProvider: ChannelProvider = createNgrokProvider();
