/**
 * The dashboard render loop (spec 19b): the **control center** entry point. Composes
 * the four pure panels ({@link src/tui/dashboard/panels.ts}) into a frame, feeds them
 * live state, and drives the `DashboardRenderer` seam (19a). One process, one screen.
 *
 * **Decomposed from the spec's `runDashboard({ socketPath, settings, serverControl })`**
 * (spec 19 line 30) into a testable core with injectable seams: the status-socket
 * client (19c), the key-menu modals (19d), and the server lifecycle (19e) are *not*
 * wired here — wiring them would require stubs against not-yet-existing modules. So
 * 19b's {@link runDashboard} takes the seams they will fill (`subscribe` for the live
 * feed, `status`/`onQuit` for server reachability + shutdown) and 19e will assemble
 * the spec's public `{ socketPath, settings, serverControl }` entrypoint around it.
 * The loop itself is complete: it renders the panels, refreshes on key/resize, folds
 * live events into the monitor + clients panels, and quits cleanly.
 *
 * **Live updates ride the renderer's refresh cadence** (19a's `refreshIntervalMs`,
 * default 150ms): the frame producer reads live state on every tick, so events that
 * arrive via `subscribe` reach the screen without the dashboard poking the renderer
 * per event (the `DashboardRenderer` interface exposes only `clear()` — a full-screen
 * clear — so a per-event poke would flicker; the cadence is the designed mechanism).
 * The `r` key forces a full redraw via `clear()` for an immediate refresh.
 *
 * **Reuse, not reimplementation** (spec 19 line 49): the clients set + monitor ring
 * reuse {@link MonitorState} from `src/tui/monitor-view.ts` (17t) — the dashboard
 * derives its clients panel from the same active-client reducer `openhammer monitor`
 * uses. `subscribe` delivers parsed {@link RequestEvent}s (19c parses the socket's
 * NDJSON via `parseEventLine`); the dashboard never touches the wire format.
 *
 * **Shutdown order:** on quit the renderer is stopped first (terminal restored:
 * cooked mode, cursor, paste/Kitty sequences — the no-raw-mode-leak bar from 19a),
 * then `onQuit` runs best-effort (19e stops the server child). A thrown `onQuit` is
 * caught + logged to stderr — the terminal is already restored, so the message
 * surfaces in the operator's shell rather than corrupting the dashboard screen.
 */
import type { Settings } from "../config/settings.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
import type { ChannelStateLine } from "../observability/status-socket.ts";
import type { ChannelProbeState } from "./dashboard/channel-probe.ts";
import {
	type ChannelLiveState,
	composeDashboard,
	type DashboardState,
	DEFAULT_19B_KEYS,
	emptyStatus,
	type KeyHint,
	type ServerStatusState,
} from "./dashboard/panels.ts";
import type { DashboardRenderer } from "./dashboard/render.ts";
import { MonitorState } from "./monitor-view.ts";

/** Default monitor-feed depth — the last 8 events are shown in the monitor panel. */
export const DASHBOARD_MONITOR_LIMIT = 8;

/** Keys that quit the dashboard: `q`/`Q` and Ctrl+C (`\x03`, the raw pi-tui sequence). */
const QUIT_KEYS = new Set<string>(["q", "Q", "\x03"]);
/** Keys that force a full redraw via `renderer.clear()`. */
const REFRESH_KEYS = new Set<string>(["r", "R"]);

/**
 * Injectable seams for {@link runDashboard} (the `11a`/`13`/`17b`–`17t` precedent).
 * `renderer` + `settings` are required; the rest are the 19c/19d/19e seams:
 * - `subscribe`: the live status-socket feed (19c wires the real socket). Each event
 *   folds into the monitor ring + the clients reducer and reaches the screen on the
 *   next refresh tick. Its optional 2nd callback receives channel-state lines
 *   (19c-channel) which fold into the `channelState` snapshot. Returns an
 *   unsubscribe called on shutdown. Omit for a static dashboard (no live feed).
 * - `status`/`channelState`: initial reachability snapshots (19e/19c update these in
 *   their own iterations; 19b renders them as given).
 * - `onQuit`: shutdown hook (19e stops the server child). Best-effort.
 * - `keys`: the footer key menu (defaults to 19b's wired keys; 19d passes the fuller set).
 */
export interface DashboardDeps {
	/** The render substrate (19a). The loop drives its frame producer + key handler. */
	renderer: DashboardRenderer;
	/** The settings doc — seeds the channels panel + the default-channel marker. */
	settings: Settings;
	/** Initial server status (19e populates from the running child). Defaults to "down"/unknown. */
	status?: ServerStatusState;
	/** Initial per-channel live state (19c populates from the server, 19c-probe from
	 * the dashboard). Defaults to none. */
	channelState?: Record<string, ChannelLiveState>;
	/** Live event feed (19c wires this to the status socket). The optional 2nd
	 * callback receives channel-state lines (19c-channel) → the `channelState`
	 * snapshot. Omit for a static dashboard. */
	subscribe?: (
		onEvent: (event: RequestEvent) => void,
		onChannelState?: (state: ChannelStateLine) => void,
	) => () => void;
	/** Static-channel probe (19c-probe). Probes non-active static channels'
	 * `publicUrl/health` directly (reusing the registry `probe`) so they show live
	 * `up`/`down` + URL instead of `unknown`. `report` folds a probe outcome into
	 * `channelState`; `isReported(id)` is true for channels the server has already
	 * reported (the active channel) — those are skipped so the server stays
	 * authoritative and the probe wastes no fetch on them. Returns an unsubscribe
	 * called on shutdown. Omit for a dashboard that does not probe channels. */
	probeChannels?: (report: (state: ChannelProbeState) => void, isReported?: (id: string) => boolean) => () => void;
	/** Monitor-feed depth. Defaults to {@link DASHBOARD_MONITOR_LIMIT}. */
	monitorLimit?: number;
	/** Footer key-menu entries. Defaults to {@link DEFAULT_19B_KEYS} (19d extends). */
	keys?: ReadonlyArray<KeyHint>;
	/** Shutdown hook (19e stops the server child). Best-effort — a throw is logged, not fatal. */
	onQuit?: () => void | Promise<void>;
}

/**
 * Run the dashboard: compose the panels, drive the renderer, fold live events into
 * the monitor + clients panels, and block until the operator quits (`q`/Ctrl+C).
 * Resolves once the renderer is stopped + `onQuit` has settled, so the caller (19e)
 * controls the process lifecycle (it `await`s this then exits).
 *
 * All setup (`onKey`/`start`/`subscribe`) is synchronous, so a test can drive the
 * fake renderer's captured producer + key handler the moment the promise is returned
 * — there is no setup race. `subscribe` is the only path that mutates the rendered
 * state after start (the monitor ring + clients reducer); `status`/`channelState`
 * are fixed snapshots for 19b.
 */
export function runDashboard(deps: DashboardDeps): Promise<void> {
	const status = deps.status ?? emptyStatus();
	const channelState = deps.channelState ?? {};
	const monitorLimit = deps.monitorLimit ?? DASHBOARD_MONITOR_LIMIT;
	const keys = deps.keys ?? DEFAULT_19B_KEYS;
	const monitorState = new MonitorState();
	const eventRing: RequestEvent[] = [];

	/** Build the current dashboard state from the live monitor ring + clients reducer. */
	const buildState = (): DashboardState => ({
		status,
		channels: deps.settings.channels,
		defaultChannelId: deps.settings.defaultChannel,
		channelState,
		clients: monitorState.stats(),
		monitor: eventRing,
		monitorLimit,
	});

	return new Promise<void>((resolve) => {
		let settled = false;
		let unsub: (() => void) | undefined;
		let unsubProbe: (() => void) | undefined;
		/** Channel ids the server has authoritatively reported (the active channel,
		 * 19c-channel). The probe (19c-probe) skips these so the server stays
		 * authoritative and a probe result never overwrites a server report. */
		const serverReported = new Set<string>();

		/** Quit: idempotent. Restore the terminal first, then run the best-effort shutdown hook. */
		const quit = async (): Promise<void> => {
			if (settled) return;
			settled = true;
			unsub?.();
			unsubProbe?.();
			deps.renderer.stop();
			try {
				await deps.onQuit?.();
			} catch (e) {
				// onQuit is best-effort: a failure (e.g. stopping the server child) must not
				// block the resolved promise. The terminal is already restored, so this
				// surfaces in the operator's shell rather than corrupting the dashboard.
				console.error(`dashboard shutdown error: ${e instanceof Error ? e.message : String(e)}`);
			}
			resolve();
		};

		deps.renderer.onKey((data) => {
			if (QUIT_KEYS.has(data)) {
				void quit();
			} else if (REFRESH_KEYS.has(data)) {
				deps.renderer.clear();
			}
		});

		// The frame producer is pulled on each render tick (start, key, resize, refresh
		// cadence) — it reads live state, so subscribed events reach the screen naturally.
		deps.renderer.start((width) => composeDashboard(buildState(), width, keys));

		// Wire the live feed last: 19c's subscriber delivers parsed events (recent dump
		// first, then live). Each folds into the monitor ring (capped) + the clients
		// reducer; channel-state lines (19c-channel) mark the channel server-reported
		// (authoritative) and fold into the `channelState` snapshot. The next refresh
		// tick renders the updated state.
		unsub = deps.subscribe?.(
			(event) => {
				monitorState.apply(event);
				eventRing.push(event);
				while (eventRing.length > monitorLimit) eventRing.shift();
			},
			(state) => {
				serverReported.add(state.id);
				channelState[state.id] = { up: state.up, url: state.url };
			},
		);

		// 19c-probe: probe non-active static channels' `publicUrl/health` directly
		// (reusing the registry `probe`) so they show live `up`/`down` + URL. A probe
		// outcome folds into `channelState` only when the server has NOT reported that
		// channel (`isReported`) — the server stays authoritative for the active
		// channel; the probe fills the rest. The probe is skipped entirely for a
		// channel the server reports (no wasted fetch).
		unsubProbe = deps.probeChannels?.(
			(state) => {
				if (!serverReported.has(state.id)) channelState[state.id] = { up: state.up, url: state.url };
			},
			(id) => serverReported.has(id),
		);
	});
}
