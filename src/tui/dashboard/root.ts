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
import { BANNER } from "../banner.ts";
import type { Style } from "../style.ts";
import {
	channelDetailSpec,
	channelItems,
	clientDetailSpec,
	clientItems,
	doctorItems,
	footerLine,
	MENU_SECTIONS,
	menuItems,
	renderFieldRows,
	renderList,
	type ScreenSpec,
	settingsItems,
	titleLine,
} from "./screens.ts";
import type { DashboardStore } from "./store.ts";
import { channelRows, clientRows, monitorRows, secretRevealRows, settingsRows, statusRows } from "./view.ts";

/** A section the menu drills into (the non-Quit menu rows, in order). */
export type Section = (typeof MENU_SECTIONS)[number];

/** The active screen — a discriminated union (mutually-exclusive states, not optional fields). */
export type ScreenState =
	| { kind: "menu" }
	| { kind: "section"; section: Section }
	| { kind: "channel-detail"; id: string }
	| { kind: "client-detail"; id: string };

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
	/** `doctor`. Returns the report text ("" if it could not run). */
	runDoctor(): Promise<string>;
	/** Quit the dashboard (stops the render loop; `runDashboard`'s `onQuit` stops the server). */
	quit(): void;
}

/** Injection seam for {@link DashboardRoot}. */
export interface DashboardRootDeps {
	store: DashboardStore;
	style: Style;
	actions: DashboardActions;
}

/** The one-time secret reveal held until the user leaves the Clients screen. */
interface SecretReveal {
	clientId: string;
	plaintext: string;
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

	constructor(deps: DashboardRootDeps) {
		this.store = deps.store;
		this.style = deps.style;
		this.actions = deps.actions;
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
					: "↑↓/jk move · enter/l select · esc/h back";
			case "channel-detail":
			case "client-detail":
				return "↑↓/jk move · enter/l action · esc/h back";
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
		}
	}

	/** The Clients-screen header: the one-time secret reveal (if any) above the list. */
	private clientsHeader(): string[] {
		if (this.reveal === null) return [];
		return secretRevealRows(this.reveal.clientId, this.reveal.plaintext);
	}

	/** Render the active screen: title, header, focused list, flash, footer. */
	render(width: number): string[] {
		const spec = this.currentSpec();
		const lines: string[] = [];
		// The banner is part of the frame (not printed once to scrollback) so it
		// survives the force-clear + redraw after a modal (pi-tui's force-clear wipes
		// scrollback, which is why a scrollback banner "disappeared"). Pinned on every
		// screen — the title + content render below it.
		lines.push(...BANNER.split("\n"), "", titleLine(this.style), "");
		for (const line of spec.header ?? []) lines.push(line);
		if ((spec.header ?? []).length > 0) lines.push("");
		const maxVisible = Math.max(1, width > 0 ? width : 80);
		lines.push(...renderList(spec.items, this.focus, this.style, maxVisible));
		if (this.flashMessage !== null) {
			lines.push("", this.style.warning(this.flashMessage));
		}
		lines.push("", footerLine(this.hint(), this.style));
		return lines;
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
				if (this.focus >= MENU_SECTIONS.length) {
					this.actions.quit(); // the Quit row
					return;
				}
				this.enterSection(MENU_SECTIONS[this.focus] as Section);
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
			const row = clientRows(this.store.oauthClients)[this.focus];
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
	 * generic "<kind> updated." message.
	 */
	private async runAction(
		run: () => Promise<Result<Settings, Error> | null>,
		kind: "channel" | "settings",
		successMsg?: string,
	): Promise<void> {
		const result = await run();
		if (result === null) return; // cancelled — silent
		if (result.ok) {
			this.flashMessage = successMsg ?? (kind === "channel" ? "Channel added." : "Settings updated.");
		} else {
			this.flashMessage = result.error.message;
		}
	}
}

/** A single "Back" row for view-only screens (status, monitor). */
const BACK_ONLY = [{ label: "Back", description: "to menu" }];
