/**
 * Pure rendering for `openhammer monitor` (spec 17t): parse the status socket's
 * NDJSON event stream and format it as a tail-`f`-style live feed
 * (`[HH:MM:SS] client  method tool  duration bytes`), plus a rolling header of
 * active clients + call counts. No I/O lives here — the {@link MonitorState}
 * reducer and the formatters are pure so the unit tests drive them directly (the
 * `11a`/`13`/`17b`–`17s` "export the testable pure part" precedent); the socket
 * connection + stream loop are {@link monitorCommand}'s job in `src/cli/monitor.ts`.
 *
 * The event shape is {@link RequestEvent} from `src/mcp/telemetry.ts` — the
 * status socket emits exactly those, one compact JSON per line (see
 * `formatEventLine` in `status-socket.ts`). So this module is the client-side
 * counterpart to the recorder's wire format.
 */
import type { ClientStat, RequestEvent } from "../mcp/telemetry.ts";

/** Is `v` a plain object (not an array, not null)? */
function isStringRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Is `v` a structurally-valid {@link RequestEvent}? The recorder always emits all
 * eight fields, but a hand-edited or future-shape line is skipped rather than
 * mis-rendered — the feed never aborts on one bad line.
 */
function isRequestEvent(v: unknown): v is RequestEvent {
	if (!isStringRecord(v)) return false;
	return (
		typeof v.ts === "string" &&
		typeof v.client === "string" &&
		(typeof v.method === "string" || v.method === null) &&
		(typeof v.tool === "string" || v.tool === null) &&
		typeof v.reqBytes === "number" &&
		typeof v.resBytes === "number" &&
		typeof v.ms === "number" &&
		typeof v.status === "number"
	);
}

/**
 * Parse one NDJSON line into a {@link RequestEvent}. Returns `null` for a blank
 * line, malformed JSON, or a value that isn't a structurally-valid event — a
 * skipped line, never a throw.
 */
export function parseEventLine(line: string): RequestEvent | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return null;
	}
	return isRequestEvent(parsed) ? parsed : null;
}

/**
 * Extract `HH:MM:SS` from an ISO-8601 timestamp. The recorder stamps
 * `new Date().toISOString()` (`2026-06-24T12:01:03.456Z`), where the time of day
 * sits at offset 11. Falls back to the raw string when it isn't ISO-shaped, so a
 * malformed `ts` never corrupts the line. Deterministic + side-effect-free (no
 * `Date` parsing) so the unit test asserts a fixed output for a fixed input.
 */
export function isoTimeOf(ts: string): string {
	if (ts.length >= 19 && ts.charAt(10) === "T") return ts.slice(11, 19);
	return ts;
}

/**
 * Format a millisecond duration: sub-second keeps `ms`; a second or more rolls
 * up to one decimal (`1.2s`). Matches the spec's example line.
 */
export function formatDuration(ms: number): string {
	return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Format a byte count with a `B` suffix (the spec's `200B`). Plain — a K/M/G suffix is a future dashboard nicety. */
export function formatBytes(n: number): string {
	return `${n}B`;
}

/**
 * The status suffix appended to an event line: `""` for success / no-status, the
 * raw code (`401`/`403`/`500`) otherwise. A clean `200` matches the spec's
 * example line exactly (no suffix); an error stands out. `0` (the hijacked path
 * never finished — no status sent) is treated as nothing-to-flag.
 */
export function formatStatusSuffix(status: number): string {
	if (status === 0) return "";
	if (status >= 200 && status < 300) return "";
	return `${status}`;
}

/**
 * Format one event as a monitor line: `[HH:MM:SS] client  method [tool]
 * duration bytes [status]`. The tool name appends only on `tools/call` (one
 * space — `tools/call bash`); the status suffix appends only for non-success.
 * e.g. `[12:01:03] claude-code  tools/call bash  1.2s  200B` (success),
 *      `[12:01:03] bad-token  tools/call bash  0ms  24B  401` (auth failure).
 */
export function formatEvent(event: RequestEvent): string {
	const when = `[${isoTimeOf(event.ts)}]`;
	const call = event.tool !== null ? `${event.method ?? "?"} ${event.tool}` : `${event.method ?? "?"}`;
	const line = `${when} ${event.client}  ${call}  ${formatDuration(event.ms)}  ${formatBytes(event.resBytes)}`;
	const suffix = formatStatusSuffix(event.status);
	return suffix !== "" ? `${line}  ${suffix}` : line;
}

/**
 * Format the rolling client summary — the active clients + their call counts —
 * as a one-line header. The monitor reprints this whenever a new client joins
 * the active set: the closest "rolling header" behavior achievable without a
 * render loop, which the §2.1 footprint rule forbids for v1 (a full-screen
 * dashboard that redraws in place would re-open the render-lib question). An
 * empty set (no events yet) renders a placeholder so a quiet feed still frames.
 */
export function formatClientHeader(stats: ClientStat[]): string {
	if (stats.length === 0) return "active clients: (none yet)";
	const summary = stats.map((s) => `${s.client}×${s.calls}`).join(", ");
	return `active clients: ${summary}`;
}

/**
 * The monitor's rolling view of active clients + call counts, accumulated from
 * the events it receives (the dump on connect, then live). This mirrors the
 * slice of `RequestRecorder` the monitor can derive from its stream alone (it
 * holds no handle on the recorder) — the "active-client set" the rolling header
 * is built from.
 */
export class MonitorState {
	private readonly clients = new Map<string, ClientStat>();

	/** Has this client been seen yet? (Decides whether to reprint the header.) */
	has(client: string): boolean {
		return this.clients.has(client);
	}

	/** Fold an event into the active-client counts (creating or bumping the entry). */
	apply(event: RequestEvent): void {
		const existing = this.clients.get(event.client);
		if (existing !== undefined) {
			existing.calls += 1;
			existing.lastSeen = event.ts;
		} else {
			this.clients.set(event.client, { client: event.client, calls: 1, lastSeen: event.ts });
		}
	}

	/** The active-client stats (call counts + last-seen), as a fresh array. */
	stats(): ClientStat[] {
		return [...this.clients.values()];
	}
}
