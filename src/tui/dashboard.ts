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
 *
 * **The owned/unowned wiring state (spec 28, box 28c; tiered since 28i):** NO
 * production path runs the dashboard and the `VmService` in ONE process. Bare
 * `openhammer` in a terminal opens the dashboard, which starts the server as a
 * CHILD process (`server-control.ts`'s `ensureServer` → `node dist/main.js`);
 * `openhammer start` / the headless default run `main()` in-process but with NO
 * dashboard. The Sandbox lifecycle actions are therefore TIERED: a `vmService`
 * handle (tests; a future in-process entry) takes the direct service path; the
 * production default rides `deps.sendVmCommand` — operator commands over the
 * status socket's 0600 command intake (28i: `vm-stop`/`vm-restart`, accepted-
 * not-completed, progress on the vm-state feed) — which works for spawn-owned
 * AND attached dashboards alike; with neither, activations surface
 * {@link VM_UNOWNED_HINT}, never a dead button. Serial tail is gate-free since
 * 28i (a same-host file derived from the vm-state line's sessionId); Install
 * keeps the ownership gate until the build-chain box wires it ungated.
 * Restart-to-apply (matrix row 3) rides `deps.restartServer` (`ServerControl`
 * `.restart`, the child re-spawn whose fresh boot re-runs preflight + the eager
 * VM boot), which the CLI wiring provides in production; an attached server gets
 * the restart refusal surfaced + the "restart openhammer to apply" hint, and an
 * unwired (hermetic) dashboard gets the hint alone.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ProcessTerminal, type Terminal } from "@earendil-works/pi-tui";
import {
	type ClientInfo,
	hasOperatorLogin,
	type IssuedClient,
	issueClient,
	listClients,
	removeClient,
	setOperatorLogin,
} from "../auth/oauth/clients.ts";
import { credentialsPath } from "../config/credentials.ts";
import { type ConfigSection, NO_GOLDEN_GUARD_MESSAGE, vmSection } from "../config/sections.ts";
import { type Settings, saveSettings, settingsPath } from "../config/settings.ts";
import type { RequestEvent } from "../mcp/telemetry.ts";
import type { ChannelStateLine, VmCommandName } from "../observability/status-socket.ts";
import { err, ok, type Result } from "../tools/result.ts";
import { removeChannel as removeChannelOp, setDefaultChannel } from "../tunnel/manage.ts";
import type { VmBootGate } from "../vm/boot-backend.ts";
import { runInstall } from "../vm/provision/install.ts";
import type { ManifestFlavor } from "../vm/provision/snapshot.ts";
import { resolveVmDirs } from "../vm/session.ts";
import type { BannerStream } from "./banner.ts";
import { collectClientConfig, toIssueOptions } from "./client-wizard.ts";
import { createDashboardRenderer, type DashboardRenderer } from "./dashboard/render.ts";
import { type DashboardActions, DashboardRoot, type InstallOutcome } from "./dashboard/root.ts";
import { type ChannelLiveState, DashboardStore, emptyStatus, type ServerStatusState } from "./dashboard/store.ts";
import { hasPublicChannel, type SerialSource, vmSessionActive, vmSettingsEqual } from "./dashboard/view.ts";
import { sendVmCommand } from "./dashboard/vm-commands.ts";
import { runSpinner } from "./prompt-loop.ts";
import { createDefaultIo, type PromptIo } from "./prompts.ts";
import { style } from "./style.ts";
import { addChannel } from "./wizards/channel.ts";
import {
	newestGoldenFlavor,
	newestGoldenGuestUser,
	runApplyAgent,
	runApplyTheme,
	runGuestSetup,
	runProvisionEditor,
	runSecretsSetup,
} from "./wizards/guest-setup.ts";
import { type SetSectionResult, setSection } from "./wizards/section.ts";

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
		/** vm-state lines (spec 28): the RAW NDJSON line — the store parses + holds it. */
		onVmState?: (line: string) => void,
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
	 * child resolved once at boot — a new `defaultChannel` set from the dashboard
	 * (so adding a channel launches it live, no manual relaunch), and since box 28c
	 * any vm settings write (spec 28, matrix row 3: the child's fresh boot re-runs
	 * preflight + the eager VM boot, which IS the vm apply path). The CLI layer
	 * wires this to {@link ServerControl.restart}; when it errs (an attached server
	 * the dashboard did not start) the refusal surfaces and the change is marked
	 * pending instead. Omit for a hermetic dashboard with no server (tests) — vm
	 * writes then persist the change and set the apply-on-restart pending flag
	 * (the "restart openhammer to apply" hint), never silently dropping it.
	 */
	restartServer?: () => Promise<Result<void, Error>>;
	/**
	 * The VM access seam (spec 28, box 28b) — the OWNED-server gate behind the
	 * Sandbox screen's actions (Stop / Restart / Serial tail). Returns the live
	 * `VmService` handle when the dashboard acts on a server whose process it is
	 * IN (the service handle exists here); `null` (or an absent dep) when the
	 * dashboard is a view over ANOTHER process's server — attached via the status
	 * socket, read-only telemetry, no action path exists (the default today: the
	 * CLI wiring runs the server as a child process, so no handle lives here).
	 * Unowned activations surface the unowned hint; the service is never touched.
	 *
	 * Typed as {@link VmBootGate} — the repo's structural `VmService` alias
	 * (`VmService` satisfies it; boot-backend.ts names it for exactly this) — so
	 * tests inject a scripted gate with no cast, the `server-control.ts`
	 * `ServerChild` rationale.
	 */
	vmService?: () => VmBootGate | null;
	/**
	 * Override the session serial-log reader (tests inject fixture content).
	 * Default: {@link readSerialLog} — the real
	 * `<HOME>/.openhammer/vm/sessions/<sessionId>/serial.log` read.
	 */
	readSerial?: (sessionId: string) => Promise<Result<SerialSource, Error>>;
	/**
	 * The operator-command sender (28i): Stop/Restart reach the server's VM
	 * service through the status socket's command intake when no `VmService`
	 * handle exists (the child-process split — see the module header). Default:
	 * the real {@link sendVmCommand} over the loopback socket; tests inject a
	 * scripted fake. Consulted only when `vmService` is absent/null (the owned
	 * direct path wins when a handle exists).
	 */
	sendVmCommand?: (cmd: VmCommandName) => Promise<Result<void, Error>>;
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
	const actions = buildActions(ctx, store, deps, credPath, persist, io, terminal);
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
			// vm-state lines (spec 28): the raw line — the store parses (skipping
			// unknown kinds) and holds the latest for the Sandbox entry.
			(line) => store.applyVmStateLine(line),
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

// ---- the Sandbox actions (spec 28, box 28b) -------------------------------------

/**
 * The unowned-server hint — the exact line a Sandbox action activation flashes
 * when the dashboard holds no VM service handle (it is a view over another
 * process's server). ServerControl.restart()'s refusal voice ("cannot restart a
 * server the dashboard did not start"), pointed at the fix.
 */
export const VM_UNOWNED_HINT = "the dashboard doesn't own this server — restart openhammer to manage the sandbox there";

/**
 * The single-flight line (spec 28 edge case): a second Sandbox action while one
 * is in flight errs with this, flashed inline. The UI guard is for UX only —
 * `VmService` itself is the single-flight authority (one VM per process, spec
 * 27e: `start()` while booting awaits the in-flight boot; `stop()` owns teardown
 * via the epoch guard).
 */
export const VM_IN_FLIGHT_HINT = "a sandbox action is already in flight — wait for it to settle";

/** The Stop confirmation's modal message (the matrix-row-4 semantics, restated). */
export const SANDBOX_STOP_CONFIRM_MESSAGE =
	"Stop the sandbox now? The boot-scoped mode re-boots it on the next server start — the lasting stop is mode off + restart.";

/**
 * The row-1 mode-select confirm's modal message (spec 28, matrix row 1 — the
 * headline interplay): switching `vm`/`agent` → `off` while a public channel is
 * configured must warn, verbatim, that "on restart your HOST filesystem becomes
 * the publicly exposed surface". The predicate deciding WHEN this fires is
 * `hasPublicChannel` (view.ts — documented there); `off → vm` needs NO warning
 * (containment only increases). Declining keeps the mode: nothing is persisted.
 * Lives in the dashboard wiring (not `vmSection.write`) because a confirm needs
 * io — a sync write cannot ask; see the sections.ts header for the placement
 * rationale + the bare-CLI gap.
 */
export const VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE =
	"Boot mode off while a public channel is configured — on restart your HOST filesystem becomes the publicly exposed surface. Save anyway?";

/** The session dir's serial-log file name — service.ts's SESSION_SERIAL_NAME, restated (not exported there). */
const SERIAL_LOG_FILE = "serial.log";

/**
 * The default serial-log reader: `<HOME>/.openhammer/vm/sessions/<sessionId>/serial.log`
 * (spec 28's Serial tail source). A missing file is the expected empty case →
 * `err("no serial yet")`; any other read failure names its cause. `homeDir`
 * overrides `os.homedir()` (tests point the whole vm tree at a temp HOME).
 */
export async function readSerialLog(sessionId: string, homeDir?: string): Promise<Result<SerialSource, Error>> {
	const path = join(resolveVmDirs({ homeDir }).sessions, sessionId, SERIAL_LOG_FILE);
	try {
		const bytes = await readFile(path);
		return ok({ content: bytes.toString("utf8"), totalBytes: bytes.byteLength });
	} catch (e) {
		if (e instanceof Error && "code" in e && e.code === "ENOENT") {
			return err(new Error("no serial yet"));
		}
		return err(new Error(`cannot read the session serial log: ${e instanceof Error ? e.message : String(e)}`));
	}
}

/** Deps for {@link createSandboxActions} (the exported, unit-testable core the buildActions wiring wraps). */
export interface SandboxActionDeps {
	/** Tier 1 — the direct service handle ({@link DashboardDeps.vmService}); null → the socket tier. */
	readonly vmService?: () => VmBootGate | null;
	/** The serial-log reader. Default: {@link readSerialLog} over the real HOME. */
	readonly readSerial?: (sessionId: string) => Promise<Result<SerialSource, Error>>;
	/** The live store — the serial read's sessionId comes from the latest vm-state line. */
	readonly store: Pick<DashboardStore, "latestVmState">;
	/**
	 * The socket-command sender (28i) — the MIDDLE tier of the gate: used when
	 * `vmService` holds no handle but the server's status-socket command intake
	 * is reachable (the production shape: the server is a child process, the
	 * handle can never exist here). Absent → the unowned hint (tier 3).
	 */
	readonly sendCommand?: (cmd: VmCommandName) => Promise<Result<void, Error>>;
	/**
	 * The golden-build seam (spec 28, box 28c): launches 26c's {@link runInstall} —
	 * the session-kept, evidence-throwing install runner. `log` receives the run's
	 * progress lines (the dashboard passes a discard sink: the spinner is the live
	 * surface and the session's `install.log` holds the lines). Default: the real
	 * `runInstall` with default options (the 45-minute budget etc.).
	 */
	readonly install?: (log: (line: string) => void) => Promise<InstallOutcome>;
}

/**
 * The Sandbox actions' core (spec 28, box 28b; install added in 28c; tiered in
 * 28i): the three-tier owned/socket/hint gate, the UI single-flight guard, and
 * the service/command calls. Exported
 * so the hermetic trio can drive them on a scripted gate (the buildActions wiring
 * wraps Stop's `io.confirm` modal around this and honors the per-action overrides).
 *
 * Semantics: `stopSandbox` = `service.stop()` — the clean ACPI powerdown + stop
 * ladder + persist teardown (27e). `restartSandbox` = `await service.stop()` then
 * `void service.start()` — a fresh boot per the persist rules (retain reuses the
 * overlay, discard is fresh; the service owns those semantics). On the socket
 * tier the SAME verbs ride one command each (`vm-stop`/`vm-restart`): the
 * server-side executor owns the stop-then-start sequencing and the reply means
 * accepted, not completed — progress is the vm-state feed. `installSandbox`
 * runs the install seam to completion and reports the session dir. Surfaced
 * results flow through the vm-state line (service transitions → status socket →
 * socket client → store, 27h), so no direct render poke exists or is needed. The
 * in-flight guard covers only the action's awaited window; the service is the
 * authority beyond it (`start()` is idempotent while booting), and for install
 * `runInstall`'s own single-flight scan (26c: refuses while a session is live —
 * matrix row 5) is the authority.
 */
export function createSandboxActions(
	deps: SandboxActionDeps,
): Pick<DashboardActions, "stopSandbox" | "restartSandbox" | "readSerial" | "installSandbox"> {
	// The three-tier gate (28i). Tier 1: a direct `VmService` handle (tests; a
	// future in-process entry) — the direct service path unchanged. Tier 2: the
	// status-socket command sender — the PRODUCTION shape (the server is a child
	// process; the handle can never exist here), working for spawn-owned and
	// attached dashboards alike. Tier 3: the unowned hint, never a dead button.
	const directGate = (): VmBootGate | null => deps.vmService?.() ?? null;
	const sendCommand = deps.sendCommand;
	let inFlight = false; // the UX guard — VmService itself is the single-flight authority (27e)

	/** Wrap one action body in the single-flight guard (shared by every tier). */
	const guarded = async <T>(run: () => Promise<Result<T, Error>>): Promise<Result<T, Error>> => {
		if (inFlight) return err(new Error(VM_IN_FLIGHT_HINT));
		inFlight = true;
		try {
			return await run();
		} catch (e) {
			return err(e instanceof Error ? e : new Error(String(e)));
		} finally {
			inFlight = false;
		}
	};

	const stopSandbox: DashboardActions["stopSandbox"] = () => {
		const gate = directGate();
		if (gate !== null) {
			return guarded(async () => {
				await gate.stop(); // the 27e clean stop, direct
				return ok(undefined);
			});
		}
		if (sendCommand === undefined) return Promise.resolve(err(new Error(VM_UNOWNED_HINT)));
		return guarded(() => sendCommand("vm-stop"));
	};

	const restartSandbox: DashboardActions["restartSandbox"] = () => {
		const gate = directGate();
		if (gate !== null) {
			return guarded(async () => {
				await gate.stop(); // teardown now — the 27e clean stop
				void gate.start(); // fresh boot per the persist rules; the vm-state line reports booting
				return ok(undefined);
			});
		}
		if (sendCommand === undefined) return Promise.resolve(err(new Error(VM_UNOWNED_HINT)));
		// The server-side restart: stop() then the re-arming start() — accepted,
		// not completed; the vm-state feed reports the boot it kicked off.
		return guarded(() => sendCommand("vm-restart"));
	};

	const installSandbox: DashboardActions["installSandbox"] = () => {
		// The ownership gate KEPT here (28i): the socket commands carry only the
		// lifecycle verbs, and install writes the LOCAL vm tree — the build-chain
		// box lifts this gate when install becomes a first-class ungated chain.
		// A live session makes a concurrent install a fight over KVM/RAM —
		// runInstall's own single-flight scan refuses that with its actionable
		// evidence (matrix row 5).
		const gate = directGate();
		if (gate === null) return Promise.resolve(err(new Error(VM_UNOWNED_HINT)));
		return guarded(async () => {
			const install = deps.install ?? ((log: (line: string) => void) => runInstall({ log }, {}));
			const result = await install(() => {}); // progress: the spinner (wiring) is the live surface
			return ok({ sessionDir: result.sessionDir });
		});
	};

	const readSerial: DashboardActions["readSerial"] = async () => {
		// GATE-FREE since 28i: the serial log is a file derived from the vm-state
		// line's sessionId — the same loopback file for an owned or an attached
		// (same-host) dashboard — so no ownership gate; the no-session check is
		// the only precondition.
		const sessionId = deps.store.latestVmState?.sessionId ?? null;
		if (sessionId === null) return err(new Error("no serial yet"));
		const read = deps.readSerial ?? ((id: string) => readSerialLog(id));
		return read(sessionId);
	};

	return { stopSandbox, restartSandbox, readSerial, installSandbox };
}

// ---- the Start action (28j): the one-action sandbox launch -----------------------

/** The base-flavor confirm's modal message (the Start-time flavor gate, 28j). */
export const SANDBOX_AGENT_BASE_FLAVOR_CONFIRM =
	"The golden image is base flavor — the agent CLI is not pre-installed, so in agent mode the agent session dies at launch (the sandbox itself boots fine). Rebuild first: Guest setup, then Install sandbox. Start in agent mode anyway?";

/** The attached off-mode Start's honest err — the mode is saved; only a relaunch can raise the sandbox. */
export const SANDBOX_START_ATTACHED_OFF_HINT =
	"boot mode saved — restart openhammer to boot the sandbox (the dashboard did not start this server, so it cannot re-spawn it)";

/**
 * Deps for {@link createStartSandboxAction} — the exported, unit-testable Start
 * core the buildActions wiring wraps (the createSandboxActions precedent). The
 * io-bearing pieces (the mode pick, the confirm modal) arrive as seams.
 */
export interface StartSandboxDeps {
	/** The live store: the configured mode, the golden probe, the doc adoption + pending flag. */
	readonly store: Pick<DashboardStore, "settings" | "setSettings" | "setVmApplyPending" | "hasGolden">;
	/** The mode picker for an off-mode start (the wiring's io.select). `null` = cancelled. */
	readonly pickMode: () => Promise<"vm" | "agent" | null>;
	/** The confirm modal (the wiring wraps `io.confirm` + the suspend/resume pair). */
	readonly confirm: (message: string) => Promise<boolean | null>;
	/** Persist the settings doc when Start flips the mode (the runDashboard `persist` seam). */
	readonly persist: (s: Settings) => void;
	/**
	 * The child re-spawn seam ({@link DashboardDeps.restartServer}) — the off-mode
	 * dispatch: the tool backend is boot-scoped, so an OFF server has no sandbox
	 * process to command; the fresh boot resolves the persisted mode and runs
	 * preflight + the eager boot (27f). Absent → the honest attached hint err.
	 */
	readonly restartServer?: () => Promise<Result<void, Error>>;
	/** The socket-command sender (the vm/agent dispatch). Absent → the unowned hint. */
	readonly sendCommand?: (cmd: VmCommandName) => Promise<Result<void, Error>>;
	/** The newest golden's flavor probe. Default: {@link newestGoldenFlavor} (the local tree). */
	readonly goldenFlavor?: () => ManifestFlavor | undefined;
}

/**
 * The Start action's core (28j) — the one-action sandbox launch, the fix for
 * "why does this require so many steps?". Guards, in order:
 *
 * 1. **No golden** → the guard line ({@link NO_GOLDEN_GUARD_MESSAGE}) — the same
 *    message the vm write guard throws; both remedies it names (the CLI, the
 *    Sandbox → Install row) are reachable from exactly where the operator is.
 * 2. **Mode off** → pick `vm`/`agent` (cancel → `null`, silent); the pick is
 *    PERSISTED + adopted before dispatch — the persisted doc is the only thing
 *    a fresh boot resolves (the dashboard's own launch flags are not consulted).
 * 3. **The flavor gate**: starting in agent mode over a base-flavor (or
 *    unreadable — fail-safe) golden asks ONE confirm naming the silent
 *    degradation (the tmux agent dies at launch; the boot itself succeeds) and
 *    the remedy (rebuild via Guest setup + Install). Declining → `null`; a pick
 *    that was persisted leaves the row-3 pending note (saved, not booted).
 * 4. **Dispatch**: mode was off → the child re-spawn via `restartServer`
 *    (absent seam → the honest attached hint err — nothing dishonestly silent).
 *    Mode was already `vm`/`agent` → `sendCommand("vm-restart")` — the
 *    server-side stop-then-re-arming-start covers start-from-stopped AND a live
 *    restart, owned and attached alike.
 */
export async function createStartSandboxAction(deps: StartSandboxDeps): Promise<Result<void, Error> | null> {
	if (!deps.store.hasGolden) {
		return err(new Error(NO_GOLDEN_GUARD_MESSAGE));
	}
	const mode = deps.store.settings.vm.mode;
	let effective: "vm" | "agent";
	if (mode === "off") {
		const picked = await deps.pickMode();
		if (picked === null) return null; // cancelled — silent (the modal idiom)
		effective = picked;
		const next: Settings = { ...deps.store.settings, vm: { ...deps.store.settings.vm, mode: picked } };
		deps.persist(next);
		deps.store.setSettings(next);
	} else {
		effective = mode;
	}
	if (effective === "agent") {
		const flavor = (deps.goldenFlavor ?? newestGoldenFlavor)();
		if (flavor !== "agent") {
			const go = await deps.confirm(SANDBOX_AGENT_BASE_FLAVOR_CONFIRM);
			if (go !== true) {
				// A persisted pick an (still off-mode) server has not applied — the
				// row-3 pending note carries the honesty (mode saved, not booted).
				if (mode === "off") deps.store.setVmApplyPending(true);
				return null;
			}
		}
	}
	if (mode === "off") {
		const restart = deps.restartServer;
		if (restart === undefined) return err(new Error(SANDBOX_START_ATTACHED_OFF_HINT));
		return restart();
	}
	const send = deps.sendCommand;
	if (send === undefined) return err(new Error(VM_UNOWNED_HINT));
	return send("vm-restart");
}

// ---- the settings actions + the mode-select guards (spec 28, box 28c) ------------

/**
 * Deps for {@link createSettingsActions} — the exported, unit-testable core the
 * buildActions wiring wraps (the {@link createSandboxActions} precedent). The
 * io-bearing pieces (the wizard, the confirm modal, the restart spinner) arrive
 * as seams so the guards are hermetic-testable; the wiring keeps the terminals.
 */
export interface SettingsActionsDeps {
	/** Persist the doc (the runDashboard `persist` seam — saveSettings in production). */
	readonly persist: (s: Settings) => void;
	/** The live store: reads `settings`, applies the next doc, holds the row-3 pending flag. */
	readonly store: Pick<DashboardStore, "settings" | "setSettings" | "setVmApplyPending">;
	/** The row-1 confirm modal (the wiring wraps `io.confirm` + the suspend/resume pair). */
	readonly confirm: (message: string) => Promise<boolean | null>;
	/**
	 * The section wizard runner. `sections` is `undefined` for Edit settings (the
	 * picker offers every registered section) or exactly `[vmSection]` for the
	 * Sandbox Configure jump (the `vm` section preselected — same engine, no drift).
	 */
	readonly runSectionWizard: (before: Settings, sections: ConfigSection[] | undefined) => Promise<SetSectionResult>;
	/** The channel live-apply (the existing defaultChannel-changed restart; behavior unchanged). */
	readonly restartIfDefaultChanged: (before: Settings, after: Settings) => Promise<void>;
	/**
	 * The row-3 restart seam ({@link DashboardDeps.restartServer} — the wiring wraps
	 * it in the spinner). Absent → unowned: the write persists and the pending flag
	 * is set (the apply-on-restart hint), never a dead button.
	 */
	readonly restartServer?: () => Promise<Result<void, Error>>;
}

/** The settings-mutating actions the root calls ({@link DashboardActions}' shape). */
export interface SettingsActions {
	/** The Settings screen's wizard: the section picker, then the guards below. */
	editSettings(): Promise<Result<Settings, Error> | null>;
	/** The Sandbox Configure jump: the `vm` section preselected, then the guards below. */
	configureVm(): Promise<Result<Settings, Error> | null>;
}

/**
 * The settings actions' core (spec 28, box 28c) — the guard + apply pipeline both
 * dashboard mode-select surfaces share:
 *
 * 1. Run the section wizard. A cancel/`null` or an `err` passes through untouched;
 *    the no-golden guard (matrix row 2) needs NO code here — it lives in
 *    `vmSection.write` (config/sections.ts), whose throw propagates to the root's
 *    activation catch and flashes the actionable message. One guard, every path.
 * 2. Row 1 (the headline warning): `vm`/`agent` → `off` with a public channel
 *    configured (`hasPublicChannel`, view.ts) asks ONE confirm with
 *    {@link VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE}; anything but an explicit
 *    `true` (No, Esc, abort) cancels the whole apply — nothing is persisted, the
 *    mode is kept. `off` → `vm`/`agent` never asks (containment only increases).
 * 3. Persist + adopt the new doc.
 * 4. The channel live-apply (`restartIfDefaultChanged` — unchanged behavior).
 * 5. Row 3 (restart-to-apply): a write that touched the vm section restarts the
 *    server through `restartServer` when wired; the pending flag records the
 *    honest outcome (set when unwired or the restart failed, cleared on success)
 *    so the flash + the Sandbox header note surface the apply-on-restart affordance.
 */
export function createSettingsActions(deps: SettingsActionsDeps): SettingsActions {
	const apply = async (
		run: (before: Settings) => Promise<SetSectionResult>,
	): Promise<Result<Settings, Error> | null> => {
		const before = deps.store.settings;
		const result = await run(before);
		if (result === null || !result.ok) {
			return result; // cancelled (silent) / the guard threw or write errored (surfaced by the caller)
		}
		const after = result.value;
		// Row 1: the dangerous REVERSE transition only — vm/agent → off exposes the
		// HOST filesystem publicly on restart when a channel forwards to this server.
		const droppedToOff = before.vm.mode !== "off" && after.vm.mode === "off";
		if (droppedToOff && hasPublicChannel(after)) {
			const confirmed = await deps.confirm(VM_OFF_PUBLIC_CHANNEL_CONFIRM_MESSAGE);
			if (confirmed !== true) {
				return null; // declined — the mode is kept, nothing persisted (the modal idiom)
			}
		}
		deps.persist(after);
		deps.store.setSettings(after);
		await deps.restartIfDefaultChanged(before, after);
		if (!vmSettingsEqual(before.vm, after.vm)) {
			const restart = deps.restartServer;
			if (restart === undefined) {
				deps.store.setVmApplyPending(true); // unowned — saved; applies at the next `openhammer` restart
			} else {
				const r = await restart();
				deps.store.setVmApplyPending(!r.ok); // a failed restart leaves the change pending (honest)
			}
		}
		return ok(after);
	};
	return {
		editSettings: () => apply((before) => deps.runSectionWizard(before, undefined)),
		configureVm: () => apply((before) => deps.runSectionWizard(before, [vmSection])),
	};
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
	terminal: Terminal,
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
			runSpinner(
				"Restarting server to apply the channel…",
				() => restart(),
				(r) => (r.ok ? "server restarted" : `restart failed: ${r.error.message}`),
			),
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

	// The settings actions' guard/apply core (spec 28, box 28c): the row-1 confirm,
	// the row-3 restart/pending bookkeeping, and the Configure jump's vm-section
	// preselection — BOTH dashboard mode-select surfaces (Settings → Edit settings,
	// Sandbox → Configure) ride the same guarded pipeline; only the wizard's section
	// selection differs (the picker vs the `vm` section preselected). The io-bearing
	// seams keep their modals/spinners on the shared terminal (which is why the core
	// stays bare and the wiring dresses it).
	const restartServerSeam = deps.restartServer;
	const settingsCore = createSettingsActions({
		persist,
		store,
		confirm: (message) => withModal(() => io.confirm({ message })),
		runSectionWizard: (before, sections) =>
			withModal(() => setSection(before, { io, stream: silentStream, sections })),
		restartIfDefaultChanged,
		restartServer: restartServerSeam
			? (): Promise<Result<void, Error>> =>
					withModal(() =>
						runSpinner(
							"Restarting server to apply the sandbox settings…",
							() => restartServerSeam(),
							(r) => (r.ok ? "server restarted" : `restart failed: ${r.error.message}`),
							{ terminal },
						),
					)
			: undefined,
	});
	const editSettingsAction: DashboardActions["editSettings"] = overrides.editSettings ?? settingsCore.editSettings;
	const configureVmAction: DashboardActions["configureVm"] = overrides.configureVm ?? settingsCore.configureVm;

	// Guest setup (spec 28, box 28e): the tier-(a) wizard over the LOCAL guest.json
	// (26a) — OWNED-AGNOSTIC (a build input of this machine's tree, not a server
	// setting; the one Sandbox action with no vmService/owned gate), so the wiring is
	// just the modal suspend/resume around `runGuestSetup`, which loads the doc,
	// warns when a golden exists, asks, normalizes through the REAL normalize, and
	// saves through 26a's atomic 0600 writer. The silentStream keeps ONE banner
	// (printed once by `runCli`) — the section wizard's exact pattern.
	const guestSetupAction: DashboardActions["guestSetup"] =
		overrides.guestSetup ?? (async () => withModal(() => runGuestSetup({ io, stream: silentStream })));

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

	// The Sandbox actions (spec 28, box 28b + 28c): the exported core carries the
	// owned-gate + single-flight + service/install calls; the wiring adds Stop's one
	// confirmation step — the dashboard's confirm idiom (the `io.confirm` primitive
	// run as a modal on the shared terminal, the setLogin prompts' flow). Declined
	// or aborted → `null` (the cancelled-modal idiom: silent). A successful restart
	// clears the row-3 pending flag (a fresh boot applied every saved vm change).
	const sandbox = createSandboxActions({
		vmService: deps.vmService,
		readSerial: deps.readSerial,
		// The production default (no handle ever exists here): operator commands
		// over the status socket's command intake. Tests inject a fake via
		// DashboardDeps.sendVmCommand.
		sendCommand: deps.sendVmCommand ?? ((cmd) => sendVmCommand(cmd)),
		store,
	});
	// The Start action (28j): the exported core owns the guards + dispatch; the
	// wiring dresses the two io seams (the mode pick, the base-flavor confirm) as
	// modals and the off-mode re-spawn in the restart spinner (the apply path's
	// exact pattern — a re-spawn is a server restart the operator should SEE).
	const startSandboxAction: DashboardActions["startSandbox"] =
		overrides.startSandbox ??
		(async () =>
			withModal(() =>
				createStartSandboxAction({
					store,
					pickMode: async () => {
						const picked = await io.select({
							message: "Boot mode for the sandbox",
							options: [
								{ value: "vm", label: "vm — tools run inside the sandboxed guest" },
								{ value: "agent", label: "agent — the guest plus a preinstalled agent CLI" },
							],
							initialValue: "vm",
						});
						return picked === "vm" || picked === "agent" ? picked : null;
					},
					confirm: (message) => io.confirm({ message }),
					persist,
					restartServer: restartServerSeam
						? (): Promise<Result<void, Error>> =>
								withModal(() =>
									runSpinner(
										"Starting the sandbox — restarting the server so the fresh boot raises it…",
										() => restartServerSeam(),
										(r) =>
											r.ok
												? "server restarted — the sandbox is booting"
												: `restart failed: ${r.error.message}`,
										{ terminal },
									),
								)
						: undefined,
					sendCommand: deps.sendVmCommand ?? ((cmd) => sendVmCommand(cmd)),
				}),
			));
	const stopSandboxAction: DashboardActions["stopSandbox"] =
		overrides.stopSandbox ??
		(async () => {
			const confirmed = await withModal(() => io.confirm({ message: SANDBOX_STOP_CONFIRM_MESSAGE }));
			if (confirmed !== true) return null;
			return sandbox.stopSandbox();
		});
	const restartSandboxAction: DashboardActions["restartSandbox"] =
		overrides.restartSandbox ??
		(async () => {
			const result = await sandbox.restartSandbox();
			if (result?.ok) store.setVmApplyPending(false); // a fresh boot applies every saved vm change
			return result;
		});
	const readSerialAction: DashboardActions["readSerial"] = overrides.readSerial ?? sandbox.readSerial;
	const installSandboxAction: DashboardActions["installSandbox"] =
		overrides.installSandbox ??
		(async () =>
			await withModal(() =>
				runSpinner(
					"Installing the sandbox image — this takes minutes; the run log lands in the session dir…",
					() => sandbox.installSandbox(),
					(r) => (r?.ok ? "install complete" : "install failed"),
					{ terminal },
				),
			));

	// Sandbox secrets (spec 28, box 28f): the tier-(b) editor over the 0700 store —
	// masked, values write-only. Matrix row 6 lives inside the flow: the liveness
	// probe reads the SAME vm-state line the Sandbox row does (28d's
	// `vmSessionActive` over the store), and the interstitial's *Restart sandbox*
	// shortcut invokes THE WIRED 28b action (`restartSandboxAction` — the
	// single-flight guard, the unowned hint, and the pending-flag clearing are
	// inherited, not duplicated). Owned-agnostic like Guest setup (a local store),
	// and the silentStream keeps ONE banner (the section wizard's exact pattern).
	const secretsSetupAction: DashboardActions["secretsSetup"] =
		overrides.secretsSetup ??
		(async () =>
			withModal(() =>
				runSecretsSetup({
					io,
					stream: silentStream,
					sessionActive: () => vmSessionActive(store.latestVmState),
					restartSandbox: () => restartSandboxAction(),
				}),
			));

	// The tier-(c) escape hatch (spec 28, box 28g): $EDITOR over the operator's
	// provision.sh (created from the commented template on first open) — OWNED-AGNOSTIC
	// like Guest setup/Secrets (a local build input of this machine's tree). The flow
	// never executes the script; the root's flash carries the runs-at-next-provision
	// honesty. No io: the editor inherits the terminal across the modal handoff.
	const editProvisionAction: DashboardActions["editProvision"] =
		overrides.editProvision ?? (async () => withModal(() => runProvisionEditor()));

	// The apply-to-running actions (spec 28, box 28g, matrix row 7) — UNOWNED-FRIENDLY
	// by design, and this is the recorded rationale: 28c resolved that the VmService
	// handle only ever exists in the server's child process, so the Sandbox lifecycle
	// actions gate on it and are hint-only today. The GUEST, however, is reachable from
	// ANY process holding three local facts the dashboard already has: the live ssh
	// port + session id (the vm-state line, in this store), the pinned key
	// `<vm root>/id_ed25519`, and the session dir's known_hosts — re-keyed per boot by
	// the service's repinKnownHosts to `[127.0.0.1]:<current port>`, so it pins exactly
	// the live guest. So, unlike Stop/Restart/Serial, these take NO vmService gate: the
	// target is loopback-only by type, BatchMode, key-only (no passwords anywhere), and
	// the execs ride the existing src/vm/ssh.ts exports composed on the dashboard side
	// (src/vm/** untouched). guestUser resolves fresh per activation from the newest
	// golden's manifest (the vm-state line carries no user); `undefined` becomes the
	// flow's actionable target err, never a wrong-user exec.
	const applyAgentAction: DashboardActions["applyAgent"] =
		overrides.applyAgent ??
		(async () =>
			withModal(() =>
				runApplyAgent({
					io,
					stream: silentStream,
					vmLine: store.latestVmState,
					guestUser: newestGoldenGuestUser(),
				}),
			));
	const applyThemeAction: DashboardActions["applyTheme"] =
		overrides.applyTheme ??
		(async () =>
			withModal(() =>
				runApplyTheme({
					io,
					stream: silentStream,
					vmLine: store.latestVmState,
					guestUser: newestGoldenGuestUser(),
				}),
			));

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
		startSandbox: startSandboxAction,
		stopSandbox: stopSandboxAction,
		restartSandbox: restartSandboxAction,
		readSerial: readSerialAction,
		configureVm: configureVmAction,
		guestSetup: guestSetupAction,
		secretsSetup: secretsSetupAction,
		editProvision: editProvisionAction,
		applyAgent: applyAgentAction,
		applyTheme: applyThemeAction,
		installSandbox: installSandboxAction,
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
