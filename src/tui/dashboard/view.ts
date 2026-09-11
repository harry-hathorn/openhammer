/**
 * The dashboard view-models (spec 19 rebuild) — **pure** functions that turn live
 * state into the plain-text rows each screen renders. No terminal, no render-lib
 * (not even pi-tui): they return domain row objects / strings, and the screen
 * components (`screens.ts`) apply color via {@link ../style.ts} and map selectable
 * rows to `SelectItem`s. That split keeps this module maximally testable (the
 * `panels.test.ts` pure-function precedent) and keeps the pi-tui coupling in one
 * place (the components).
 *
 * **Replaces the flat-ASCII panel composition** (`panels.ts`'s
 * `composeDashboard`/`renderXPanel`): those baked layout + clip into `string[]`;
 * these return *values* the components lay out + color + clip. The data shapes are
 * the same source of truth (a channel row mirrors {@link ChannelEntry}; a monitor
 * row is {@link formatEvent}; a status row mirrors {@link ServerStatusState}) —
 * one source, used by both the one-line CLI and the dashboard.
 *
 * **"unknown" vs "down":** a channel absent from `channelState` is `unknown`
 * (not yet reported); `up:false` is reported down — distinct states the channels
 * screen renders differently.
 */
import type { ClientInfo } from "../../auth/oauth/clients.ts";
import type { ChannelEntry, Settings, VmSettings } from "../../config/settings.ts";
import type { RequestEvent } from "../../mcp/telemetry.ts";
import type { VmStateLine } from "../../observability/status-socket.ts";
import { formatBytes, formatEvent, formatVmState } from "../monitor-view.ts";
import type { ChannelLiveState, ServerStatusState } from "./store.ts";

/** A labeled key/value row (status, channel detail, settings). `value` is plain text. */
export interface FieldRow {
	/** The label, e.g. "server", "local", "token". */
	label: string;
	/** The value (URL, token, up/down, …); empty string when absent. */
	value: string;
}

/** One selectable channel row (the Channels screen's list). */
export interface ChannelRow {
	id: string;
	/** Display label (`label ?? kind`). */
	label: string;
	kind: string;
	mode: string;
	live: "up" | "down" | "unknown";
	/** The live or declared URL; "" when none. */
	url: string;
	/** Is this the default channel? */
	isDefault: boolean;
}

/** One selectable OAuth-client row (the Clients screen's list). */
export interface ClientRow {
	clientId: string;
	/** Display label ("(no label)" when blank). */
	label: string;
	createdAt: string;
	/** Display label for the grant type: "login" (authorization code) or "machine" (client credentials). */
	grantType: string;
}

/**
 * A short display label for a client's grant types — "login" when it may use the
 * authorization-code grant (a browser login), else "machine" (client credentials).
 */
export function grantTypeLabel(grantTypes: string[]): string {
	return grantTypes.includes("authorization_code") ? "login" : "machine";
}

/**
 * The channels-screen list. One {@link ChannelRow} per configured channel, in
 * configured order. The URL prefers the live channel URL and falls back to a
 * static channel's declared `publicUrl`; the live state is `unknown` when no
 * report exists yet. Pure — the screen maps these to `SelectItem`s + color.
 */
export function channelRows(
	channels: ChannelEntry[],
	defaultChannelId: string | null,
	channelState: Record<string, ChannelLiveState>,
): ChannelRow[] {
	return channels.map((ch) => {
		const live = channelState[ch.id];
		return {
			id: ch.id,
			label: ch.label ?? ch.kind,
			kind: ch.kind,
			mode: ch.mode,
			live: live === undefined ? "unknown" : live.up ? "up" : "down",
			url: live?.url ?? ch.options.publicUrl ?? "",
			isDefault: ch.id === defaultChannelId,
		};
	});
}

/**
 * The full detail rows for one channel (the ChannelDetail screen). Includes the
 * id, label, kind, mode, default marker, live state, the URL, and any non-secret
 * `options` (e.g. a static channel's `publicUrl`). Pure.
 */
export function channelDetailRows(
	channel: ChannelEntry,
	defaultChannelId: string | null,
	live: ChannelLiveState | undefined,
): FieldRow[] {
	const rows: FieldRow[] = [
		{ label: "id", value: channel.id },
		{ label: "label", value: channel.label ?? "(none)" },
		{ label: "kind", value: channel.kind },
		{ label: "mode", value: channel.mode },
		{ label: "default", value: channel.id === defaultChannelId ? "yes" : "no" },
		{ label: "status", value: live === undefined ? "unknown" : live.up ? "up" : "down" },
		{ label: "url", value: live?.url ?? channel.options.publicUrl ?? "(none)" },
	];
	for (const [key, value] of Object.entries(channel.options)) {
		if (value !== "") rows.push({ label: key, value });
	}
	return rows;
}

/**
 * The status-screen rows: server up/down, then local + tunnel URLs and the token
 * as they become known. A `down` server still lists known URLs so the operator
 * sees what *should* be reachable. Pure.
 */
export function statusRows(status: ServerStatusState): FieldRow[] {
	const rows: FieldRow[] = [{ label: "server", value: status.up ? "up" : "down" }];
	if (status.localUrl !== null) rows.push({ label: "local", value: status.localUrl });
	if (status.publicUrl !== null) rows.push({ label: "tunnel", value: status.publicUrl });
	if (status.token !== null) rows.push({ label: "token", value: status.token });
	return rows;
}

/**
 * The OAuth-clients list rows (id + label + createdAt). A blank label renders as
 * `(no label)`. Empty → `[]` (the screen shows its own empty hint). Pure — the
 * plaintext secret is **never** here (only its hash is persisted); the issue flow
 * reveals it once via {@link secretRevealRows}.
 */
export function clientRows(clients: ClientInfo[]): ClientRow[] {
	return clients.map((c) => ({
		clientId: c.clientId,
		label: c.label.trim() ? c.label : "(no label)",
		createdAt: c.createdAt,
		grantType: grantTypeLabel(c.grantTypes),
	}));
}

/**
 * The one-time plaintext-secret reveal block for a freshly issued client — shown
 * **once**, then never again (only the SHA-256 hash is kept). Re-derived here
 * (pure) rather than imported from `src/cli/auth.ts` (`formatSecretReveal`) so the
 * dashboard stays free of the CLI layer (`src/tui/` must not import `src/cli/`).
 * Pure.
 */
export function secretRevealRows(clientId: string, plaintextSecret?: string): string[] {
	const rows = ["Issued OAuth client.", "", `  client_id:     ${clientId}`];
	if (plaintextSecret !== undefined) {
		rows.push(
			`  client_secret: ${plaintextSecret}`,
			"",
			"Store the secret now — it will NOT be shown again.",
			"(Only a SHA-256 hash is kept in ~/.openhammer/credentials.json.)",
		);
	} else {
		rows.push("", "Public client — no secret; authenticates with PKCE + the /authorize login.");
	}
	return rows;
}

/**
 * The monitor-screen rows: one {@link formatEvent} line per recent event (the same
 * formatter `openhammer monitor` uses — single source). Empty → `[]`. Pure.
 */
export function monitorRows(events: RequestEvent[]): string[] {
	return events.map((event) => formatEvent(event));
}

/**
 * The settings-screen rows: the MCP allowed-client list (or "(any)" when empty or
 * `["*"]`) and the default channel (or "(none)"). Pure.
 */
export function settingsRows(settings: Settings): FieldRow[] {
	const clients = settings.mcp.allowedClients;
	const any = clients.length === 0 || clients.includes("*");
	return [
		{ label: "allowed clients", value: any ? "(any)" : clients.join(", ") },
		{ label: "default channel", value: settings.defaultChannel ?? "(none)" },
	];
}

// ---- the Sandbox entry (spec 28) ----------------------------------------------

/**
 * The Sandbox entry's visibility — the off-mode invisibility rule (spec 28):
 * the entry is ABSENT exactly when the **loaded settings'** vm mode is `off` AND
 * no vm-state line with state ≠ `off` has ever arrived. The mode is read from
 * the settings doc (not from the line): that is what the default npm user has,
 * so they see nothing new. A vm-state line is the escape hatch for a boot-time
 * override (`MCP_VM_MODE=vm` in the env while the doc still says `off`) — once
 * the server reports a live VM lifecycle, the entry appears. Pure.
 */
export function sandboxEntryVisible(mode: VmSettings["mode"], vmObserved: boolean): boolean {
	return mode !== "off" || vmObserved;
}

/**
 * The Sandbox state row's text AFTER the head — one shape per lifecycle state,
 * in the monitor-view's established voice (formatVmState owns the per-state
 * clauses; this derives from it so the monitor row and the dashboard row can
 * never drift):
 *
 *     ready · session vm-20260911T101112Z-ab · ssh :42255
 *     booting (phase ssh)
 *     failed — sandbox boot failed: …
 *     stopped
 *
 * A `null` line (vm mode configured, nothing reported yet) reads as `stopped` —
 * the honest pre-first-report posture (the eager boot reports within moments).
 * Pure.
 */
export function sandboxStateText(line: VmStateLine | null): string {
	if (line === null) return "stopped";
	// Strip formatVmState's `VM  ` head; the dashboard re-heads with `Sandbox  `.
	return formatVmState(line).slice("VM".length).trim();
}

/**
 * Is a sandbox session ACTIVE — the dashboard's own matrix-row-5 signal? A vm-state
 * line with state `booting` or `ready` means a live QEMU holds the RAM and the session
 * tree, so the Sandbox screen hides *Install sandbox* (a concurrent build is exactly
 * the RAM-contention/file-race exclusion — the operator is never offered an action
 * that can't run). `stopped`/`failed`/`off` and no-line-at-all are all "no live
 * session". The vm-side single-flight scan (runInstall's) stays the race authority —
 * a stale line's blind spot is covered by the refusal surfaced inline. Pure.
 */
export function vmSessionActive(line: VmStateLine | null): boolean {
	return line !== null && (line.state === "booting" || line.state === "ready");
}

/**
 * The verbatim Sandbox state row — {@link sandboxStateText} with the
 * `Sandbox  ` head (the monitor's `VM  ` head swapped for the entry's own
 * name). e.g. `Sandbox  ready · session vm-20260911T101112Z-ab · ssh :42255`.
 * Pure.
 */
export function sandboxStateRow(line: VmStateLine | null): string {
	return `Sandbox  ${sandboxStateText(line)}`;
}

/**
 * The Sandbox screen's header lines (spec 28, matrix row 9): the state row
 * verbatim, then — when the effective guest root is known (vm modes, resolvable
 * env) — the `guest root: <rootDir>` row surfacing `MCP_ROOT_DIR`'s guest
 * reinterpretation (the same value a boot resolves; the store computes it via
 * `resolveConfig`). `null` root (off mode / unresolvable) renders no root row.
 * While a vm settings write is saved but not yet applied by a running server
 * (matrix row 3), a `note:` row carries {@link VM_APPLY_HINT} — the
 * apply-on-restart affordance, rendered for as long as the change is pending.
 * Pure.
 */
export function sandboxHeaderRows(
	line: VmStateLine | null,
	guestRoot: string | null,
	vmApplyPending = false,
): string[] {
	const rows = [sandboxStateRow(line)];
	if (guestRoot !== null) rows.push(`guest root: ${guestRoot}`);
	if (vmApplyPending) rows.push(`note: ${VM_APPLY_HINT}`);
	return rows;
}

// ---- the vm mode-select guards + the apply-on-restart affordance (spec 28, box 28c) ----

/**
 * The row-3 hint (matrix row 3, restart-to-apply symmetry): a vm settings write
 * that the running server has NOT picked up yet (the dashboard restarted nothing,
 * or its restart attempt failed). Flashed once at write time and rendered as the
 * Sandbox header's `note:` row for as long as the store's `vmApplyPending` holds.
 */
export const VM_APPLY_HINT = "vm settings saved — restart openhammer to apply them";

/**
 * Is ANY configured channel a PUBLIC exposure? The matrix-row-1 predicate behind
 * the vm/agent → `off` warning. Exact predicate, over the settings doc only (the
 * warning's premise is "on restart" — the NEXT boot could resolve any configured
 * channel, so the operator's current default does not narrow it):
 *
 * - a `live` channel is ALWAYS public — ngrok/cloudflare/nginx spawn a tunnel
 *   whose URL is discovered from the provider (never loopback by design);
 * - a `static` channel is public iff it DECLARES a `publicUrl` that is not
 *   loopback — the localhost-only static channel the spec excludes is one whose
 *   publicUrl host is `localhost`, `127.0.0.1`, or `::1`;
 * - a static channel with no declared `publicUrl` resolves to no handle at boot
 *   (the graceful-absent path) — not public;
 * - a declared URL that does not PARSE is treated as public — fail-safe toward
 *   warning when exposure cannot be ruled out.
 *
 * Pure — a configured-channel fact, independent of live up/down state.
 */
export function hasPublicChannel(settings: Settings): boolean {
	return settings.channels.some((channel) => {
		if (channel.mode === "live") {
			return true;
		}
		const declared = channel.options.publicUrl;
		if (declared === undefined || declared.trim() === "") {
			return false;
		}
		try {
			const host = new URL(declared).hostname.toLowerCase();
			return !(host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]");
		} catch {
			return true; // unparseable declared URL — cannot prove loopback, so warn
		}
	});
}

/**
 * Field-wise equality of two {@link VmSettings} — did THIS write touch the vm
 * section? Pure; used to scope the restart-to-apply affordance (row 3) to vm
 * writes so an unrelated section edit never restarts the server or flashes the
 * pending hint.
 */
export function vmSettingsEqual(a: VmSettings, b: VmSettings): boolean {
	return (
		a.mode === b.mode &&
		a.memoryMb === b.memoryMb &&
		a.cpus === b.cpus &&
		a.persist === b.persist &&
		a.idleTimeoutMs === b.idleTimeoutMs &&
		a.agentCmd === b.agentCmd &&
		a.secretsDir === b.secretsDir
	);
}

// ---- the serial tail (spec 28, box 28b) -----------------------------------------

/**
 * The serial-tail window: the drill-in renders the LAST {@link SERIAL_TAIL_LINES}
 * lines of the session's serial.log — bounded and tail-biased (a boot's verdict
 * and a guest's last words sit at the END), a static snapshot, never a live follow.
 */
export const SERIAL_TAIL_LINES = 200;

/**
 * The raw serial-log read the dashboard's `readSerial` action seam returns: the
 * file's full text plus its exact byte size (the byte note the serial screen shows).
 */
export interface SerialSource {
	readonly content: string;
	readonly totalBytes: number;
}

/** The bounded serial view the serial drill-in screen renders. */
export interface SerialTail {
	/** The tail-biased lines (≤ {@link SERIAL_TAIL_LINES}), `\r`-stripped. */
	readonly lines: string[];
	readonly totalBytes: number;
	/** True when the log had more lines than the window (the head was dropped). */
	readonly truncated: boolean;
	/** The log's full line count (what `truncated` is measured against). */
	readonly lineCount: number;
}

/**
 * Tail-bias a raw serial read into the bounded view: split on `\r?\n` (the guest
 * writes CRLF), drop the trailing-newline artifact, keep the last
 * {@link SERIAL_TAIL_LINES} lines. Pure.
 */
export function serialTailOf(content: string, totalBytes: number): SerialTail {
	const all = content.split(/\r?\n/);
	if (all.length > 0 && all[all.length - 1] === "") all.pop();
	const truncated = all.length > SERIAL_TAIL_LINES;
	return {
		lines: truncated ? all.slice(-SERIAL_TAIL_LINES) : all,
		totalBytes,
		truncated,
		lineCount: all.length,
	};
}

/**
 * The serial screen's one-line summary: the window ("last N of M lines" when
 * truncated, "M lines" when whole), the total-bytes note, and the not-live
 * posture (a snapshot — re-open it for a fresher one). Pure.
 */
export function serialTailNote(tail: SerialTail): string {
	const window = tail.truncated
		? `last ${tail.lines.length} of ${tail.lineCount} lines`
		: `${tail.lineCount} ${tail.lineCount === 1 ? "line" : "lines"}`;
	return `serial.log — ${window} · ${formatBytes(tail.totalBytes)} total · read-only snapshot (not live)`;
}
