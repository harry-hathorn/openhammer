/**
 * The dashboard's live state (spec 19b/19c) — a single mutable holder the render
 * loop + screens read each tick. Replaces the ad-hoc locals that lived in
 * `dashboard.ts`'s `runDashboard` closure (status, settings, channelState, the
 * monitor ring, the clients reducer) with one object whose `apply*` reducers are
 * unit-tested directly — no terminal, no render lib (the `panels.test.ts`
 * pure-function precedent).
 *
 * **Why a class, not a bag of closures:** the dashboard now drives a real pi-tui
 * component tree (spec 19 rebuild); the root + screens need a stable reference to
 * read live state on every render, and the wiring (`subscribe`/`probe`/modal
 * actions) needs stable `apply*` callbacks to hand to {@link runDashboard}. A
 * small stateful object — the {@link MonitorState} precedent — is the natural
 * shape. State mutates; the **view-models** (`view.ts`) are the pure read side.
 *
 * **Two client notions, kept distinct:**
 * - `activeClients` — *connected MCP clients* (call counts + last-seen), reduced
 *   from the status-socket feed by {@link MonitorState} (the `openhammer monitor`
 *   reducer, reused — single source).
 * - `oauthClients` — *registered OAuth clients* (id + label + createdAt) from
 *   `~/.openhammer/credentials.json`, snapshotted when the Clients screen opens or
 *   a client is issued/removed. The plaintext secret is **never** stored here
 *   (only its hash is persisted) — the issue flow hands the one-time secret to the
 *   screen out-of-band via a `Result`.
 *
 * The {@link ServerStatusState}/{@link ChannelLiveState} types live here (the
 * state shapes' canonical home); `panels.ts` re-exports them so existing import
 * sites stay green during the incremental rebuild.
 */
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import type { ClientStat, RequestEvent } from "../../mcp/telemetry.ts";
import { MonitorState } from "../monitor-view.ts";

/** Default monitor-feed depth — the last N events shown in the monitor screen. */
export const DASHBOARD_MONITOR_LIMIT = 8;

/**
 * Server reachability for the status screen. `up`/URLs are populated by
 * `runDashboard` (which probes the running child's `/health` + reads its banner);
 * {@link emptyStatus} is the pre-reach state shown before the server is contacted.
 */
export interface ServerStatusState {
	/** Is the server up (`GET /health` ok)? */
	up: boolean;
	/** The local MCP endpoint (`http://host:port/mcp`), or `null` if unknown. */
	localUrl: string | null;
	/** A public tunnel/channel URL, or `null`. */
	publicUrl: string | null;
	/** The bearer token (shown in the status screen), or `null`. */
	token: string | null;
}

/** Fresh "not yet reached" status — shown before the server is contacted. */
export function emptyStatus(): ServerStatusState {
	return { up: false, localUrl: null, publicUrl: null, token: null };
}

/**
 * Live reachability of one configured channel (from the status-socket feed or the
 * static-channel probe). Absent from {@link DashboardStore.channelState} means
 * "unknown" — distinct from `up:false` (reported down).
 */
export interface ChannelLiveState {
	up: boolean;
	url: string | null;
}

/** Injection seam for {@link DashboardStore} (the `11a`/`13`/`17b`–`19d` precedent). */
export interface DashboardStoreDeps {
	/** Monitor-feed depth (the events ring cap). Defaults to {@link DASHBOARD_MONITOR_LIMIT}. */
	monitorLimit?: number;
}

/**
 * The dashboard's live state. Construct once in `runDashboard`; the render loop
 * reads it each tick, and the wiring feeds it via the `apply*`/`set*` methods.
 * The settings doc is mutable: a settings modal (`addChannel`/`setSection` or a
 * channel use/remove) reassigns it via {@link setSettings} so the next frame
 * reflects the change — the dashboard owns the live view while it runs.
 */
export class DashboardStore {
	/** Server reachability snapshot. */
	status: ServerStatusState = emptyStatus();
	/** The settings doc — channels, default channel, mcp allowed-clients. */
	settings: Settings;
	/** Per-channel live state, keyed by channel id. Absent = unknown. */
	readonly channelState: Record<string, ChannelLiveState> = {};
	/** Registered OAuth clients snapshot (id + label + createdAt; no secrets). */
	oauthClients: ClientInfo[] = [];

	/** The connected-client reducer (call counts + last-seen), reused from monitor. */
	private readonly monitor: MonitorState;
	/** The recent-event ring (newest last), capped at the monitor limit. */
	private readonly events: RequestEvent[] = [];
	/** The events-ring cap. */
	private readonly monitorLimit: number;

	/**
	 * @param deps.monitorLimit the events-ring cap.
	 * @param initial the seed settings (channels/default/mcp); defaults to empty.
	 */
	constructor(deps: DashboardStoreDeps = {}, initial: Settings = emptySettings()) {
		this.monitor = new MonitorState();
		this.monitorLimit = deps.monitorLimit ?? DASHBOARD_MONITOR_LIMIT;
		this.settings = initial;
	}

	/** The configured channels (a view over {@link settings}). */
	get channels(): ChannelEntry[] {
		return this.settings.channels;
	}

	/** The default channel id, or `null` (a view over {@link settings}). */
	get defaultChannelId(): string | null {
		return this.settings.defaultChannel;
	}

	/** Active (connected) MCP clients — reduced from the socket feed. */
	get activeClients(): ClientStat[] {
		return this.monitor.stats();
	}

	/** The recent-event ring (newest last). Read-only by convention (view-models read). */
	get monitorEvents(): RequestEvent[] {
		return this.events;
	}

	// ---- mutators (the wiring feeds these) ----

	/** Set the server reachability snapshot. */
	setStatus(status: ServerStatusState): void {
		this.status = status;
	}

	/** Adopt a new settings doc (after a modal mutation: add channel / set section / use / remove). */
	setSettings(settings: Settings): void {
		this.settings = settings;
	}

	/** Snapshot the registered OAuth clients (on Clients-screen open / after issue or remove). */
	setOauthClients(clients: ClientInfo[]): void {
		this.oauthClients = clients;
	}

	/**
	 * Set one channel's live reachability. Both the status-socket feed (server-reported)
	 * and the static-channel probe funnel through here — the "server stays authoritative"
	 * gating is wiring policy in `runDashboard`, not store state.
	 */
	setChannelState(id: string, up: boolean, url: string | null): void {
		this.channelState[id] = { up, url };
	}

	/** Fold a status-socket {@link RequestEvent} into the monitor + clients reducer. */
	applyEvent(event: RequestEvent): void {
		this.monitor.apply(event);
		this.events.push(event);
		while (this.events.length > this.monitorLimit) {
			this.events.shift();
		}
	}

	/** Fold a channel live-state report (server feed or probe) into the snapshot. */
	applyChannelState(id: string, up: boolean, url: string | null): void {
		this.setChannelState(id, up, url);
	}
}

/** Empty seed settings (no channels) for a freshly constructed store. */
function emptySettings(): Settings {
	return { version: 1, channels: [], defaultChannel: null, mcp: { allowedClients: [] } };
}
