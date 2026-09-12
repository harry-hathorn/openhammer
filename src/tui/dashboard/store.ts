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
import { goldenManifestExists } from "../../config/sections.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { defaultSettings } from "../../config/settings.ts";
import { resolveConfig } from "../../config.ts";
import type { ClientStat, RequestEvent } from "../../mcp/telemetry.ts";
import { parseVmStateLine, type VmStateLine } from "../../observability/status-socket.ts";
import { MonitorState } from "../monitor-view.ts";

/** Default monitor-feed depth — the last N events shown in the monitor screen. */
export const DASHBOARD_MONITOR_LIMIT = 8;

/** Build-progress ring cap — the tail a long golden build leaves behind stays bounded. */
export const BUILD_LOG_LIMIT = 400;

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
 * "unknown" — distinct from `up:false` (reported down). `error` (28j, additive)
 * carries the server's actionable down-reason when it reported one.
 */
export interface ChannelLiveState {
	up: boolean;
	url: string | null;
	error?: string | null;
}

/** Injection seam for {@link DashboardStore} (the `11a`/`13`/`17b`–`19d` precedent). */
export interface DashboardStoreDeps {
	/** Monitor-feed depth (the events ring cap). Defaults to {@link DASHBOARD_MONITOR_LIMIT}. */
	monitorLimit?: number;
	/**
	 * The env the effective guest root resolves against ({@link DashboardStore.vmRoot}).
	 * Defaults to `process.env`; tests inject a literal to stay hermetic.
	 */
	env?: NodeJS.ProcessEnv;
	/**
	 * The guest-username seam behind the vm-mode root default (`/home/<guestUser>`).
	 * Defaults to `resolveConfig`'s own (the spec-26 guest-config doc read); tests
	 * inject a literal so the vm-root path never touches disk.
	 */
	guestUser?: () => string;
	/**
	 * The golden-manifest probe behind {@link DashboardStore.hasGolden} (the
	 * Install-item's visibility, spec 28 box 28c). Defaults to
	 * `goldenManifestExists` (config/sections.ts) — the SAME probe the vm write
	 * guard runs, so the affordance and the guard can never disagree. Tests inject
	 * a constant; like `guestUser`, the default is lazy (getter) so stores that
	 * never render the Sandbox screen never touch disk.
	 */
	goldenExists?: () => boolean;
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
	/** Whether the global operator login is configured (the `/authorize` gate for login clients). */
	loginConfigured = false;
	/**
	 * The LATEST vm-state line (spec 27h), held exactly like {@link channelState}
	 * holds channel reports: the most recent wins. `null` = nothing observed yet
	 * (an off-mode server emits no vm-state lines, ever — the zero-VM-code pin).
	 */
	latestVmState: VmStateLine | null = null;
	/**
	 * Sticky: has any vm-state line with state ≠ `off` ever arrived? The Sandbox
	 * entry's escape hatch (spec 28 off-mode invisibility) — once the server
	 * reports a live VM lifecycle, the entry appears even if the settings doc
	 * still says `off` (a boot-time `MCP_VM_MODE` override the doc lags behind).
	 */
	vmObserved = false;
	/**
	 * True when a vm settings write is SAVED but not yet applied by a running
	 * server (spec 28, matrix row 3): the dashboard restarted nothing (no
	 * `restartServer` seam — unowned/hermetic) or its restart attempt failed. The
	 * settings/sandbox surfaces render the apply-on-restart affordance from this
	 * (the flash + the header `note:` row); a successful apply clears it. It is a
	 * hint, not state authority — a server restarted OUTSIDE the dashboard (the
	 * operator's own `openhammer` relaunch) also applies the change without
	 * touching this flag; the note merely stays until a dashboard-visible apply
	 * succeeds.
	 */
	vmApplyPending = false;
	/**
	 * The golden-build progress ring (28j's build chain): the chained
	 * install → provision → snapshot appends its `{log}` lines here (newest last,
	 * capped at {@link BUILD_LOG_LIMIT}), and the build drill-in renders it LIVE —
	 * unlike the serial snapshot, this re-reads every tick while the chain runs.
	 */
	readonly buildLog: string[] = [];

	/** The connected-client reducer (call counts + last-seen), reused from monitor. */
	private readonly monitor: MonitorState;
	/** The recent-event ring (newest last), capped at the monitor limit. */
	private readonly events: RequestEvent[] = [];
	/** The events-ring cap. */
	private readonly monitorLimit: number;
	/** The env {@link vmRoot} resolves against (injectable for hermetic tests). */
	private readonly env: NodeJS.ProcessEnv;
	/** The guest-username seam {@link vmRoot} resolves through (injectable; avoids disk). */
	private readonly guestUser: (() => string) | undefined;
	/** Memoized guest-root value; `undefined` = not computed yet, `null` = unresolvable. */
	private vmRootCache: string | null | undefined = undefined;
	/** The golden-manifest probe {@link hasGolden} resolves through (injectable; avoids disk). */
	private readonly goldenExists: () => boolean;
	/** Memoized has-golden value; `undefined` = not computed yet (lazy, like {@link vmRootCache}). */
	private hasGoldenCache: boolean | undefined = undefined;

	/**
	 * @param deps.monitorLimit the events-ring cap; `env`/`guestUser` the guest-root
	 * resolution seams (defaults: `process.env` / the spec-26 guest doc); `goldenExists`
	 * the Install-item visibility probe (default: the real newest-golden scan).
	 * @param initial the seed settings (channels/default/mcp); defaults to empty.
	 */
	constructor(deps: DashboardStoreDeps = {}, initial: Settings = emptySettings()) {
		this.monitor = new MonitorState();
		this.monitorLimit = deps.monitorLimit ?? DASHBOARD_MONITOR_LIMIT;
		this.settings = initial;
		this.env = deps.env ?? process.env;
		this.guestUser = deps.guestUser;
		this.goldenExists = deps.goldenExists ?? goldenManifestExists;
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

	/** Update the operator-login-configured flag (after `set-login` or on construction). */
	setLoginConfigured(value: boolean): void {
		this.loginConfigured = value;
	}

	/** Set the saved-but-not-applied vm settings flag (the row-3 apply affordance's source). */
	setVmApplyPending(value: boolean): void {
		this.vmApplyPending = value;
	}

	/** Append one build-progress line to the ring (capped — a 45-minute install must not grow unbounded). */
	appendBuildLog(line: string): void {
		this.buildLog.push(line);
		while (this.buildLog.length > BUILD_LOG_LIMIT) {
			this.buildLog.shift();
		}
	}

	/**
	 * Invalidate the {@link hasGolden} memo so the next read re-probes (28j): the
	 * build chain's completion MANDATES this — the memo never invalidated before,
	 * so a golden built mid-session left the Install row (and Start's no-golden
	 * guard) reading a stale `no golden` until the dashboard restarted.
	 */
	refreshGolden(): void {
		this.hasGoldenCache = undefined;
	}

	/**
	 * Set one channel's live reachability. Both the status-socket feed (server-reported)
	 * and the static-channel probe funnel through here — the "server stays authoritative"
	 * gating is wiring policy in `runDashboard`, not store state. The row REPLACES
	 * wholesale, so an up report (or a probe report, which carries no error) clears a
	 * stale down-reason.
	 */
	setChannelState(id: string, up: boolean, url: string | null, error?: string | null): void {
		this.channelState[id] = error !== undefined ? { up, url, error } : { up, url };
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
	applyChannelState(id: string, up: boolean, url: string | null, error?: string | null): void {
		this.setChannelState(id, up, url, error);
	}

	/**
	 * Parse one NDJSON line as a vm-state report and hold it (spec 28 — the
	 * additive-parse rule's store-side twin of `parseChannelStateLine`'s client):
	 * a `null` parse (blank, malformed, a `RequestEvent`, a channel-state line, or
	 * a future/unknown line kind) is a no-op — the store is unharmed, never
	 * throws. A valid line REPLACES {@link latestVmState} (latest wins) and sets
	 * the sticky {@link vmObserved} when its state ≠ `off`. The single vm-state
	 * parse point: the socket feed forwards the raw line, the store narrows it.
	 */
	applyVmStateLine(line: string): void {
		const parsed = parseVmStateLine(line);
		if (parsed === null) return;
		this.latestVmState = parsed;
		if (parsed.state !== "off") this.vmObserved = true;
	}

	/**
	 * The effective guest root (spec 28, matrix row 9) — `null` hides the
	 * `guest root:` row. `null` when the loaded settings' vm mode is `off` (the
	 * zero-VM-code pin at the dashboard layer: an off user's session reads no vm
	 * config and resolves nothing), and `null` when the env is unresolvable (the
	 * same fail-fatal `MCP_VM_*` table `resolveConfig` enforces at boot — a stale
	 * shell value must never crash a render; the row hides instead). Otherwise the
	 * value is `resolveConfig(...).rootDir` — the exact path a boot takes, so the
	 * dashboard row, doctor's `vm-root` check, and a real boot can never drift.
	 * Computed once per store (the value depends on env + the guest doc, not on
	 * the mutable settings), memoized across reads.
	 */
	get vmRoot(): string | null {
		if (this.settings.vm.mode === "off") return null;
		if (this.vmRootCache === undefined) {
			try {
				this.vmRootCache = resolveConfig({}, this.env, this.settings, { guestUser: this.guestUser }).rootDir;
			} catch {
				// Unresolvable env (a malformed MCP_VM_* in a vm mode): degrade to hidden.
				this.vmRootCache = null;
			}
		}
		return this.vmRootCache;
	}

	/**
	 * Does a bootable golden exist (spec 28, box 28c)? Gates the Sandbox screen's
	 * *Install sandbox* row — the item is HIDDEN when this is true ("shown only
	 * when no golden manifest exists"). The probe is the SAME one the vm write
	 * guard runs (`goldenManifestExists`, preflight's exact check-5 posture: the
	 * NEWEST golden's manifest must be valid), so the affordance and the guard can
	 * never disagree. Lazy + memoized like {@link vmRoot} — stores that never
	 * render the Sandbox screen never touch disk.
	 */
	get hasGolden(): boolean {
		if (this.hasGoldenCache === undefined) {
			this.hasGoldenCache = this.goldenExists();
		}
		return this.hasGoldenCache;
	}
}

/** Empty seed settings (no channels) for a freshly constructed store. */
function emptySettings(): Settings {
	return defaultSettings();
}
