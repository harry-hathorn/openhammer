/**
 * The dashboard render loop (spec 19 rebuild) — the **control center** entry
 * point. Builds the {@link DashboardStore} (live state), the {@link DashboardRoot}
 * (the navigable component tree), and the pi-tui {@link DashboardRenderer}; wires
 * the live status-socket feed + static-channel probe into the store; and connects
 * the root's {@link DashboardActions} to the real wizards/commands (each
 * `suspend()`s the loop, runs, `resume()`s, persists + updates the store on `ok`).
 * One process, one screen; blocks until the operator quits (`q`/Ctrl-C/Esc-at-menu).
 *
 * **A view over the running server, not a second host** (spec 19 line 49): the live
 * clients + monitor feed come from the status socket (the `subscribe` seam, 19c);
 * channels read `~/.openhammer/config.json` (settings) + the live channel-state
 * feed/probe. The dashboard *calls the existing functions* (`addChannel`/
 * `setSection`/`issueClient`/`removeChannel`/…) — there is no second copy of any
 * wizard, command, or the monitor. The only new code is the component tree
 * (`root.ts`/`screens.ts`/`view.ts`/`store.ts`) + this wiring.
 *
 * **Layering:** this module (`src/tui/`) imports only lower layers — the wizards
 * (`./wizards/`), the auth client ops (`../auth/oauth/clients.ts`), the channel
 * manage ops (`../tunnel/manage.ts`), settings (`../config/`). It does **not**
 * import `src/cli/`, so `doctor` is reached via the injected {@link
 * DashboardDeps.doctorRunner} seam (the CLI layer wires `doctorCommand`).
 *
 * **Shutdown order:** on quit the renderer is stopped first (terminal restored:
 * cooked mode, cursor, paste/Kitty sequences — the no-raw-mode-leak bar), then
 * `onQuit` runs best-effort (stops the server child). A thrown `onQuit` is caught
 * + logged to stderr — the terminal is already restored, so the message surfaces
 * in the operator's shell rather than corrupting the dashboard screen.
 */
import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import { type ClientInfo, type IssuedClient, hasOperatorLogin, issueClient, listClients, removeClient, setOperatorLogin } from "../auth/oauth/clients.ts";
import { credentialsPath } from "../config/credentials.ts";
import { type Settings, saveSettings, settingsPath } from "../config/settings.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
import { err, ok, type Result } from "../tools/result.ts";
import type { ChannelStateLine } from "../observability/status-socket.ts";
import { removeChannel as removeChannelOp, setDefaultChannel } from "../tunnel/manage.ts";
import type { BannerStream } from "./banner.ts";
import { collectClientConfig, toIssueOptions } from "./client-wizard.ts";
import { createDashboardRenderer, type DashboardRenderer } from "./dashboard/render.ts";
import { type DashboardActions, DashboardRoot } from "./dashboard/root.ts";
import { type ChannelLiveState, DashboardStore, emptyStatus, type ServerStatusState } from "./dashboard/store.ts";
import { createDefaultIo, type PromptIo } from "./prompts.ts";
import { runSpinner } from "./prompt-loop.ts";
import { style } from "./style.ts";
import { addChannel } from "./wizards/channel.ts";
import { setSection } from "./wizards/section.ts";

export { DASHBOARD_MONITOR_LIMIT } from "./dashboard/store.ts";
export type { IssuedClient };

/** A write-discarding stream — the wizards frame themselves via `runWizard`/`withSession`;
 * passing this as their `stream` keeps exactly one banner (printed below), not two. */
const silentStream: BannerStream = { write: () => false };

/**
 * Injectable seams for {@link runDashboard} (the `11a`/`13`/`17b`–`19d` precedent).
 * `settings` is required; the rest default to production (the real wizards/commands
 * over a real terminal). Tests inject a fake `terminal` + fake `actions` so the
 * hermetic trio never touches a TTY or `~/.openhammer`.
 */
export interface DashboardDeps {
	/** The settings doc — seeds the channels panel + the default-channel marker. */
	settings: Settings;
	/** Initial server status (19e populates from the running child). Defaults to "down"/unknown. */
	status?: ServerStatusState;
	/** Initial per-channel live state (19c populates from the server). Defaults to none. */
	channelState?: Record<string, ChannelLiveState>;
	/** Live event feed (19c wires this to the status socket). Omit for a static dashboard. */
	subscribe?: (
		onEvent: (event: RequestEvent) => void,
		onChannelState?: (state: ChannelStateLine) => void,
	) => () => void;
	/** Static-channel probe (19c-probe). Omit for a dashboard that does not probe channels. */
	probeChannels?: (
		report: (state: { id: string; up: boolean; url: string | null }) => void,
		isReported?: (id: string) => boolean,
	) => () => void;
	/** Monitor-feed depth. Defaults to {@link DASHBOARD_MONITOR_LIMIT}. */
	monitorLimit?: number;
	/**
	 * Run `doctor` and return the report text ("" if it could not run). The CLI layer
	 * wires this — `src/tui/` must not import `src/cli/doctor.ts`. The dashboard
	 * `suspend()`s the loop around it. Default returns "" (doctor unavailable).
	 */
	doctorRunner?: () => Promise<string>;
	/** pi-tui terminal for the renderer (tests inject a fake). Default: real `ProcessTerminal`. */
	terminal?: Terminal;
	/** Re-render cadence in ms (0 disables; tests drive renders manually). */
	refreshIntervalMs?: number;
	/** Override the action implementations (tests pass fakes). Defaults run the real flows. */
	actions?: Partial<DashboardActions>;
	/** Credentials path for the OAuth client ops (tests inject a temp). Default: {@link credentialsPath}. */
	credPath?: string;
	/** Persist the settings doc after a mutation (add/use/remove channel, edit settings). Default: {@link saveSettings}(`settingsPath()`, s). Tests inject a recorder to avoid disk. */
	persist?: (settings: Settings) => void;
	/** Shutdown hook (19e stops the server child). Best-effort — a throw is logged, not fatal. */
	onQuit?: () => void | Promise<void>;
	/**
	 * Restart the server child so a fresh boot picks up a config change the running
	 * child resolved once at boot — chiefly a new `defaultChannel` set from the
	 * dashboard (so adding a channel launches it live, no manual relaunch). The CLI
	 * layer wires this to {@link ServerControl.restart}; the dashboard calls it only
	 * when a mutation changes `defaultChannel` (a non-default add does not drop the
	 * active tunnel). Omit for a hermetic dashboard with no server (tests) — the
	 * actions then persist the change but skip the restart.
	 */
	restartServer?: () => Promise<Result<void, Error>>;
}

/**
 * Run the dashboard: build the store + root + renderer, wire the live feed + probe,
 * connect the actions, and block until the operator quits. Resolves once the
 * renderer is stopped + `onQuit` has settled, so the caller (the CLI) controls the
 * process lifecycle (it `await`s this then exits).
 *
 * The dashboard runs on the **alternate screen** (see `render.ts`); the banner
 * (printed once by `runCli`) stays on the main screen and reappears when the
 * dashboard exits. Modals (wizards/prompts) render in place on the alt screen via
 * the shared terminal, and `resume()` force-clears + redraws — so the screen never
 * blanks or freezes across a modal.
 */
export async function runDashboard(deps: DashboardDeps): Promise<void> {
	const credPath = deps.credPath ?? credentialsPath();
	const store = new DashboardStore({ monitorLimit: deps.monitorLimit }, deps.settings);
	store.setStatus(deps.status ?? emptyStatus());
	if (deps.channelState) {
		for (const [id, state] of Object.entries(deps.channelState)) {
			store.setChannelState(id, state.up, state.url);
		}
	}
	store.setOauthClients(listClientsSafe(credPath));
	store.setLoginConfigured(hasOperatorLogin(credPath));

	const persist =
		deps.persist ??
		((s: Settings): void => {
			saveSettings(settingsPath(), s);
		});

	// One shared terminal for the dashboard AND its modals. The renderer and the
	// prompt/wizard `io` both drive this same `ProcessTerminal`, so a modal's
	// `start`/`stop` cleanly hands stdin back to the dashboard (one instance, no two
	// `ProcessTerminal`s fighting over `process.stdin` — the freeze's root cause).
	const terminal = deps.terminal ?? new ProcessTerminal();
	const io = createDefaultIo({ terminal });

	// The renderer is created after the root (the root's actions reference it via this
	// holder). Captured in a local so `start`/`stop` see a defined `DashboardRenderer`
	// (the holder stays `| undefined` for the actions, which `?.` it).
	const ctx: { renderer: DashboardRenderer | undefined } = { renderer: undefined };
	const actions = buildActions(ctx, store, deps, credPath, persist, io);
	const root = new DashboardRoot({ store, style, actions, getRows: () => terminal.rows });
	const renderer = createDashboardRenderer({
		root,
		terminal,
		refreshIntervalMs: deps.refreshIntervalMs,
	});
	ctx.renderer = renderer;

	let unsub: (() => void) | undefined;
	let unsubProbe: (() => void) | undefined;
	/** Channel ids the server has authoritatively reported (the active channel). */
	const serverReported = new Set<string>();

	await new Promise<void>((resolve) => {
		let settled = false;
		/** Quit: idempotent. Restore the terminal first, then run the best-effort shutdown hook. */
		const quit = async (): Promise<void> => {
			if (settled) return;
			settled = true;
			unsub?.();
			unsubProbe?.();
			renderer.stop();
			try {
				await deps.onQuit?.();
			} catch (e) {
				console.error(`dashboard shutdown error: ${e instanceof Error ? e.message : String(e)}`);
			}
			resolve();
		};

		// Wire quit into the actions (the root calls actions.quit() on q/Ctrl-C/Esc-at-menu).
		actions.quit = () => void quit();

		// The live feed: 19c's subscriber delivers parsed events (recent dump first, then
		// live). Each folds into the monitor ring + clients reducer; channel-state lines
		// mark the channel server-reported (authoritative) and fold into the snapshot.
		unsub = deps.subscribe?.(
			(event) => store.applyEvent(event),
			(state) => {
				serverReported.add(state.id);
				store.applyChannelState(state.id, state.up, state.url);
				// An up channel with a URL is the active tunnel (e.g. ngrok) — surface it on
				// the Status screen too, so the operator sees the live URL without drilling in.
				if (state.up && state.url !== null) {
					store.setStatus({ ...store.status, publicUrl: state.url });
				} else if (store.status.publicUrl !== null && store.channels.some((c) => c.id === state.id)) {
					// The active channel went down — drop the stale tunnel URL from Status.
					store.setStatus({ ...store.status, publicUrl: null });
				}
			},
		);

		// The static-channel probe fills the channels the server has NOT reported, so the
		// server stays authoritative for the active channel and the probe fills the rest.
		unsubProbe = deps.probeChannels?.(
			(state) => {
				if (!serverReported.has(state.id)) store.applyChannelState(state.id, state.up, state.url);
			},
			(id) => serverReported.has(id),
		);

		// The banner prints once via `runCli` (on every interactive launch), so it is
		// already in scrollback above the TUI by the time the dashboard runs — do NOT
		// reprint it here. Enter raw mode + the render loop directly.
		renderer.start();
		// All setup is synchronous; the promise resolves only when `quit` runs (from an
		// actions.quit() keypress). The renderer's refresh cadence keeps the event loop
		// alive while the dashboard runs.
	});
}

/**
 * Build the {@link DashboardActions} the root calls. Each default `suspend()`s the
 * loop, runs the real wizard/command, `resume()`s, persists + updates the store on
 * `ok`, and returns the `Result` for the root to flash. `deps.actions` overrides
 * individual actions (tests pass fakes); a fake takes precedence over the production
 * default. The `doctor` action wraps the CLI-injected `doctorRunner` in the
 * suspend/resume pair (the runner itself stays CLI-side, respecting layering).
 * `quit` is assigned later by `runDashboard` (it owns the lifecycle).
 */
function buildActions(
	ctx: { renderer: DashboardRenderer | undefined },
	store: DashboardStore,
	deps: DashboardDeps,
	credPath: string,
	persist: (s: Settings) => void,
	io: PromptIo,
): DashboardActions {
	const overrides = deps.actions ?? {};

	/** Suspend the loop, run a TUI modal (a wizard/prompt), resume (always). */
	const withModal = async <T>(fn: () => Promise<T>): Promise<T> => {
		ctx.renderer?.suspend();
		try {
			return await fn();
		} finally {
			ctx.renderer?.resume();
		}
	};

	/**
	 * Restart the server when a mutation changed `defaultChannel`, so the fresh boot
	 * raises/lowers the active channel live — adding the first channel launches it,
	 * switching default switches the tunnel, removing the active channel falls back
	 * to localhost-only. A non-default add/remove leaves `defaultChannel` unchanged,
	 * so the active tunnel is NOT dropped for an unrelated change. The stale tunnel
	 * URL is cleared for the restart window; the new boot's channel-state restores it
	 * (the status-socket subscriber reconnects on its own). No-op when no
	 * `restartServer` is wired (hermetic dashboard / no server) — the change still
	 * persists. The spinner runs inside `withModal` so the operator sees the restart.
	 */
	const restartIfDefaultChanged = async (before: Settings, after: Settings): Promise<void> => {
		if (before.defaultChannel === after.defaultChannel) return;
		const restart = deps.restartServer;
		if (!restart) return;
		store.setStatus({ ...store.status, publicUrl: null });
		await withModal(() =>
			runSpinner("Restarting server to apply the channel…", () => restart(), (r) =>
				r.ok ? "server restarted" : `restart failed: ${r.error.message}`),
		);
	};

	const addChannelAction: DashboardActions["addChannel"] =
		overrides.addChannel ??
		(async () => {
			const before = store.settings;
			const result = await withModal(() => addChannel(before, { io, stream: silentStream }));
			if (result?.ok) {
				persist(result.value);
				store.setSettings(result.value);
				await restartIfDefaultChanged(before, result.value);
			}
			return result;
		});

	const editSettingsAction: DashboardActions["editSettings"] =
		overrides.editSettings ??
		(async () => {
			const before = store.settings;
			const result = await withModal(() => setSection(before, { io, stream: silentStream }));
			if (result?.ok) {
				persist(result.value);
				store.setSettings(result.value);
				await restartIfDefaultChanged(before, result.value);
			}
			return result;
		});

	const issueClientAction: DashboardActions["issueClient"] =
		overrides.issueClient ??
		(async () => {
			// The add-client prompt (a label) runs on the dashboard's shared terminal (clean
			// stdin handoff — no second terminal). The wizard issues a machine
			// (client_credentials) client; login clients are not created manually. The issue
			// itself is a sync domain call.
			ctx.renderer?.suspend();
			let config: Awaited<ReturnType<typeof collectClientConfig>>;
			try {
				config = await collectClientConfig(io);
			} finally {
				ctx.renderer?.resume();
			}
			if (config === null) return null; // cancelled — silent
			const result = issueClient(config.label, toIssueOptions(config), credPath);
			if (result.ok) store.setOauthClients(listClientsSafe(credPath));
			return result;
		});

	const removeChannelAction: DashboardActions["removeChannel"] =
		overrides.removeChannel ??
		(async (id: string) => {
			const before = store.settings;
			const result = removeChannelOp(before, id);
			if (result.ok) {
				persist(result.value);
				store.setSettings(result.value);
				await restartIfDefaultChanged(before, result.value);
			}
			return result;
		});

	const useChannelAction: DashboardActions["useChannel"] =
		overrides.useChannel ??
		(async (id: string) => {
			const before = store.settings;
			const result = setDefaultChannel(before, id);
			if (result.ok) {
				persist(result.value);
				store.setSettings(result.value);
				await restartIfDefaultChanged(before, result.value);
			}
			return result;
		});

	const removeClientAction: DashboardActions["removeClient"] =
		overrides.removeClient ??
		(async (clientId: string) => {
			const result = removeClient(clientId, credPath);
			if (result.ok) store.setOauthClients(listClientsSafe(credPath));
			return result;
		});

	const runDoctorAction: DashboardActions["runDoctor"] = async () => {
		const runner = deps.doctorRunner ?? (async () => "");
		return withModal(() => runner());
	};

	// `setLogin` mirrors the CLI `auth set-login`: prompt username + password, call
	// `setOperatorLogin`, and refresh `store.loginConfigured` so the Clients screen reflects
	// it next frame. This is the gate login (authorization-code) clients authenticate against
	// at `/authorize` — surfacing it in the dashboard (it was CLI-only) is the root-cause fix
	// for "I added an auth-code client but Claude's login failed."
	const setLoginAction: DashboardActions["setLogin"] =
		overrides.setLogin ??
		(async () => {
			const creds = await withModal(async () => {
				const username = await io.text({ message: "Operator username" });
				if (username === null) return null;
				const password = await io.password({ message: "Operator password" });
				if (password === null) return null;
				return { username, password };
			});
			if (creds === null) return null; // cancelled — silent
			if (creds.username.trim() === "" || creds.password === "") {
				return err(new Error("Username and password are required"));
			}
			try {
				setOperatorLogin(creds.username.trim(), creds.password, credPath);
			} catch (e) {
				return err(e instanceof Error ? e : new Error(String(e)));
			}
			store.setLoginConfigured(true);
			return ok(undefined);
		});

	// `quit` is assigned by runDashboard (it owns the lifecycle/`onQuit`); a placeholder
	// here satisfies the interface so the root can be constructed before that wiring.
	const actions: DashboardActions = {
		addChannel: addChannelAction,
		editSettings: editSettingsAction,
		issueClient: issueClientAction,
		removeChannel: removeChannelAction,
		useChannel: useChannelAction,
		removeClient: removeClientAction,
		setLogin: setLoginAction,
		runDoctor: runDoctorAction,
		quit: () => {},
	};
	return actions;
}

/** Read the registered OAuth clients; never throws (a missing/unreadable file → []). */
function listClientsSafe(credPath: string): ClientInfo[] {
	try {
		return listClients(credPath);
	} catch {
		return [];
	}
}
