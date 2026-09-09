import { describe, expect, it } from "vitest";
import type { QmpClient } from "./qmp/client.ts";
import {
	type DiscoverSshPortOptions,
	discoverSshPort,
	parseUsernetHostPort,
	USERNET_ATTEMPTS,
	USERNET_COMMAND,
	USERNET_INTERVAL_MS,
	USERNET_TABLE_TAIL_BYTES,
} from "./usernet.ts";

// The four REAL recorded rows from 22-measured gate 8 (each boot's run log is the evidence;
// the annotations there — install-07-18, matrix-gl-07-31, matrix-headless, probes run 4 —
// cite the source run, they are not table text). Copied with their exact whitespace runs.
const GATE8_ROWS: Array<{ row: string; port: number; source: string }> = [
	{
		row: "TCP[HOST_FORWARD]  18       127.0.0.1 41733       10.0.2.15    22     0     0",
		port: 41733,
		source: "install-07-18",
	},
	{
		row: "TCP[HOST_FORWARD]  39       127.0.0.1 40199       10.0.2.15    22     0     0",
		port: 40199,
		source: "matrix-gl-07-31",
	},
	{
		row: "TCP[HOST_FORWARD]  17       127.0.0.1 36547       10.0.2.15    22     0     0",
		port: 36547,
		source: "matrix-headless",
	},
	{
		row: "TCP[HOST_FORWARD]  17       127.0.0.1 44005       10.0.2.15    22     0     0",
		port: 44005,
		source: "probes run 4",
	},
];

// The spike runtime's own documented example (fd 14 — a fifth fd value, same shape).
const SPIKE_DOC_ROW = "  TCP[HOST_FORWARD]  14  127.0.0.1 43423  10.0.2.15 22  0 0";

describe("parseUsernetHostPort — the 22-measured gate-8 rows", () => {
	it("parses every recorded row: fd 17/18/39 (and the spike doc's 14) all yield their srcPort", () => {
		for (const { row, port } of GATE8_ROWS) {
			expect(parseUsernetHostPort(row)).toEqual({ row, port });
		}
		expect(parseUsernetHostPort(SPIKE_DOC_ROW)).toEqual({ row: SPIKE_DOC_ROW.trim(), port: 43423 });
	});

	it("finds the row inside a full table with non-matching lines around it", () => {
		// Header/noise lines are illustrative (the run logs quote only the rows); the parser
		// must skip anything that is not the hostfwd row, whatever QEMU prints around it.
		const table = [
			"id[0]=n0, index=0, type=driver, net=n0, host=char7",
			"Protocol[State]    FD    Local Address    Port    Remote Address    Port    RecvQ    SendQ",
			GATE8_ROWS[1]?.row ?? "",
			"UDP[HOST_FORWARD]   3  127.0.0.1 5353  10.0.2.15  53  0 0",
			"",
		].join("\n");
		expect(parseUsernetHostPort(table)).toEqual({ row: GATE8_ROWS[1]?.row, port: 40199 });
	});

	it("returns the FIRST matching row when a (malformed) table repeats one", () => {
		const repeated = `${GATE8_ROWS[0]?.row}\n${GATE8_ROWS[2]?.row}`;
		expect(parseUsernetHostPort(repeated)).toEqual({ row: GATE8_ROWS[0]?.row, port: 41733 });
	});

	it("whitespace runs separate columns: double spaces and tabs parse identically", () => {
		// The real tables use space runs; `/\s+/` is the contract, so tabs must not break it.
		// The returned row keeps the line's OWN whitespace (trimmed only) — verbatim, not re-joined.
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  18  127.0.0.1  41733  10.0.2.15  22  0  0")).toEqual({
			row: "TCP[HOST_FORWARD]  18  127.0.0.1  41733  10.0.2.15  22  0  0",
			port: 41733,
		});
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]\t18\t127.0.0.1\t41733\t10.0.2.15\t22\t0\t0")).toEqual({
			row: "TCP[HOST_FORWARD]\t18\t127.0.0.1\t41733\t10.0.2.15\t22\t0\t0",
			port: 41733,
		});
	});

	it("CRLF line endings do not smuggle a \\r into the row", () => {
		expect(parseUsernetHostPort(`${GATE8_ROWS[0]?.row}\r\n`)).toEqual({ row: GATE8_ROWS[0]?.row, port: 41733 });
	});
});

describe("parseUsernetHostPort — malformed tables", () => {
	it("empty and whitespace-only tables parse nothing", () => {
		expect(parseUsernetHostPort("")).toBeUndefined();
		expect(parseUsernetHostPort("\n\n  \n\t\n")).toBeUndefined();
	});

	it("a row with a missing column (fewer than six tokens) is skipped", () => {
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  127.0.0.1 41733  10.0.2.15")).toBeUndefined();
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]")).toBeUndefined();
	});

	it("forwarded non-ssh noise is not the row: dstPort 23 (RDP-ish), UDP, non-loopback srcAddr", () => {
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  127.0.0.1 54321  10.0.2.15  23  0  0")).toBeUndefined();
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  0.0.0.0 41733  10.0.2.15  22  0  0")).toBeUndefined();
		expect(parseUsernetHostPort("UDP[HOST_FORWARD]  17  127.0.0.1 5353  10.0.2.15  53  0  0")).toBeUndefined();
	});

	it("a non-integer or non-positive srcPort never becomes a port", () => {
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  127.0.0.1 not-a-port  10.0.2.15  22  0  0")).toBeUndefined();
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  127.0.0.1 0  10.0.2.15  22  0  0")).toBeUndefined();
		expect(parseUsernetHostPort("TCP[HOST_FORWARD]  17  127.0.0.1 41733.5  10.0.2.15  22  0  0")).toBeUndefined();
	});
});

// ---------------------------------------------------------------- discovery fakes ----

/**
 * A passthrough fake: answers each call from `script` in order, REPEATING the last entry
 * once exhausted (a one-entry script models "the table never changes"); an Error entry
 * rejects that call. Records every command line it received.
 */
function fakeQmp(script: Array<string | Error>): { qmp: Pick<QmpClient, "humanMonitorCommand">; calls: string[] } {
	const calls: string[] = [];
	let index = 0;
	const qmp: Pick<QmpClient, "humanMonitorCommand"> = {
		humanMonitorCommand: async (commandLine) => {
			calls.push(commandLine);
			const entry = script[Math.min(index, script.length - 1)] ?? "";
			index += 1;
			if (entry instanceof Error) throw entry;
			return entry;
		},
	};
	return { qmp, calls };
}

/** A sleeper that records instead of waiting — the poll runs with zero wall clock. */
function recordingSleep(): { sleep: (ms: number) => Promise<void>; sleptMs: number[] } {
	const sleptMs: number[] = [];
	return { sleptMs, sleep: async (ms) => void sleptMs.push(ms) };
}

const EMPTY_TABLE = "";
const ROW_40199 = GATE8_ROWS[1]?.row ?? "";

describe("discoverSshPort — the poll", () => {
	it("re-queries until the row parses: empty × 2, then the gate-8 row resolves its port", async () => {
		const { qmp, calls } = fakeQmp([EMPTY_TABLE, EMPTY_TABLE, ROW_40199]);
		const { sleep, sleptMs } = recordingSleep();
		await expect(discoverSshPort(qmp, { sleep })).resolves.toBe(40199);
		expect(calls).toEqual([USERNET_COMMAND, USERNET_COMMAND, USERNET_COMMAND]);
		expect(sleptMs).toEqual([USERNET_INTERVAL_MS, USERNET_INTERVAL_MS]); // default interval
	});

	it("a rejected passthrough command is retried, not fatal (the monitor-race pattern)", async () => {
		const { qmp, calls } = fakeQmp([new Error("qmp human-monitor-command: no reply within 30 s"), ROW_40199]);
		const { sleep } = recordingSleep();
		await expect(discoverSshPort(qmp, { attempts: 3, intervalMs: 1, sleep })).resolves.toBe(40199);
		expect(calls).toHaveLength(2);
	});

	it("sleeps BETWEEN attempts only — attempts-1 sleeps, never one after the last", async () => {
		const { qmp } = fakeQmp([EMPTY_TABLE]);
		const { sleep, sleptMs } = recordingSleep();
		await expect(discoverSshPort(qmp, { attempts: 4, intervalMs: 7, sleep })).rejects.toThrow();
		expect(sleptMs).toEqual([7, 7, 7]);
	});

	it("the default attempts bound the loop: nine misses then the row still resolves", async () => {
		const script = [
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			EMPTY_TABLE,
			ROW_40199,
		];
		const { qmp, calls } = fakeQmp(script);
		const { sleep } = recordingSleep();
		await expect(discoverSshPort(qmp, { sleep })).resolves.toBe(40199); // only sleep injected
		expect(calls).toHaveLength(USERNET_ATTEMPTS);
	});

	it("never-hit rejects with the actionable message carrying the LAST table text", async () => {
		const { qmp } = fakeQmp(["first-miss", "second-miss"]);
		const { sleep } = recordingSleep();
		const error = await discoverSshPort(qmp, { attempts: 3, intervalMs: 1, sleep }).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("no hostfwd row in info usernet after 3 attempts — is the guest netdev up?");
		expect(message).toContain("last table: second-miss"); // the LAST table…
		expect(message).not.toContain("first-miss"); // …not an earlier one
	});

	it("when no table ever arrived, the rejection names the last command error instead", async () => {
		const { qmp } = fakeQmp([
			new Error("qmp: closed (socket closed)"),
			new Error("qmp human-monitor-command: socket is closed"),
		]);
		const { sleep } = recordingSleep();
		await expect(discoverSshPort(qmp, { attempts: 2, intervalMs: 1, sleep })).rejects.toThrow(
			"no hostfwd row in info usernet after 2 attempts — is the guest netdev up? " +
				"last error: qmp human-monitor-command: socket is closed",
		);
	});

	it("the carried table is bounded to the ~1 KiB tail (the head of a huge table is dropped)", async () => {
		const huge = `HEAD-MARKER${"x".repeat(5000)}TAIL-MARKER`;
		const { qmp } = fakeQmp([huge]);
		const { sleep } = recordingSleep();
		const error = await discoverSshPort(qmp, { attempts: 1, sleep }).catch((error: unknown) => error);
		const message = error instanceof Error ? error.message : "";
		expect(message).toContain("TAIL-MARKER"); // the tail survives…
		expect(message).not.toContain("HEAD-MARKER"); // …the dropped head does not ride along
		expect(message).toContain("x".repeat(100)); // real table bytes, not just the marker
	});

	it("attempts < 1 is a caller bug and throws before any polling", async () => {
		const { qmp, calls } = fakeQmp([ROW_40199]);
		const opts: DiscoverSshPortOptions = { attempts: 0 };
		await expect(discoverSshPort(qmp, opts)).rejects.toThrow("discoverSshPort: attempts must be >= 1 (got 0)");
		expect(calls).toHaveLength(0);
	});
});

describe("published constants", () => {
	it("ships the spec-25d discovery budgets", () => {
		expect(USERNET_COMMAND).toBe("info usernet");
		expect(USERNET_ATTEMPTS).toBe(10);
		expect(USERNET_INTERVAL_MS).toBe(500);
		expect(USERNET_TABLE_TAIL_BYTES).toBe(1024);
	});
});
