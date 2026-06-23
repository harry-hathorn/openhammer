/**
 * Live activity capture (spec 17s): a non-blocking {@link RequestRecorder} that
 * records each inbound `POST /mcp` as a {@link RequestEvent} —
 * `{ ts, client, method, tool?, reqBytes, resBytes, ms, status }` — into an
 * in-memory ring buffer, tracks an active-client set (per-client call counts),
 * and fans each new event to a subscriber list (the status socket streams live
 * through it).
 *
 * **Non-blocking / best-effort** (the spec's hard rule): recording never throws
 * into the request path. The only realistic throw source is a misbehaving
 * subscriber, so fan-out catches each subscriber individually and drops a
 * throwing one — the ring push + active-client map are plain data ops that don't
 * throw under normal operation. {@link attachRequestRecorder}'s finalize reads
 * only already-parsed values (`request.body`, response headers, `hrtime`), so it
 * cannot throw either; there is no blanket try/catch on the hot path.
 *
 * **Byte sizes are best-effort.** `reqBytes` is the request `content-length`
 * (Fastify's parsed header — always present for a POST with a body). `resBytes`
 * is trickier: the `/mcp` POST response is hijacked by the SDK, and Node does
 * **not** index headers passed to `writeHead(status, header)` (the path the
 * SDK's `@hono/node-server` takes) — `getHeader` returns nothing for them at
 * `finish`. So `resBytes` is measured instead as the **wire bytes written for
 * this request** — `socket.bytesWritten` at `finish` minus its value at request
 * start (differenced so a reused keep-alive socket doesn't accumulate prior
 * responses). That is the status line + headers + body, an upper bound on the
 * body (~150B of headers), exact for large tool outputs. No raw-response
 * monkey-patching keeps the path clean and the `no as` rule intact (AGENTS.md).
 *
 * The pure helpers (`parseRpc`/`readUserAgent`/`readContentLength`/
 * `readClientName`/`resolveClient`) are exported so the record's derivation is
 * unit-tested directly, mirroring the `extractTunnelUrl`/`parseClientList`
 * "export the testable pure part" precedent.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/** The JSON-RPC method read from the request body, `null` when unreadable. */
export type RpcMethod = string | null;

/**
 * One recorded inbound request — the exact shape the status socket emits as
 * NDJSON. Every field is always present (optionals collapse to `null`/`0`) so a
 * monitor client never has to handle missing keys.
 */
export interface RequestEvent {
	/** ISO timestamp the request arrived (captured at `onRequest`, i.e. start). */
	ts: string;
	/** The client identity — the inbound `User-Agent`, or `clientInfo.name` on `initialize`. */
	client: string;
	/** The JSON-RPC method (`initialize` / `tools/list` / `tools/call`, …), `null` if unreadable. */
	method: RpcMethod;
	/** The tool name on `tools/call` (`params.name`), `null` otherwise. */
	tool: string | null;
	/** Best-effort request body size (the request `content-length`), `0` when absent. */
	reqBytes: number;
	/** Best-effort response size — wire bytes (status line + headers + body) for this request, `0` when none. */
	resBytes: number;
	/** Request duration in milliseconds (`onRequest` → response `finish`), rounded. */
	ms: number;
	/** The HTTP status code sent (0 if none was sent). */
	status: number;
}

/** Per-client activity for the monitor's rolling header (the "active-client set"). */
export interface ClientStat {
	/** The client identity (User-Agent, or `clientInfo.name` on `initialize`). */
	client: string;
	/** Total recorded requests from this client. */
	calls: number;
	/** ISO timestamp of the most recent request from this client. */
	lastSeen: string;
}

/** A live-event listener registered via {@link RequestRecorder.subscribe}. */
export type RequestSubscriber = (event: RequestEvent) => void;

/** Default ring capacity — the last 1000 events are retained for a connecting monitor. */
const DEFAULT_RING_CAPACITY = 1000;

/**
 * The non-blocking recorder: a fixed-capacity ring buffer of recent events, an
 * active-client set (call counts), and a subscriber list fanned-out on each
 * record. {@link record} never throws into the request path (a throwing
 * subscriber is dropped, not propagated).
 */
export class RequestRecorder {
	private readonly capacity: number;
	private readonly buf: RequestEvent[];
	/** Next write index (mod `capacity`); points at the oldest slot once full. */
	private head = 0;
	/** Number of filled slots (`<= capacity`); distinguishes the not-yet-wrapped state. */
	private len = 0;
	private readonly clients = new Map<string, ClientStat>();
	private readonly subs = new Set<RequestSubscriber>();

	constructor(capacity: number = DEFAULT_RING_CAPACITY) {
		// Guard against a nonsensical capacity (0/negative/NaN) — at least one slot.
		this.capacity = Math.max(1, Math.floor(capacity));
		this.buf = new Array(this.capacity);
	}

	/**
	 * Record an event: push to the ring (evicting the oldest when full), bump the
	 * active-client stat, then fan to subscribers. Never throws — a throwing
	 * subscriber is dropped (see {@link RequestRecorder.fan}) so it can't poison
	 * the recorder or the request path.
	 */
	record(event: RequestEvent): void {
		this.buf[this.head] = event;
		this.head = (this.head + 1) % this.capacity;
		if (this.len < this.capacity) this.len++;
		this.bumpClient(event);
		this.fan(event);
	}

	/** The recent events in chronological order (oldest → newest), as a fresh array. */
	recent(): RequestEvent[] {
		if (this.len < this.capacity) {
			// Not yet wrapped: filled slots are `[0, len)`.
			return this.buf.slice(0, this.len);
		}
		// Wrapped: oldest is at `head`, newest at `head - 1`.
		return [...this.buf.slice(this.head), ...this.buf.slice(0, this.head)];
	}

	/** The active-client stats (call counts + last-seen), as a fresh array. */
	activeClients(): ClientStat[] {
		return [...this.clients.values()];
	}

	/**
	 * Register a live-event listener. Returns an unsubscribe function (idempotent —
	 * calling it more than once is a no-op). Does NOT replay history: the status
	 * socket dumps the recent buffer separately on connect, then subscribes.
	 */
	subscribe(fn: RequestSubscriber): () => void {
		this.subs.add(fn);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.subs.delete(fn);
		};
	}

	/** Drop every subscriber (the status socket server calls this on shutdown). */
	close(): void {
		this.subs.clear();
	}

	/** Bump (or create) the active-client stat for an event's client. */
	private bumpClient(event: RequestEvent): void {
		const existing = this.clients.get(event.client);
		if (existing) {
			existing.calls++;
			existing.lastSeen = event.ts;
		} else {
			this.clients.set(event.client, { client: event.client, calls: 1, lastSeen: event.ts });
		}
	}

	/** Fan an event to every subscriber, isolating each so one thrower is dropped. */
	private fan(event: RequestEvent): void {
		for (const sub of this.subs) {
			try {
				sub(event);
			} catch {
				// A throwing subscriber is removed so it can't poison the recorder.
				this.subs.delete(sub);
			}
		}
	}
}

/** A plain-object guard (not an array) — the JSON-RPC envelope is a single object. */
function isJsonObject(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Read the JSON-RPC method + tool name from a parsed request body (best-effort).
 * Returns `{ method: null, tool: null }` for a non-object/array/absent body. The
 * `tool` is only read on `tools/call` (`params.name`).
 */
export function parseRpc(body: unknown): { method: RpcMethod; tool: string | null } {
	if (!isJsonObject(body)) {
		return { method: null, tool: null };
	}
	const rawMethod = body.method;
	const method: RpcMethod = typeof rawMethod === "string" ? rawMethod : null;
	let tool: string | null = null;
	if (method === "tools/call" && isJsonObject(body.params)) {
		const name = body.params.name;
		if (typeof name === "string") tool = name;
	}
	return { method, tool };
}

/** Read the client identity from the `User-Agent` header; `"unknown"` when absent/not a string. */
export function readUserAgent(value: string | string[] | undefined): string {
	return typeof value === "string" ? value : "unknown";
}

/**
 * Read a byte count from a `content-length` header value: a number passes
 * through; a numeric string is parsed; a repeated header (array) takes the
 * first; anything else is `0`. `NaN`/non-numeric → `0`.
 */
export function readContentLength(value: number | string | string[] | undefined): number {
	if (typeof value === "number") {
		return Number.isFinite(value) ? Math.floor(value) : 0;
	}
	if (typeof value === "string") {
		const n = Number(value);
		return Number.isFinite(n) ? Math.floor(n) : 0;
	}
	if (Array.isArray(value) && value.length > 0) {
		return readContentLength(value[0]);
	}
	return 0;
}

/**
 * On `initialize`, the client identity is `params.clientInfo.name` (the spec's
 * "clientInfo.name only on initialize"). Returns `null` when absent so the
 * caller falls back to the User-Agent.
 */
export function readClientName(body: unknown): string | null {
	if (!isJsonObject(body)) return null;
	// MCP `initialize`: `clientInfo` lives under `params`, not the envelope top level.
	const info = isJsonObject(body.params) ? body.params.clientInfo : undefined;
	if (!isJsonObject(info)) return null;
	const name = info.name;
	return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Resolve the client identity for an event: `clientInfo.name` on `initialize`
 * (when present), otherwise the User-Agent. Statelessness means we can't retain
 * `clientInfo` across requests — it's only available on its own `initialize`.
 */
export function resolveClient(userAgent: string, method: RpcMethod, body: unknown): string {
	if (method === "initialize") {
		const name = readClientName(body);
		if (name !== null) return name;
	}
	return userAgent;
}

/**
 * Attach the recorder's `onRequest` hook to `fastify`: for each `POST /mcp` it
 * captures the start time + client + reqBytes, then a one-shot `finish` listener
 * finalizes ms/status/resBytes/method/tool and records the event. Non-`POST /mcp`
 * requests (`/health`, well-known, GET/DELETE `/mcp`) short-circuit and are not
 * recorded. The hook is `async` (the 11b load-bearing Fastify note: a sync
 * arity-2 hook that returns `void` hangs the lifecycle). Best-effort — finalize
 * reads only already-resolved values, so it cannot throw into the response path.
 */
export function attachRequestRecorder(fastify: FastifyInstance, recorder: RequestRecorder): void {
	fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
		const urlPath = request.url.split("?", 1)[0];
		if (request.method !== "POST" || urlPath !== "/mcp") return;

		const startedAt = process.hrtime.bigint();
		const ts = new Date().toISOString();
		const userAgent = readUserAgent(request.headers["user-agent"]);
		const reqBytes = readContentLength(request.headers["content-length"]);
		// Capture the socket ref + its byte counter at request start. The socket
		// detaches from `reply.raw` by `finish` (so `reply.raw.socket` reads `null`
		// then), but the captured object's `bytesWritten` keeps its final value.
		const socket = reply.raw.socket;
		const startWritten = socket?.bytesWritten ?? 0;

		// `finish` fires once the (hijacked) raw response is fully flushed; by then
		// `request.body` is parsed and the response status is set.
		reply.raw.once("finish", () => {
			const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
			const status = reply.raw.statusCode;
			// Response bytes = wire total (status line + headers + body) for *this*
			// request, differenced so a reused keep-alive socket doesn't accumulate
			// prior responses. An upper bound on the body (headers add ~150B); exact
			// for large tool outputs. Best-effort: `0` when no socket was captured.
			const resBytes = Math.max(0, (socket?.bytesWritten ?? startWritten) - startWritten);
			const { method, tool } = parseRpc(request.body);
			const client = resolveClient(userAgent, method, request.body);
			recorder.record({ ts, client, method, tool, reqBytes, resBytes, ms: Math.round(elapsedMs), status });
		});
	});
}
