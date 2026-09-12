/**
 * The dashboard root component (spec 19 rebuild) — the stateful orchestrator that
 * owns the **screen-state machine**, the focus index, and the transient UI state
 * (a flash message, the one-time secret reveal, the doctor report), and routes
 * every keystroke to navigation or an action. The renderer mounts this as the TUI
 * root and forwards raw input to {@link DashboardRoot.handleInput}; the root builds
 * the active screen's {@link ScreenSpec} each frame via the pure builders in
 * `screens.ts` and lays it out with `style.ts` color.
 *
 * **Navigation model (pi-style):** `↑↓` moves the focus, `Enter` activates the
 * focused row (drill into a section / run an action), `Esc`/`←` backs out (a
 * detail → its section; a section → the menu; the menu → quit), `q`/`Ctrl-C` quits.
 * Every screen is a focused list, so the model is uniform — the menu, the channels
 * list, a channel's actions, the clients list, etc. (the `screens.ts` rationale).
 *
 * **No I/O here.** The root talks only to the {@link DashboardStore} (read) and the
 * injected {@link DashboardActions} (mutate). The actions — wired by `runDashboard`
 * — `suspend()` the render loop, run the real wizard/command, `resume()`, persist +
 * update the store on `ok`, and return the `Result` so the root can flash feedback.
 * `handleInput` is sync, so activations are `void`-ed (fire-and-forget; the
 * no-floating-promises rule). The root never imports `src/cli/` (layering) — the
 * doctor/secret/issue flows are reached purely through the action seams.
 */
import type { Component } from "@earendil-works/pi-tui";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import type { IssuedClient } from "../../auth/oauth/clients.ts";
import type { Settings } from "../../config/settings.ts";
import type { Result } from "../../tools/result.ts";
import type { GuestConfig } from "../../vm/provision/guest-config.ts";
import type { SecretsStore } from "../../vm/provision/secrets.ts";
import { BANNER } from "../banner.ts";
import type { Style } from "../style.ts";
import { APPLY_TO_RUNNING_HINT, applyToRunningReady, PROVISION_SAVED_FLASH } from "../wizards/guest-setup.ts";
import {
	channelDetailSpec,
	channelItems,
	clientDetailSpec,
	clientItems,
	doctorItems,
	footerLine,
	type MENU_SECTIONS,
	menuItems,
	menuSectionAt,
	renderFieldRows,
	renderList,
	SANDBOX_APPLY_AGENT_LABEL,
	SANDBOX_APPLY_THEME_LABEL,
	SANDBOX_CONFIGURE_LABEL,
	SANDBOX_GUEST_SETUP_LABEL,
	SANDBOX_INSTALL_LABEL,
	SANDBOX_PROVISION_LABEL,
	SANDBOX_RESTART_LABEL,
	SANDBOX_SECRETS_LABEL,
	SANDBOX_SERIAL_LABEL,
	SANDBOX_START_LABEL,
	SANDBOX_STOP_LABEL,
	type ScreenSpec,
	SET_LOGIN_LABEL,
	sandboxItems,
	settingsItems,
	titleLine,
} from "./screens.ts";
import type { DashboardStore } from "./store.ts";
import {
	channelRows,
	clientRows,
	monitorRows,
	type SerialSource,
	type SerialTail,
	sandboxHeaderRows,
	secretRevealRows,
	serialTailNote,
	serialTailOf,
	settingsRows,
	statusRows,
	VM_APPLY_HINT,
	vmSessionActive,
	vmSettingsEqual,
} from "./view.ts";

/** A section the menu drills into (the non-Quit menu rows, in order). */
export type Section = (typeof MENU_SECTIONS)[number];

/** The active screen — a discriminated union (mutually-exclusive states, not optional fields). */
export type ScreenState =
	| { kind: "menu" }
	| { kind: "section"; section: Section }
	| { kind: "channel-detail"; id: string }
	| { kind: "client-detail"; id: string }
	| { kind: "serial" };

/** The add/issue row markers (matched by prefix so a conditional offset can't misroute). */
const ADD_CHANNEL_MARKER = "＋";
const ISSUE_CLIENT_MARKER = "＋";

/**
 * The mutating actions the root calls. Each is wired by `runDashboard` to
 * `suspend()` → run the real flow → `resume()` (so the dashboard loop yields the
 * terminal to the wizard/command), persist + update the store on `ok`, and return
 * the `Result`/report for the root to flash. `quit()` is sync (it stops the loop).
 */
export interface DashboardActions {
	/** `channel add` wizard. Returns the new `Settings` on success. */
	addChannel(): Promise<Result<Settings, Error> | null>;
	/** `config set` wizard. Returns the new `Settings` on success. */
	editSettings(): Promise<Result<Settings, Error> | null>;
	/** `auth add-client`. Returns the issued client (plaintext secret shown once). */
	issueClient(): Promise<Result<IssuedClient, Error> | null>;
	/** `channel remove <id>`. Returns the new `Settings` on success. */
	removeChannel(id: string): Promise<Result<Settings, Error> | null>;
	/** `channel use <id>`. Returns the new `Settings` on success. */
	useChannel(id: string): Promise<Result<Settings, Error> | null>;
	/** `auth remove <id>`. */
	removeClient(id: string): Promise<Result<void, Error> | null>;
	/** `auth set-login` — set the operator login (the `/authorize` gate for login clients). */
	setLogin(): Promise<Result<void, Error> | null>;
	/** `doctor`. Returns the report text ("" if it could not run). */
	runDoctor(): Promise<string>;
	/**
	 * Start the sandbox (28j) — the one-action launch. The exported core
	 * (dashboard.ts's {@link createStartSandboxAction}) owns the guards (no golden
	 * → the guard line; mode off → the vm/agent pick, persisted before dispatch;
	 * agent over a base-flavor golden → the degradation confirm) and the dispatch
	 * (off → the child re-spawn so a fresh boot raises the sandbox; vm/agent → a
	 * server-side `vm-restart`, owned and attached alike). `null` = a cancelled
	 * pick/declined confirm (silent). The Sandbox screen offers the top row
	 * exactly when no session is live (`sandboxStartOffered`).
	 */
	startSandbox(): Promise<Result<void, Error> | null>;
	/**
	 * Stop the VM sandbox (spec 28, matrix row 4): the `VmService` teardown — clean
	 * ACPI powerdown + stop ladder + persist policy (spec 27e). The wired action asks
	 * ONE confirmation first (the `io.confirm` modal) and returns `null` when declined
	 * (the cancelled-modal idiom: silent). After a stop the state row reads `stopped`:
	 * the boot-scoped mode re-boots the sandbox on the next server start — the lasting
	 * stop is mode `off` + restart.
	 */
	stopSandbox(): Promise<Result<void, Error> | null>;
	/**
	 * Restart the VM sandbox: `await service.stop()` then `void service.start()` — a
	 * fresh boot per the persist rules (retain reuses the overlay, discard is fresh;
	 * the service owns those semantics, spec 27e). The row flips to `booting` via the
	 * vm-state line: main.ts wires service transitions → status socket (27h), and the
	 * dashboard's socket-client feed lands them in the store — owned and attached
	 * dashboards take the SAME loopback path, so no direct render poke exists or is
	 * needed. Since 28i the production path is a `vm-restart` command over the
	 * status socket (accepted, not completed); with neither tier wired, activations
	 * err with the unowned hint.
	 */
	restartSandbox(): Promise<Result<void, Error> | null>;
	/**
	 * Read the session's serial log (the vm-state line's sessionId) as
	 * `{ content, totalBytes }` (spec 28, box 28b). The default reader is
	 * `<HOME>/.openhammer/vm/sessions/<sessionId>/serial.log`; a missing file errs
	 * "no serial yet". Gate-free since 28i — a same-host file, so it works owned
	 * and attached alike.
	 */
	readSerial(): Promise<Result<SerialSource, Error>>;
	/**
	 * Jump into the `vm` settings section (spec 28, box 28c) — the Sandbox screen's
	 * *Configure* row. The default runs the SAME section wizard the Settings screen
	 * uses (`setSection`), with the `vm` section preselected (no picker drift: the
	 * jump reuses the exact wizard engine). The mode-select guards apply per write:
	 * the no-golden block surfaces as a thrown actionable message (flashed by the
	 * root's activation catch), and the vm/agent → `off` public-channel confirm runs
	 * before anything persists (decline keeps the mode, silently).
	 */
	configureVm(): Promise<Result<Settings, Error> | null>;
	/**
	 * Guest setup (spec 28, box 28e) — the tier-(a) wizard over the LOCAL `guest.json`
	 * (26a): hostname/timezone/keyboard/username, git identity, encrypt, the default
	 * agent, extra packages, boot-with commands. OWNED-AGNOSTIC — the one Sandbox
	 * action with no `vmService` gate: `guest.json` configures the BUILD INPUTS of the
	 * local tree (what the next `vm install` bakes), never a (possibly remote)
	 * running server, so there is nothing to own. When a golden already exists the
	 * wizard precedes with the applies-to-next-install warning (declining writes
	 * nothing); the write funnels through the real `normalizeGuestConfig` and 26a's
	 * atomic 0600 writer. `ok` carries the saved config; `null` = cancelled/declined.
	 */
	guestSetup(): Promise<Result<GuestConfig, Error> | null>;
	/**
	 * Sandbox secrets (spec 28, box 28f) — the tier-(b) editor over the 0700 store
	 * (26a's `secrets.ts`): masked env-pair + credential-file rows, saved through
	 * loadSecrets → the real normalizeSecrets gate → saveSecrets (0700 dir / 0600
	 * files). Values are write-only — the rendered model never carries a stored
	 * value. Matrix row 6 lives INSIDE the flow: with a live session the editor
	 * precedes with the applies-at-next-boot hint + a *Restart sandbox* shortcut
	 * that reuses THIS interface's {@link restartSandbox} action. OWNED-AGNOSTIC
	 * like Guest setup — the store is a local input of this machine's tree. `ok`
	 * carries the saved store; `null` = cancelled/declined.
	 */
	secretsSetup(): Promise<Result<SecretsStore, Error> | null>;
	/**
	 * Edit provision.sh (spec 28, box 28g) — the tier-(c) escape hatch: opens
	 * `<HOME>/.openhammer/vm/provision.sh` in `$EDITOR` (created from a commented
	 * template on first open). NOTHING executes here — the script runs as bash in the
	 * guest during the next `vm provision` (the flash says exactly that). OWNED-
	 * AGNOSTIC like Guest setup/Secrets — a local build input of this machine's tree.
	 * An unset `$EDITOR` errs actionably naming it. `ok` = the editor exited cleanly;
	 * `null` is never returned (the editor's exit IS the outcome).
	 */
	editProvision(): Promise<Result<void, Error> | null>;
	/**
	 * Apply-to-running #1 (spec 28, box 28g, matrix row 7): write the RUNNING guest's
	 * `~/.config/omarchy/defaults/agent` over ONE direct ssh exec — the DIRECT FILE
	 * WRITE (the `omarchy default agent` CLI setter is a Wayland picker, 22-measured
	 * finding 12). UNOWNED-FRIENDLY by design: no vmService gate — the guest is
	 * addressable from the vm-state line's session id + live port (the store) plus the
	 * vm tree's pinned key + the session's re-keyed known_hosts, all local facts; the
	 * target is loopback-only, BatchMode, key-only. The agent choice is a select of
	 * the 13 seeded from guest.json's agent. `ok` carries the report line with the
	 * row-7 hint (affects FUTURE agent launches — a running tmux agent keeps the old
	 * one until the sandbox restarts); `null` = cancelled choice.
	 */
	applyAgent(): Promise<Result<string, Error> | null>;
	/**
	 * Apply-to-running #2 (spec 28, box 28g, matrix row 7): fetch the guest's
	 * `omarchy theme list` over ssh and set the chosen theme with `omarchy theme set`
	 * — ONE more ssh exec. A failed list degrades the select to a text field with the
	 * failure as its hint (the spec's documented fallback — never blocks). Same
	 * unowned-friendly ssh posture as {@link applyAgent}; the outcome — success or
	 * failure — is surfaced with the row-7 hint appended. `null` = cancelled choice.
	 */
	applyTheme(): Promise<Result<string, Error> | null>;
	/**
	 * Build the golden image — 26c's `runInstall` (spec 28, box 28c), matrix row 2's
	 * jump target. Gated by the SAME owned/unowned model as Stop/Restart (install
	 * needs no service handle for its work, but an unowned dashboard may be a view
	 * over a server whose vm tree is not this one — one ownership model, one hint).
	 * Progress is the spinner ("installing…"); the completion flash names the
	 * session dir + the onboarding next step (Install → set mode → restart).
	 * Owned-server only; unowned activations err with the unowned hint.
	 */
	installSandbox(): Promise<Result<InstallOutcome, Error> | null>;
	/** Quit the dashboard (stops the render loop; `runDashboard`'s `onQuit` stops the server). */
	quit(): void;
}

/** What an install run reports — `runInstall`'s result narrowed to what the completion flash names. */
export interface InstallOutcome {
	readonly sessionDir: string;
}

/** Injection seam for {@link DashboardRoot}. */
export interface DashboardRootDeps {
	store: DashboardStore;
	style: Style;
	actions: DashboardActions;
	/** The terminal row count, so the banner can pin to the top + the list to the bottom
	 *  with a gap between (pi-tui's `Component.render` is width-only, so the height is read
	 *  here). Defaults to 24. */
	getRows?: () => number;
}

/** The one-time secret reveal held until the user leaves the Clients screen. */
interface SecretReveal {
	clientId: string;
	/** Present only for a confidential client (public clients mint no secret). */
	plaintext?: string;
}

/**
 * The dashboard root. Construct once in `runDashboard`; the renderer mounts it,
 * forwards input to {@link handleInput}, and calls {@link render} each tick.
 */
export class DashboardRoot implements Component {
	private readonly store: DashboardStore;
	private readonly style: Style;
	private readonly actions: DashboardActions;
	/** The active screen. */
	screen: ScreenState = { kind: "menu" };
	/** The focused list row in the active screen. */
	focus = 0;
	/** The menu row to restore when backing out of a section to the menu. */
	private menuFocus = 0;
	/** A transient feedback line (success/error) shown under the list. */
	private flashMessage: string | null = null;
	/** The one-time plaintext secret reveal, shown on the Clients screen. */
	private reveal: SecretReveal | null = null;
	/** The doctor report, shown on the Doctor screen once run. */
	private doctorReport: string | null = null;
	/** The bounded serial tail, shown on the serial drill-in once read. */
	private serialTail: SerialTail | null = null;
	/** The terminal row count (to pin the list at the bottom with a gap under the banner). */
	private readonly getRows: () => number;

	constructor(deps: DashboardRootDeps) {
		this.store = deps.store;
		this.style = deps.style;
		this.actions = deps.actions;
		this.getRows = deps.getRows ?? (() => 24);
	}

	invalidate(): void {
		// No cached render state — `render` reads live store/UI state each tick.
	}

	/** The footer hint for the active screen. */
	private hint(): string {
		switch (this.screen.kind) {
			case "menu":
				return "↑↓/jk move · enter/l open · esc/h back · q quit";
			case "section":
				return this.screen.section === "monitor" || this.screen.section === "status"
					? "esc/h back to return"
					: "↑↓/jk move · enter/l action · esc/h back";
			case "channel-detail":
			case "client-detail":
				return "↑↓/jk move · enter/l action · esc/h back";
			case "serial":
				return "esc/h back to return";
		}
	}

	/** Build the active screen's spec (list + header + hint) from the live store. */
	private currentSpec(): ScreenSpec {
		switch (this.screen.kind) {
			case "menu":
				return { items: menuItems(this.store), hint: this.hint() };
			case "section": {
				const section = this.screen.section;
				if (section === "status") {
					return {
						header: renderFieldRows(statusRows(this.store.status), this.style),
						items: BACK_ONLY,
						hint: this.hint(),
					};
				}
				if (section === "channels") {
					return { items: channelItems(this.store), hint: this.hint() };
				}
				if (section === "clients") {
					return { header: this.clientsHeader(), items: clientItems(this.store), hint: this.hint() };
				}
				if (section === "monitor") {
					const events = monitorRows(this.store.monitorEvents);
					return {
						header: events.length > 0 ? events : ["(quiet — no calls yet)"],
						items: BACK_ONLY,
						hint: this.hint(),
					};
				}
				if (section === "settings") {
					return {
						header: renderFieldRows(settingsRows(this.store.settings), this.style),
						items: settingsItems(),
						hint: this.hint(),
					};
				}
				// Sandbox (spec 28): the verbatim state row, then the effective guest root
				// when known (matrix row 9), then the apply-on-restart note while a vm
				// settings write is saved-but-unapplied (matrix row 3, box 28c) — over the
				// session action list (box 28b, extended in 28c/28e/28f/28g): Stop /
				// Restart / Configure / Guest setup / Secrets / Edit provision.sh / Serial
				// tail / the two apply-to-running rows (ready session only — 28g) /
				// Install (no golden AND no active session — row 5) / Back. Owned-vs-
				// unowned does not change the list — an unowned activation surfaces the
				// unowned hint (never a dead button); Guest setup, Secrets, and Edit
				// provision.sh take no gate at all (editors over the LOCAL vm tree — a
				// build input and the runtime secrets store, 28e/28f/28g).
				if (section === "sandbox") {
					return {
						header: sandboxHeaderRows(this.store.latestVmState, this.store.vmRoot, this.store.vmApplyPending),
						items: sandboxItems(
							this.store.hasGolden,
							vmSessionActive(this.store.latestVmState),
							applyToRunningReady(this.store.latestVmState),
						),
						hint: this.hint(),
					};
				}
				// doctor
				return {
					header: this.doctorReport !== null ? this.doctorReport.split("\n") : ["(not run yet)"],
					items: doctorItems(),
					hint: this.hint(),
				};
			}
			case "channel-detail": {
				const spec = channelDetailSpec(this.store, this.screen.id, this.style);
				return { header: spec.header, items: spec.items, hint: this.hint() };
			}
			case "client-detail": {
				const spec = clientDetailSpec(this.store, this.screen.id, this.style);
				return { header: spec.header, items: spec.items, hint: this.hint() };
			}
			case "serial": {
				// The serial drill-in (spec 28, box 28b): the one-line window/bytes note,
				// then the tail-biased lines — a static snapshot, never a live follow.
				const tail = this.serialTail;
				return {
					header: tail !== null ? [serialTailNote(tail), "", ...tail.lines] : ["(no serial read yet)"],
					items: BACK_ONLY,
					hint: this.hint(),
				};
			}
		}
	}

	/**
	 * The Clients-screen header: the operator-login status (the gate login clients authenticate
	 * against — always visible so an unset login is obvious), then the one-time secret reveal
	 * for a freshly issued machine client (if any).
	 */
	private clientsHeader(): string[] {
		const login = this.store.loginConfigured
			? this.style.accent("operator login: set")
			: this.style.warning("operator login: NOT SET — login clients cannot connect");
		const lines = ["", login, ""];
		if (this.reveal !== null) lines.push(...secretRevealRows(this.reveal.clientId, this.reveal.plaintext));
		return lines;
	}

	/** Render the active screen: banner + title + header pinned at the TOP, the focused
	 *  list + flash + footer pinned at the BOTTOM, with a gap between (so the banner stays
	 *  at the top and the menu sits at the bottom of the viewport). The banner is part of
	 *  the frame (not scrollback) so it survives the force-clear + redraw after a modal. */
	render(width: number): string[] {
		const spec = this.currentSpec();
		// Top: banner + title + the screen's header (field rows / monitor feed / reveal).
		const top: string[] = [...BANNER.split("\n"), "", titleLine(this.style)];
		if ((spec.header ?? []).length > 0) {
			top.push("");
			for (const line of spec.header ?? []) top.push(line);
		}
		// Bottom: the focused list + flash + footer.
		const maxVisible = Math.max(1, width > 0 ? width : 80);
		const bottom: string[] = [...renderList(spec.items, this.focus, this.style, maxVisible)];
		if (this.flashMessage !== null) {
			bottom.push("", this.style.warning(this.flashMessage));
		}
		bottom.push("", footerLine(this.hint(), this.style));
		// Gap = leftover viewport rows (clamped ≥ 0); inserts blank lines so the list sits
		// at the bottom. When the content is tall (e.g. a long monitor feed) the gap is 0
		// and the frame flows top-to-bottom (the banner scrolls off only if it overflows).
		const gap = Math.max(0, this.getRows() - top.length - bottom.length);
		return [...top, ...Array.from({ length: gap }, () => ""), ...bottom];
	}

	/** Route a raw keystroke to navigation or an activation. */
	handleInput(data: string): void {
		// Global: quit on q / Ctrl-C.
		if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
			this.actions.quit();
			return;
		}
		// Navigation: arrows OR nvim-style hjkl. j/k move the focus, l activates
		// (drill-in/select, like Enter), h backs out (like Esc/←). `h` is a no-op at
		// the top-level menu (there's nowhere to back out to) so it never quits — use
		// `q`/Esc/Ctrl-C to quit. (Modals have their own input; this only fires while
		// the dashboard owns the terminal.)
		const isUp = matchesKey(data, Key.up) || data === "k";
		const isDown = matchesKey(data, Key.down) || data === "j";
		const isBack = matchesKey(data, Key.escape) || matchesKey(data, Key.left) || data === "h";
		const isEnter = matchesKey(data, Key.enter) || data === "l";
		if (isUp) {
			this.focus = Math.max(0, this.focus - 1);
			return;
		}
		if (isDown) {
			const items = this.currentSpec().items;
			this.focus = Math.min(items.length - 1, this.focus + 1);
			return;
		}
		if (isBack) {
			// `h` at the menu is a no-op (don't quit on a stray keypress); Esc/← still quit.
			if (data === "h" && this.screen.kind === "menu") return;
			this.back();
			return;
		}
		if (isEnter) {
			// Fire-and-forget: an activation runs an async action (which suspends/resumes
			// the loop itself). Catch a thrown action so it never becomes an unhandled
			// rejection — flash the message instead (the terminal is already resumed by
			// the action's suspend/resume `finally`).
			void this.activate().catch((e: unknown) => {
				this.flashMessage = `Error: ${e instanceof Error ? e.message : String(e)}`;
			});
		}
	}

	/** Back out one level (detail → section → menu → quit). */
	private back(): void {
		this.flashMessage = null;
		switch (this.screen.kind) {
			case "menu":
				this.actions.quit();
				return;
			case "section":
				this.reveal = this.screen.section === "clients" ? null : this.reveal;
				this.screen = { kind: "menu" };
				this.focus = this.menuFocus;
				return;
			case "channel-detail":
				this.screen = { kind: "section", section: "channels" };
				this.focus = 0;
				return;
			case "client-detail":
				this.screen = { kind: "section", section: "clients" };
				this.focus = 0;
				return;
			case "serial":
				this.screen = { kind: "section", section: "sandbox" };
				this.focus = 0;
				return;
		}
	}

	/** Enter a top-level section from the menu (records the menu focus to restore). */
	private enterSection(section: Section): void {
		this.menuFocus = this.focus;
		this.screen = { kind: "section", section };
		this.focus = 0;
		this.flashMessage = null;
	}

	/** Activate the focused row (drill in or run an action). Async — fire-and-forget from handleInput. */
	private async activate(): Promise<void> {
		const items = this.currentSpec().items;
		const item = items[this.focus];
		if (item === undefined) return;
		switch (this.screen.kind) {
			case "menu": {
				// Dispatch through `menuSectionAt` (the same visibility filter
				// `menuItems` renders from), so a hidden Sandbox row shifts the Quit
				// row's position without misrouting — never a raw MENU_SECTIONS index.
				const target = menuSectionAt(this.store, this.focus);
				if (target === "quit") {
					this.actions.quit(); // the Quit row (and any focus past it)
					return;
				}
				this.enterSection(target);
				return;
			}
			case "section": {
				await this.activateSection(this.screen.section, item.label);
				return;
			}
			case "channel-detail": {
				await this.activateChannelDetail(item.label);
				return;
			}
			case "client-detail": {
				await this.activateClientDetail(item.label);
				return;
			}
		}
	}

	/** Activate a focused row within a section screen. */
	private async activateSection(section: Section, label: string): Promise<void> {
		if (label === "Back") {
			this.back();
			return;
		}
		if (section === "channels") {
			if (label.startsWith(ADD_CHANNEL_MARKER)) {
				await this.runAction(() => this.actions.addChannel(), "channel");
				return;
			}
			const row = channelRows(this.store.channels, this.store.defaultChannelId, this.store.channelState)[this.focus];
			if (row) {
				this.screen = { kind: "channel-detail", id: row.id };
				this.focus = 0;
			}
			return;
		}
		if (section === "clients") {
			if (label === SET_LOGIN_LABEL) {
				const result = await this.actions.setLogin();
				if (result === null) return; // cancelled — silent
				this.flashMessage = result.ok ? "Operator login set." : result.error.message;
				return;
			}
			if (label.startsWith(ISSUE_CLIENT_MARKER)) {
				const result = await this.actions.issueClient();
				if (result?.ok) {
					this.reveal = { clientId: result.value.clientId, plaintext: result.value.plaintextSecret };
					this.flashMessage = "Client issued — secret shown above (once).";
				} else if (result && !result.ok) {
					this.flashMessage = result.error.message;
				}
				return;
			}
			// A client row. The list is [Set-login, ...clients, Issue] — the Set-login row is
			// always first, so the focused client's index into clientRows is `focus - 1`.
			const row = clientRows(this.store.oauthClients)[this.focus - 1];
			if (row) {
				this.reveal = null;
				this.screen = { kind: "client-detail", id: row.clientId };
				this.focus = 0;
			}
			return;
		}
		if (section === "settings" && label === "Edit settings…") {
			await this.runAction(() => this.actions.editSettings(), "settings");
			return;
		}
		if (section === "doctor" && label === "Run doctor") {
			this.doctorReport = await this.actions.runDoctor();
			this.flashMessage = this.doctorReport === "" ? "Doctor failed to run." : null;
			return;
		}
		if (section === "sandbox") {
			// The session actions (spec 28, box 28b + 28c). Each wired action carries the
			// owned-server gate: an unowned activation errs with the unowned hint, which
			// flashes here — the same inline surfacing any other failure gets. The
			// no-golden guard (a thrown write) surfaces through the activation catch.
			if (label === SANDBOX_START_LABEL) {
				// The headline one-action launch (28j): the exported core owns the guards
				// (no golden, the mode pick, the base-flavor confirm) and the dispatch
				// (off → child re-spawn; vm/agent → a server-side vm-restart). A cancelled
				// pick/declined confirm is `null` — silent (the modal idiom).
				const result = await this.actions.startSandbox();
				if (result === null) return;
				this.flashMessage = result.ok
					? "Start accepted — the sandbox is booting (the state row flips to booting)."
					: result.error.message;
				return;
			}
			if (label === SANDBOX_STOP_LABEL) {
				const result = await this.actions.stopSandbox();
				if (result === null) return; // confirmation declined — silent (the modal idiom)
				this.flashMessage = result.ok
					? "Sandbox stopped — the boot-scoped mode re-boots it on the next server start (lasting stop: mode off + restart)."
					: result.error.message;
				return;
			}
			if (label === SANDBOX_RESTART_LABEL) {
				const result = await this.actions.restartSandbox();
				if (result === null) return;
				this.flashMessage = result.ok
					? "Restarting the sandbox — teardown done; a fresh boot is starting (the row flips to booting)."
					: result.error.message;
				return;
			}
			if (label === SANDBOX_CONFIGURE_LABEL) {
				// The jump into the `vm` settings section (spec 28, box 28c): the same
				// runAction flash as the Settings screen, so the apply-on-restart hint
				// rides an unapplied vm write identically from both entry points.
				await this.runAction(() => this.actions.configureVm(), "settings");
				return;
			}
			if (label === SANDBOX_GUEST_SETUP_LABEL) {
				// The guest-build-config wizard (spec 28, box 28e) — owned-agnostic
				// (guest.json is local; a build input, not a server setting), so no gate
				// and no store adoption: guest.json is not dashboard state, the wizard
				// already saved through 26a's writer on ok, and this only flashes.
				const result = await this.actions.guestSetup();
				if (result === null) return; // cancelled / the post-golden warning declined — silent
				this.flashMessage = result.ok
					? "Guest setup saved — applies to the next `vm install`."
					: result.error.message;
				return;
			}
			if (label === SANDBOX_SECRETS_LABEL) {
				// The secrets editor (spec 28, box 28f) — owned-agnostic like Guest setup
				// (the 0700 store is a local input of this machine's tree), so no gate and
				// no store adoption: the flow already saved through the real
				// normalizeSecrets + 26a's writer on ok, and this only flashes. Row 6's
				// live-session hint + Restart shortcut live INSIDE the flow (it owns the
				// liveness probe and reuses actions.restartSandbox). The flash is honest
				// in both session states — injection happens at session START, so a save
				// always loads at the next sandbox boot.
				const result = await this.actions.secretsSetup();
				if (result === null) return; // cancelled / declined — silent (the modal idiom)
				this.flashMessage = result.ok
					? "Secrets saved — they load at the next sandbox boot."
					: result.error.message;
				return;
			}
			if (label === SANDBOX_PROVISION_LABEL) {
				// The tier-(c) escape hatch (spec 28, box 28g): $EDITOR over the operator's
				// provision.sh. Owned-agnostic like Guest setup/Secrets (a local build
				// input). The flow never executes the script — this flash is the honesty:
				// it runs during the NEXT `vm provision` (provision.ts step (j)).
				const result = await this.actions.editProvision();
				if (result === null) return; // unreachable today — the editor's exit IS the outcome
				this.flashMessage = result.ok ? PROVISION_SAVED_FLASH : result.error.message;
				return;
			}
			if (label === SANDBOX_APPLY_AGENT_LABEL || label === SANDBOX_APPLY_THEME_LABEL) {
				// The apply-to-running actions (spec 28, box 28g): each wired action runs
				// its ONE direct ssh exec (no owned gate — the guest is reachable from the
				// vm-state line's port + session id plus the local key/pin) and returns the
				// surfaced report. Matrix row 7: EVERY outcome carries the hint — the flows
				// append it themselves, so the flash shows it as-is and only backfills a
				// foreign err that lacks it (never the hint twice).
				const result =
					label === SANDBOX_APPLY_AGENT_LABEL ? await this.actions.applyAgent() : await this.actions.applyTheme();
				if (result === null) return; // cancelled choice — silent (the modal idiom)
				this.flashMessage = result.ok
					? result.value
					: result.error.message.includes(APPLY_TO_RUNNING_HINT)
						? result.error.message
						: `${result.error.message} — ${APPLY_TO_RUNNING_HINT}`;
				return;
			}
			if (label === SANDBOX_SERIAL_LABEL) {
				const result = await this.actions.readSerial();
				if (!result.ok) {
					this.flashMessage = result.error.message; // incl. "no serial yet" (no session / no file)
					return;
				}
				this.serialTail = serialTailOf(result.value.content, result.value.totalBytes);
				this.screen = { kind: "serial" };
				this.focus = 0;
				return;
			}
			if (label === SANDBOX_INSTALL_LABEL) {
				// The no-golden jump target (spec 28, box 28c, matrix row 2). Progress is
				// the spinner (the wiring's runModal); this flash carries the outcome + the
				// onboarding next step (Install → set mode → restart).
				const result = await this.actions.installSandbox();
				if (result === null) return;
				this.flashMessage = result.ok
					? `Install complete — session ${result.value.sessionDir}. Next: Configure → set the boot mode, then restart.`
					: result.error.message;
				return;
			}
		}
	}

	/** Activate a focused row on a channel-detail screen. */
	private async activateChannelDetail(label: string): Promise<void> {
		const id = this.screen.kind === "channel-detail" ? this.screen.id : "";
		if (label === "Back") {
			this.back();
			return;
		}
		if (label === "Use as default") {
			await this.runAction(() => this.actions.useChannel(id), "channel", "Default channel set.");
			return;
		}
		if (label === "Remove") {
			const result = await this.actions.removeChannel(id);
			if (result?.ok) {
				this.flashMessage = "Channel removed.";
				this.back(); // the channel is gone — return to the list
			} else if (result && !result.ok) {
				this.flashMessage = result.error.message;
			}
		}
	}

	/** Activate a focused row on a client-detail screen. */
	private async activateClientDetail(label: string): Promise<void> {
		const id = this.screen.kind === "client-detail" ? this.screen.id : "";
		if (label === "Back") {
			this.back();
			return;
		}
		if (label === "Remove") {
			const result = await this.actions.removeClient(id);
			if (result?.ok) {
				this.flashMessage = "Client removed.";
				this.back();
			} else if (result && !result.ok) {
				this.flashMessage = result.error.message;
			}
		}
	}

	/**
	 * Run a settings-mutating action, flashing success/failure. On `ok` the action
	 * closure already persisted + updated the store (the wiring), so the next render
	 * reflects the change; here we just flash the outcome. `successMsg` overrides the
	 * generic "<kind> updated." message. A write that touched the vm section while
	 * the change is still unapplied (matrix row 3 — no live restart succeeded)
	 * flashes the apply-on-restart hint instead of the generic success line.
	 */
	private async runAction(
		run: () => Promise<Result<Settings, Error> | null>,
		kind: "channel" | "settings",
		successMsg?: string,
	): Promise<void> {
		const before = this.store.settings;
		const result = await run();
		if (result === null) return; // cancelled — silent
		if (result.ok) {
			const vmTouched = !vmSettingsEqual(before.vm, this.store.settings.vm);
			this.flashMessage =
				successMsg ??
				(kind === "channel"
					? "Channel added."
					: vmTouched && this.store.vmApplyPending
						? VM_APPLY_HINT
						: "Settings updated.");
		} else {
			this.flashMessage = result.error.message;
		}
	}
}

/** A single "Back" row for view-only screens (status, monitor). */
const BACK_ONLY = [{ label: "Back", description: "to menu" }];
