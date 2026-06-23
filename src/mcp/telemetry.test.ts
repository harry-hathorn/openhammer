import type { AddressInfo } from "node:net";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import {
	attachRequestRecorder,
	parseRpc,
	type RequestEvent,
	RequestRecorder,
	readClientName,
	readContentLength,
	readUserAgent,
	resolveClient,
} from "./telemetry.ts";

/** Build a minimal event (defaults that are irrelevant to most assertions). */
function event(partial: Partial<RequestEvent> = {}): RequestEvent {
	return {
		ts: "2026-06-23T00:00:00.000Z",
		client: "claude-code/1.0",
		method: "tools/call",
		tool: "bash",
		reqBytes: 10,
		resBytes: 20,
		ms: 5,
		status: 200,
		...partial,
	};
}

describe("parseRpc", () => {
	it("reads the method + tool name from a tools/call body", () => {
		expect(parseRpc({ jsonrpc: "2.0", method: "tools/call", params: { name: "bash" } })).toEqual({
			method: "tools/call",
			tool: "bash",
		});
	});

	it("reads initialize / tools/list without a tool", () => {
		expect(parseRpc({ method: "initialize" })).toEqual({ method: "initialize", tool: null });
		expect(parseRpc({ method: "tools/list" })).toEqual({ method: "tools/list", tool: null });
	});

	it("returns null tool when tools/call has no params.name", () => {
		expect(parseRpc({ method: "tools/call", params: {} })).toEqual({ method: "tools/call", tool: null });
		expect(parseRpc({ method: "tools/call" })).toEqual({ method: "tools/call", tool: null });
	});

	it("returns null/null for a non-object / array / absent body", () => {
		expect(parseRpc(undefined)).toEqual({ method: null, tool: null });
		expect(parseRpc(null)).toEqual({ method: null, tool: null });
		expect(parseRpc([1, 2, 3])).toEqual({ method: null, tool: null });
		expect(parseRpc("nope")).toEqual({ method: null, tool: null });
	});

	it("returns null method when method is not a string", () => {
		expect(parseRpc({ method: 42 })).toEqual({ method: null, tool: null });
		expect(parseRpc({})).toEqual({ method: null, tool: null });
	});
});

describe("readUserAgent", () => {
	it("passes a string header through", () => {
		expect(readUserAgent("claude-code/1.0")).toBe("claude-code/1.0");
	});

	it("returns unknown for array / undefined headers", () => {
		expect(readUserAgent(["a", "b"])).toBe("unknown");
		expect(readUserAgent(undefined)).toBe("unknown");
	});
});

describe("readContentLength", () => {
	it("reads a number verbatim (floored, NaN-safe)", () => {
		expect(readContentLength(123)).toBe(123);
		expect(readContentLength(12.9)).toBe(12);
		expect(readContentLength(Number.NaN)).toBe(0);
	});

	it("parses a numeric string", () => {
		expect(readContentLength("456")).toBe(456);
		expect(readContentLength("not-a-number")).toBe(0);
	});

	it("takes the first of a repeated header, else 0", () => {
		expect(readContentLength(["100", "200"])).toBe(100);
		expect(readContentLength([])).toBe(0);
		expect(readContentLength(undefined)).toBe(0);
	});
});

describe("readClientName + resolveClient", () => {
	it("uses clientInfo.name on initialize when present", () => {
		expect(readClientName({ method: "initialize", params: { clientInfo: { name: "claude-code" } } })).toBe(
			"claude-code",
		);
		expect(resolveClient("UA", "initialize", { params: { clientInfo: { name: "claude-code" } } })).toBe(
			"claude-code",
		);
	});

	it("falls back to the User-Agent on initialize without clientInfo", () => {
		expect(readClientName({ method: "initialize" })).toBe(null);
		expect(resolveClient("UA", "initialize", {})).toBe("UA");
	});

	it("uses the User-Agent for non-initialize methods (stateless — clientInfo isn't retained)", () => {
		expect(resolveClient("UA", "tools/call", { params: { clientInfo: { name: "claude-code" } } })).toBe("UA");
		expect(resolveClient("UA", null, {})).toBe("UA");
	});
});

describe("RequestRecorder", () => {
	it("record appends to recent in chronological order", () => {
		const recorder = new RequestRecorder();
		recorder.record(event({ ts: "1" }));
		recorder.record(event({ ts: "2" }));
		expect(recorder.recent().map((e) => e.ts)).toEqual(["1", "2"]);
	});

	it("ring buffer evicts the oldest beyond capacity, keeping newest in order", () => {
		const recorder = new RequestRecorder(3);
		for (const ts of ["a", "b", "c", "d", "e"]) recorder.record(event({ ts }));
		// capacity 3, recorded 5 → keeps c, d, e (drops a, b).
		expect(recorder.recent().map((e) => e.ts)).toEqual(["c", "d", "e"]);
	});

	it("ring buffer of capacity 1 keeps only the newest", () => {
		const recorder = new RequestRecorder(1);
		recorder.record(event({ ts: "a" }));
		recorder.record(event({ ts: "b" }));
		expect(recorder.recent().map((e) => e.ts)).toEqual(["b"]);
	});

	it("activeClients tracks per-client call counts + lastSeen", () => {
		const recorder = new RequestRecorder();
		recorder.record(event({ client: "a", ts: "1" }));
		recorder.record(event({ client: "a", ts: "2" }));
		recorder.record(event({ client: "b", ts: "3" }));
		const stats = recorder.activeClients();
		expect(stats).toContainEqual({ client: "a", calls: 2, lastSeen: "2" });
		expect(stats).toContainEqual({ client: "b", calls: 1, lastSeen: "3" });
	});

	it("activeClients returns a copy — mutating it does not change the recorder", () => {
		const recorder = new RequestRecorder();
		recorder.record(event({ client: "a" }));
		const stats = recorder.activeClients();
		stats.push({ client: "intruder", calls: 9, lastSeen: "" });
		expect(recorder.activeClients()).toHaveLength(1);
	});

	it("subscribe is called with each new event", () => {
		const recorder = new RequestRecorder();
		const seen: RequestEvent[] = [];
		recorder.subscribe((e) => seen.push(e));
		recorder.record(event({ ts: "1" }));
		recorder.record(event({ ts: "2" }));
		expect(seen.map((e) => e.ts)).toEqual(["1", "2"]);
	});

	it("unsubscribe stops delivery and is idempotent", () => {
		const recorder = new RequestRecorder();
		const seen: RequestEvent[] = [];
		const unsub = recorder.subscribe((e) => seen.push(e));
		recorder.record(event({ ts: "1" }));
		unsub();
		unsub(); // idempotent
		recorder.record(event({ ts: "2" }));
		expect(seen.map((e) => e.ts)).toEqual(["1"]);
	});

	it("a throwing subscriber is dropped — record never throws and other subscribers keep working", () => {
		const recorder = new RequestRecorder();
		const ok: RequestEvent[] = [];
		recorder.subscribe(() => {
			throw new Error("boom");
		});
		recorder.subscribe((e) => ok.push(e));
		expect(() => recorder.record(event({ ts: "1" }))).not.toThrow();
		expect(ok.map((e) => e.ts)).toEqual(["1"]);
		// The thrower is gone; a second event still reaches the healthy subscriber.
		recorder.record(event({ ts: "2" }));
		expect(ok.map((e) => e.ts)).toEqual(["1", "2"]);
	});

	it("close drops every subscriber", () => {
		const recorder = new RequestRecorder();
		const seen: RequestEvent[] = [];
		recorder.subscribe((e) => seen.push(e));
		recorder.close();
		recorder.record(event({ ts: "1" }));
		expect(seen).toHaveLength(0);
	});
});

describe("attachRequestRecorder", () => {
	it("records a real POST /mcp round-trip and skips non-/mcp routes", async () => {
		const app = Fastify({ logger: false });
		const recorder = new RequestRecorder();
		attachRequestRecorder(app, recorder);
		// Hijack + write the response directly via `writeHead` — exactly the path the
		// SDK takes in production (`reply.hijack()` then `@hono/node-server` writes
		// `writeHead` with `Content-Length`). This is what the hook reads `resBytes` from.
		app.post("/mcp", async (_req, reply) => {
			reply.hijack();
			reply.raw.writeHead(200, { "content-type": "text/plain", "content-length": "5" });
			reply.raw.end("hello");
		});
		// A non-/mcp route must NOT be recorded.
		app.get("/health", async () => ({ status: "ok" }));
		await app.listen({ port: 0, host: "127.0.0.1" });
		const { port } = app.server.address() as AddressInfo;
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "bash" } });
		try {
			await (await fetch(`http://127.0.0.1:${port}/health`)).text();
			const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
				method: "POST",
				headers: { "user-agent": "claude-code/1.0", "content-type": "application/json" },
				body,
			});
			expect(res.status).toBe(200);
			await res.text(); // fully consume so the response `finish` fires before we assert
		} finally {
			await app.close();
		}

		const events = recorder.recent();
		expect(events).toHaveLength(1); // /health was not recorded
		const [e] = events;
		expect(e.method).toBe("tools/call");
		expect(e.tool).toBe("bash");
		expect(e.client).toBe("claude-code/1.0");
		expect(e.status).toBe(200);
		expect(e.reqBytes).toBe(Buffer.byteLength(body));
		// resBytes = wire bytes (status line + headers + the 5-byte body) for this request.
		expect(e.resBytes).toBeGreaterThanOrEqual(5);
		expect(e.ms).toBeGreaterThanOrEqual(0);
	});
});
