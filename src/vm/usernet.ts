// `info usernet` ephemeral-port discovery — spec 25d: learn the slirp-assigned hostfwd port
// (qemu/args.ts's `hostfwd=tcp:127.0.0.1:0-:22`) through 24b's `human-monitor-command`
// passthrough, and parse the table for the one row the ssh transport dials. The parser is the
// promotion of the probe-verified spike code (scripts/vm-spike/runtime.ts's
// parseUsernetHostPort — logic verbatim; every 22a–22e runner learned its port this way), so
// the product and the harness that measured this host's QEMU 11.1 agree on the row shape.
//
// WHY THE PARSER IS SHAPE-CONSERVATIVE: the fd column varies across boots (observed 17, 18,
// 39 — 22-measured gate 8), so a row is matched by MEANING, never by column position or fd:
// proto[state] = TCP[HOST_FORWARD], srcAddr = 127.0.0.1, dstPort = 22 (the guest sshd), and
// the host port to dial is srcPort (tokens[3]). Everything else in the table — other guest
// ports' forwards, IPv6 rows, header lines — is skipped, not guessed at.
//
// WHY DISCOVERY POLLS: the row exists from slirp netdev setup, from the FIRST seconds of boot
// and before sshd does (gate 8) — but an early passthrough can race the monitor's first
// reply, so a parse miss AND a rejected command are both retryable, not fatal (the spike
// runners' re-query-every-tick pattern), bounded here to attempts × interval.
import type { QmpClient } from "./qmp/client.ts";

/** The one HMP line this module reads (24b's passthrough consumer). */
export const USERNET_COMMAND = "info usernet";

/**
 * Discovery defaults: 10 attempts × 500 ms. The row exists from slirp setup — this is the
 * spike runners' steady-state cadence — so 5 s of polling is generous for a healthy QEMU and
 * short enough that a dead netdev surfaces fast.
 */
export const USERNET_ATTEMPTS = 10;

/** Sleep between discovery attempts (never slept after the final one). */
export const USERNET_INTERVAL_MS = 500;

/** Bound on the table text the failure diagnostic carries (the SSH_TAIL_BYTES precedent). */
export const USERNET_TABLE_TAIL_BYTES = 1024;

/**
 * Parse the `info usernet` table for the slirp hostfwd row. Row shape (whitespace-run
 * separated), as recorded in 22-measured gate 8 on this host's QEMU 11.1 — one row per
 * hostfwd, the four observed boots (fd 17/18/39) plus the spike doc's own example (fd 14):
 *
 * ```text
 * TCP[HOST_FORWARD]  18       127.0.0.1 41733       10.0.2.15    22     0     0
 * TCP[HOST_FORWARD]  39       127.0.0.1 40199       10.0.2.15    22     0     0
 * TCP[HOST_FORWARD]  17       127.0.0.1 36547       10.0.2.15    22     0     0
 * TCP[HOST_FORWARD]  17       127.0.0.1 44005       10.0.2.15    22     0     0
 * ```
 *
 * tokens: `proto[state] fd srcAddr srcPort dstAddr dstPort recvq sendq`. The fd column
 * varies across boots (observed 17, 18, 39) — NEVER key on it or on column position: the
 * match is `TCP[HOST_FORWARD]` + srcAddr `127.0.0.1` + dstPort `22`, and the host port we
 * dial is srcPort (tokens[3]). Returns the matched row (trimmed, for run-log diagnostics)
 * plus the port; undefined when no such row exists (yet).
 */
export function parseUsernetHostPort(table: string): { row: string; port: number } | undefined {
	for (const line of table.split(/\r?\n/)) {
		const tokens = line.trim().split(/\s+/);
		if (tokens[0] !== "TCP[HOST_FORWARD]" || tokens.length < 6) {
			continue;
		}
		const sourceAddress = tokens[2];
		const sourcePort = tokens[3];
		const destinationPort = tokens[5];
		const port = Number(sourcePort);
		if (sourceAddress === "127.0.0.1" && destinationPort === "22" && Number.isInteger(port) && port > 0) {
			return { row: line.trim(), port };
		}
	}
	return undefined;
}

/** discoverSshPort's tunables — every knob injectable so the poll is testable with no wall clock. */
export interface DiscoverSshPortOptions {
	/** Poll attempts before giving up (default {@link USERNET_ATTEMPTS}); must be >= 1. */
	readonly attempts?: number;
	/** Sleep between attempts, ms (default {@link USERNET_INTERVAL_MS}). */
	readonly intervalMs?: number;
	/** The sleeper — tests inject a recording no-op. */
	readonly sleep?: (ms: number) => Promise<void>;
}

// The default sleeper (the spike runtime's `sleep`).
const sleepDefault = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

// Byte-exact tail of the table text (tailSink's Buffer discipline): HMP tables are ASCII in
// practice, but the bound is bytes, not code points.
function tableTail(table: string): string {
	return Buffer.from(table, "utf8").subarray(-USERNET_TABLE_TAIL_BYTES).toString("utf8");
}

/**
 * Poll `info usernet` through the QMP passthrough until the hostfwd row parses, and resolve
 * the slirp-assigned host port the ssh transport dials. Each failed attempt — no row yet, or
 * a rejected passthrough command (the early-probe monitor race) — retries after
 * `intervalMs`; only the final miss rejects, with an actionable hint plus the LAST table text
 * (tailed to {@link USERNET_TABLE_TAIL_BYTES}) for diagnostics — or, when no table ever
 * arrived, the last command error. The `qmp` seam is `Pick<QmpClient,
 * "humanMonitorCommand">` so fakes fit structurally.
 */
export async function discoverSshPort(
	qmp: Pick<QmpClient, "humanMonitorCommand">,
	opts: DiscoverSshPortOptions = {},
): Promise<number> {
	const attempts = opts.attempts ?? USERNET_ATTEMPTS;
	if (attempts < 1) {
		throw new Error(`discoverSshPort: attempts must be >= 1 (got ${attempts})`);
	}
	const intervalMs = opts.intervalMs ?? USERNET_INTERVAL_MS;
	const sleep = opts.sleep ?? sleepDefault;
	let lastTable: string | undefined;
	let lastError: string | undefined;
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (attempt > 0) {
			await sleep(intervalMs); // between attempts only — never a dead sleep after the last
		}
		try {
			const table = await qmp.humanMonitorCommand(USERNET_COMMAND);
			lastTable = table;
			const found = parseUsernetHostPort(table);
			if (found !== undefined) {
				return found.port;
			}
		} catch (error) {
			// Retryable, exactly as in the spike runners: an early probe can race the monitor;
			// the loop count (not the error) is what bounds this.
			lastError = error instanceof Error ? error.message : String(error);
		}
	}
	const diagnostic =
		lastTable !== undefined ? `last table: ${tableTail(lastTable)}` : `last error: ${lastError ?? "none"}`;
	throw new Error(`no hostfwd row in info usernet after ${attempts} attempts — is the guest netdev up? ${diagnostic}`);
}
