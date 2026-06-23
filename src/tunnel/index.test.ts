import { afterEach, describe, expect, it } from "vitest";
import { CHANNELS, type ChannelProvider, getChannel, registerChannel, unregisterChannel } from "./index.ts";

/**
 * A live provider: zero-account quick-tunnel shape (cloudflare's). `start`
 * spawns and discovers a URL; no `resolve`. `fields: []` — nothing to prompt.
 */
const fakeLive: ChannelProvider = {
	kind: "cloudflare",
	mode: "live",
	fields: [],
	isAvailable: async () => true,
	start: async (localPort) => ({ url: `https://live-${localPort}.example.com`, stop: async () => {} }),
};

/**
 * A static provider: the operator declares a `publicUrl`; `resolve` lifts it into
 * a handle with no spawn (and no `stop`). `resolve` is `null` when the URL is
 * absent — the graceful-absent case, mirroring `start`.
 */
const fakeStatic: ChannelProvider = {
	kind: "static-url",
	mode: "static",
	fields: [{ key: "publicUrl", label: "public URL", kind: "text", required: true }],
	isAvailable: async () => true,
	resolve: (opts) => (opts.publicUrl ? { url: opts.publicUrl } : null),
};

// Restore registry state between tests — these fakes use real ChannelKinds.
afterEach(() => {
	unregisterChannel("cloudflare");
	unregisterChannel("static-url");
});

describe("getChannel", () => {
	it("pre-registers the cloudflare provider (17h wiring)", () => {
		// Must be the first test: this reads the module-load registration, before any
		// afterEach unregisters it. index.ts calls registerChannel(cloudflareProvider).
		const provider = getChannel("cloudflare");
		expect(provider).toBeDefined();
		expect(provider?.kind).toBe("cloudflare");
		expect(provider?.mode).toBe("live");
		expect(provider?.fields).toEqual([]);
	});

	it("returns undefined for an unregistered kind", () => {
		// cloudflare is now pre-registered by index.ts (17h), so use a kind no
		// provider has landed yet to exercise the absent path.
		expect(getChannel("ngrok")).toBeUndefined();
	});
});

describe("registerChannel", () => {
	it("registers and resolves a live channel by kind (start present, resolve absent)", () => {
		registerChannel(fakeLive);

		const provider = getChannel("cloudflare");
		expect(provider).toBe(fakeLive);
		expect(provider?.mode).toBe("live");
		expect("start" in (provider as ChannelProvider)).toBe(true);
		expect("resolve" in (provider as ChannelProvider)).toBe(false);
	});

	it("registers and resolves a static channel by kind (resolve present, start absent)", () => {
		registerChannel(fakeStatic);

		const provider = getChannel("static-url");
		expect(provider).toBe(fakeStatic);
		expect(provider?.mode).toBe("static");
		expect("resolve" in (provider as ChannelProvider)).toBe(true);
		expect("start" in (provider as ChannelProvider)).toBe(false);
	});

	it("exposes the provider via CHANNELS keyed by kind", () => {
		registerChannel(fakeLive);
		expect(CHANNELS.cloudflare).toBe(fakeLive);
	});

	it("overwrites a prior registration of the same kind (last wins)", () => {
		const first: ChannelProvider = { ...fakeLive, isAvailable: async () => false };
		const second: ChannelProvider = { ...fakeLive, isAvailable: async () => true };
		registerChannel(first);
		registerChannel(second);

		expect(getChannel("cloudflare")).toBe(second);
	});

	it("forwards isAvailable/start/resolve to the registered provider", async () => {
		registerChannel(fakeLive);
		registerChannel(fakeStatic);

		const live = getChannel("cloudflare");
		const handle = await live?.start?.(4242, {});
		expect(handle?.url).toBe("https://live-4242.example.com");
		expect(typeof handle?.stop).toBe("function");

		const staticProvider = getChannel("static-url");
		expect(staticProvider?.resolve?.({ publicUrl: "https://deployed.example.com" })?.url).toBe(
			"https://deployed.example.com",
		);
		expect(staticProvider?.resolve?.({})).toBeNull();
	});
});

describe("unregisterChannel", () => {
	it("removes a registered provider", () => {
		registerChannel(fakeLive);
		expect(getChannel("cloudflare")).toBe(fakeLive);

		unregisterChannel("cloudflare");
		expect(getChannel("cloudflare")).toBeUndefined();
	});

	it("is a no-op for an unregistered kind", () => {
		expect(() => unregisterChannel("nginx")).not.toThrow();
		expect(getChannel("nginx")).toBeUndefined();
	});
});
