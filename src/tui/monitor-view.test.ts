import { describe, expect, it } from "vitest";
import type { RequestEvent } from "../mcp/telemetry.ts";
import {
	formatBytes,
	formatClientHeader,
	formatDuration,
	formatEvent,
	formatStatusSuffix,
	isoTimeOf,
	MonitorState,
	parseEventLine,
} from "./monitor-view.ts";

/** A minimal valid event for the formatter/state tests. */
function event(over: Partial<RequestEvent> = {}): RequestEvent {
	return {
		ts: "2026-06-24T12:01:03.456Z",
		client: "claude-code/1.0",
		method: "tools/call",
		tool: "bash",
		reqBytes: 10,
		resBytes: 200,
		ms: 1200,
		status: 200,
		...over,
	};
}

describe("parseEventLine", () => {
	it("parses a valid event line", () => {
		const e = parseEventLine(JSON.stringify(event()));
		expect(e).not.toBeNull();
		expect(e?.tool).toBe("bash");
	});

	it("returns null for a blank line", () => {
		expect(parseEventLine("")).toBeNull();
		expect(parseEventLine("   ")).toBeNull();
	});

	it("returns null for malformed JSON", () => {
		expect(parseEventLine("{not json")).toBeNull();
	});

	it("returns null for valid JSON of the wrong shape", () => {
		expect(parseEventLine(JSON.stringify({ nope: true }))).toBeNull();
		expect(parseEventLine("123")).toBeNull();
		expect(parseEventLine("[]")).toBeNull();
	});

	it("accepts a tool-less event (method only)", () => {
		const e = parseEventLine(JSON.stringify(event({ tool: null, method: "tools/list" })));
		expect(e?.tool).toBeNull();
		expect(e?.method).toBe("tools/list");
	});
});

describe("isoTimeOf", () => {
	it("extracts HH:MM:SS from an ISO timestamp", () => {
		expect(isoTimeOf("2026-06-24T12:01:03.456Z")).toBe("12:01:03");
	});

	it("falls back to the raw string when not ISO-shaped", () => {
		expect(isoTimeOf("not-iso")).toBe("not-iso");
		expect(isoTimeOf("")).toBe("");
	});
});

describe("formatDuration", () => {
	it("keeps sub-second durations in ms", () => {
		expect(formatDuration(0)).toBe("0ms");
		expect(formatDuration(999)).toBe("999ms");
	});

	it("rolls up to seconds at ≥1000ms (one decimal)", () => {
		expect(formatDuration(1000)).toBe("1.0s");
		expect(formatDuration(1200)).toBe("1.2s");
	});
});

describe("formatBytes", () => {
	it("appends a B suffix", () => {
		expect(formatBytes(200)).toBe("200B");
		expect(formatBytes(0)).toBe("0B");
	});
});

describe("formatStatusSuffix", () => {
	it("is empty for success (200-299) and no-status (0)", () => {
		expect(formatStatusSuffix(0)).toBe("");
		expect(formatStatusSuffix(200)).toBe("");
		expect(formatStatusSuffix(204)).toBe("");
	});

	it("is the raw code for errors", () => {
		expect(formatStatusSuffix(401)).toBe("401");
		expect(formatStatusSuffix(403)).toBe("403");
		expect(formatStatusSuffix(500)).toBe("500");
	});
});

describe("formatEvent", () => {
	it("renders a successful tools/call line (matches the spec example shape)", () => {
		expect(formatEvent(event())).toBe("[12:01:03] claude-code/1.0  tools/call bash  1.2s  200B");
	});

	it("omits the tool slot for non-tools/call events", () => {
		expect(formatEvent(event({ tool: null, method: "tools/list", ms: 120, resBytes: 150 }))).toBe(
			"[12:01:03] claude-code/1.0  tools/list  120ms  150B",
		);
	});

	it("appends the status code for an error response", () => {
		expect(formatEvent(event({ status: 401, ms: 0, resBytes: 24 }))).toBe(
			"[12:01:03] claude-code/1.0  tools/call bash  0ms  24B  401",
		);
	});
});

describe("formatClientHeader", () => {
	it("renders a placeholder when there are no clients yet", () => {
		expect(formatClientHeader([])).toBe("active clients: (none yet)");
	});

	it("lists each client with its call count", () => {
		expect(
			formatClientHeader([
				{ client: "claude-code/1.0", calls: 3, lastSeen: "a" },
				{ client: "vscode", calls: 1, lastSeen: "b" },
			]),
		).toBe("active clients: claude-code/1.0×3, vscode×1");
	});
});

describe("MonitorState", () => {
	it("starts empty", () => {
		const s = new MonitorState();
		expect(s.has("x")).toBe(false);
		expect(s.stats()).toEqual([]);
	});

	it("creates an entry on the first event from a client", () => {
		const s = new MonitorState();
		s.apply(event({ client: "a", ts: "t1" }));
		expect(s.has("a")).toBe(true);
		expect(s.stats()).toEqual([{ client: "a", calls: 1, lastSeen: "t1" }]);
	});

	it("bumps the count + last-seen on repeat clients", () => {
		const s = new MonitorState();
		s.apply(event({ client: "a", ts: "t1" }));
		s.apply(event({ client: "a", ts: "t2" }));
		s.apply(event({ client: "b", ts: "t3" }));
		const stats = s.stats();
		expect(stats).toContainEqual({ client: "a", calls: 2, lastSeen: "t2" });
		expect(stats).toContainEqual({ client: "b", calls: 1, lastSeen: "t3" });
	});
});
