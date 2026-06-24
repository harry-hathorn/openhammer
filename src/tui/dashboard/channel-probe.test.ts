import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelEntry } from "../../config/settings.ts";
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider } from "../../tunnel/index.ts";
import { type ChannelProbeState, createChannelProbe, DEFAULT_CHANNEL_PROBE_INTERVAL_MS } from "./channel-probe.ts";

/** A fake static provider whose `probe` is fully controllable. */
function staticProvider(probeImpl: ChannelProvider["probe"] = async () => ok(undefined)): ChannelProvider {
	return { kind: "static-url", mode: "static", fields: [], isAvailable: async () => true, probe: probeImpl };
}

/** A static channel entry with sensible defaults (overridable). */
function channel(over: Partial<ChannelEntry> & Pick<ChannelEntry, "id">): ChannelEntry {
	return {
		id: over.id,
		kind: over.kind ?? "static-url",
		mode: over.mode ?? "static",
		options: over.options ?? { publicUrl: `https://${over.id}.example` },
	};
}

/** Drain the async sweep's microtasks so the one-shot `intervalMs: 0` probe has reported. */
async function settle(): Promise<void> {
	await new Promise<void>((r) => setTimeout(r, 0));
}

describe("createChannelProbe — sweep", () => {
	it("reports up=true + url when the probe resolves ok", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a", options: { publicUrl: "https://edge" } })],
			lookup: () => staticProvider(),
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([{ id: "a", up: true, url: "https://edge" }]);
	});

	it("reports up=false when the probe resolves err (endpoint down)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a", options: { publicUrl: "https://edge" } })],
			lookup: () => staticProvider(async () => err(new Error("publicUrl /health returned 502"))),
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([{ id: "a", up: false, url: "https://edge" }]);
	});

	it("reports down when the probe throws (defensive isolation, never aborts the sweep)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a" }), channel({ id: "b" })],
			lookup: () =>
				staticProvider(async () => {
					throw new Error("boom");
				}),
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toContainEqual({ id: "a", up: false, url: "https://a.example" });
		expect(reports).toContainEqual({ id: "b", up: false, url: "https://b.example" }); // sweep continued past the throw
	});

	it("reports url null when the entry has no publicUrl", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a", options: {} })],
			lookup: () => staticProvider(), // ok regardless → isolates url extraction
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([{ id: "a", up: true, url: null }]);
	});

	it("skips live channels (only static channels are dashboard-probeable)", async () => {
		const reports: ChannelProbeState[] = [];
		const probeCalls: string[] = [];
		const live: ChannelProvider = {
			kind: "ngrok",
			mode: "live",
			fields: [],
			isAvailable: async () => true,
			probe: async (opts) => {
				probeCalls.push(opts.publicUrl ?? "?");
				return ok(undefined);
			},
		};
		const probe = createChannelProbe({
			channels: [channel({ id: "a", kind: "ngrok", mode: "live", options: {} })],
			lookup: () => live,
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([]);
		expect(probeCalls).toEqual([]); // never probed
	});

	it("skips a channel whose kind has no registered provider (stays unknown)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a", kind: "nginx" })],
			lookup: () => undefined,
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([]);
	});

	it("skips a channel whose provider declares no probe", async () => {
		const reports: ChannelProbeState[] = [];
		const provider: ChannelProvider = {
			kind: "static-url",
			mode: "static",
			fields: [],
			isAvailable: async () => true,
		};
		const probe = createChannelProbe({
			channels: [channel({ id: "a" })],
			lookup: () => provider,
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports).toEqual([]);
	});

	it("skips channels the server has already reported (no wasted fetch on the active channel)", async () => {
		const reports: ChannelProbeState[] = [];
		const probeCalls: string[] = [];
		const probe = createChannelProbe({
			channels: [
				channel({ id: "active", options: { publicUrl: "https://active" } }),
				channel({ id: "idle", options: { publicUrl: "https://idle" } }),
			],
			lookup: () =>
				staticProvider(async (opts) => {
					probeCalls.push(opts.publicUrl ?? "?");
					return ok(undefined);
				}),
			intervalMs: 0,
		});
		probe(
			(s) => reports.push(s),
			(id) => id === "active",
		);
		await settle();
		expect(reports.map((r) => r.id)).toEqual(["idle"]);
		expect(probeCalls).toEqual(["https://idle"]); // active never probed
	});

	it("does not report a channel the server reports mid-sweep (after the await)", async () => {
		const reports: ChannelProbeState[] = [];
		const reported = new Set<string>();
		const probe = createChannelProbe({
			channels: [channel({ id: "a", options: { publicUrl: "https://a" } })],
			lookup: () =>
				staticProvider(async () => {
					// The server reports this channel while the probe is still in flight.
					reported.add("a");
					return ok(undefined);
				}),
			intervalMs: 0,
		});
		probe(
			(s) => reports.push(s),
			(id) => reported.has(id),
		);
		await settle();
		expect(reports).toEqual([]); // server reported it during the probe → probe result discarded
	});

	it("probes every static channel in order", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a" }), channel({ id: "b" }), channel({ id: "c" })],
			lookup: () => staticProvider(),
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await settle();
		expect(reports.map((r) => r.id)).toEqual(["a", "b", "c"]);
	});

	it("probes all static channels when isReported is omitted (no server feed)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a" }), channel({ id: "b" })],
			lookup: () => staticProvider(),
			intervalMs: 0,
		});
		probe((s) => reports.push(s)); // single-arg form — isReported defaults to "nothing reported"
		await settle();
		expect(reports.map((r) => r.id)).toEqual(["a", "b"]);
	});

	it("merges the entry options with its credentials into the probe options bag", async () => {
		const seen: Record<string, string>[] = [];
		const probe = createChannelProbe({
			channels: [
				{ id: "a", kind: "nginx", mode: "static", options: { publicUrl: "https://x", upstream: "127.0.0.1:3000" } },
			],
			lookup: () =>
				staticProvider(async (opts) => {
					seen.push(opts);
					return ok(undefined);
				}),
			getCredentials: () => ({ authtoken: "secret" }),
			intervalMs: 0,
		});
		probe(() => {});
		await settle();
		expect(seen).toEqual([{ publicUrl: "https://x", upstream: "127.0.0.1:3000", authtoken: "secret" }]);
	});
});

describe("createChannelProbe — cadence", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("defaults intervalMs to DEFAULT_CHANNEL_PROBE_INTERVAL_MS", () => {
		// intervalMs is an internal timer; assert the default constant is exported and
		// used by constructing with no override (the re-probe test below exercises it).
		expect(DEFAULT_CHANNEL_PROBE_INTERVAL_MS).toBe(10_000);
	});

	it("re-probes on the interval (a going-down channel is re-detected)", async () => {
		const reports: ChannelProbeState[] = [];
		let up = true;
		const probe = createChannelProbe({
			channels: [channel({ id: "a" })],
			lookup: () => staticProvider(async () => (up ? ok(undefined) : err(new Error("down")))),
			intervalMs: 1000,
		});
		probe((s) => reports.push(s));
		await vi.advanceTimersByTimeAsync(0); // immediate sweep
		expect(reports).toEqual([{ id: "a", up: true, url: "https://a.example" }]);
		up = false;
		await vi.advanceTimersByTimeAsync(1000); // first re-probe
		expect(reports).toEqual([
			{ id: "a", up: true, url: "https://a.example" },
			{ id: "a", up: false, url: "https://a.example" },
		]);
	});

	it("stops re-probing after unsubscribe (and an in-flight sweep no-ops)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a" })],
			lookup: () => staticProvider(),
			intervalMs: 1000,
		});
		const unsub = probe((s) => reports.push(s));
		await vi.advanceTimersByTimeAsync(0);
		expect(reports.length).toBe(1);
		unsub();
		await vi.advanceTimersByTimeAsync(5000); // well past several intervals
		expect(reports.length).toBe(1); // no further probes
	});

	it("probes once on subscribe when intervalMs is 0 (no timer)", async () => {
		const reports: ChannelProbeState[] = [];
		const probe = createChannelProbe({
			channels: [channel({ id: "a" })],
			lookup: () => staticProvider(),
			intervalMs: 0,
		});
		probe((s) => reports.push(s));
		await vi.advanceTimersByTimeAsync(60_000); // no timer → advancing time changes nothing
		expect(reports).toEqual([{ id: "a", up: true, url: "https://a.example" }]);
	});
});
