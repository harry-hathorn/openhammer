/**
 * Unit tests for boot-time channel resolution (spec 17q).
 *
 * The precedence ({@link selectChannel}) and the registry dispatch
 * ({@link resolveChannelHandle}) are exercised hermetically via the injectable
 * `getChannel`/`getCredentials` seams — a fake {@link ChannelProvider} stands in
 * for ngrok/cloudflare, so no real binary, network, or spawned process is
 * involved. The integration with `main.ts` (the actual boot) is covered by the
 * boot E2E (`test/e2e-hermetic/boot.e2e.test.ts`).
 */
import { describe, expect, it } from "vitest";

import type { ChannelEntry } from "../config/settings.ts";
import { type ResolveChannelDeps, resolveChannelHandle, selectChannel } from "./boot.ts";
import type { ChannelHandle, ChannelProvider } from "./types.ts";

/** A persisted channel entry — `id` is also the credentials-store key. */
function entry(over: Partial<ChannelEntry> = {}): ChannelEntry {
	return { id: "ch-1", kind: "static-url", mode: "static", options: {}, ...over };
}

/** A minimal fake provider — `resolve`/`start` overridden per test. */
function fakeProvider(over: Partial<ChannelProvider> = {}): ChannelProvider {
	return {
		kind: "static-url",
		mode: "static",
		fields: [],
		isAvailable: async () => true,
		resolve: () => ({ url: "https://resolved.example.test" }),
		...over,
	};
}

/** A registry that knows one kind → one provider. */
function singleKindRegistry(kind: string, provider: ChannelProvider): ResolveChannelDeps["getChannel"] {
	return (k) => (k === kind ? provider : undefined);
}

describe("selectChannel — precedence (CLI flag > env > legacy --tunnel)", () => {
	it("selects the persisted channel matching channelId (default source of --channel/defaultChannel)", () => {
		const sel = selectChannel({
			channelId: "ch-1",
			channels: [entry({ id: "ch-1", kind: "ngrok" })],
			env: {},
			wantTunnel: false,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "ngrok", options: {} } });
	});

	it("merges a channel's non-secret options with its secrets (secrets win)", () => {
		const deps: ResolveChannelDeps = { getCredentials: () => ({ authtoken: "sekret" }) };
		const sel = selectChannel(
			{
				channelId: "ch-1",
				channels: [entry({ id: "ch-1", kind: "ngrok", options: { region: "eu" } })],
				env: {},
				wantTunnel: false,
			},
			deps,
		);
		expect(sel).toEqual({
			status: "selected",
			channel: { kind: "ngrok", options: { region: "eu", authtoken: "sekret" } },
		});
	});

	it("reports not-found when channelId names no persisted entry", () => {
		const sel = selectChannel({ channelId: "ghost", channels: [entry({ id: "ch-1" })], env: {}, wantTunnel: false });
		expect(sel).toEqual({ status: "not-found", channelId: "ghost" });
	});

	it("MCP_TUNNEL_PROVIDER env selects that provider kind with the NGROK_AUTHTOKEN secret", () => {
		const sel = selectChannel({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "ngrok", NGROK_AUTHTOKEN: "tok" },
			wantTunnel: false,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "ngrok", options: { authtoken: "tok" } } });
	});

	it("MCP_TUNNEL_PROVIDER omits the authtoken option when NGROK_AUTHTOKEN is absent", () => {
		const sel = selectChannel({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "cloudflare" },
			wantTunnel: false,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "cloudflare", options: {} } });
	});

	it("MCP_TUNNEL_PROVIDER with an unknown value is unknown-provider", () => {
		const sel = selectChannel({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "bogus" },
			wantTunnel: false,
		});
		expect(sel).toEqual({ status: "unknown-provider", provider: "bogus" });
	});

	it("a whitespace-only MCP_TUNNEL_PROVIDER is treated as unset", () => {
		const sel = selectChannel({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "   " },
			wantTunnel: true,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "cloudflare", options: {} } });
	});

	it("the legacy --tunnel flag selects the cloudflare channel", () => {
		const sel = selectChannel({ channelId: null, channels: [], env: {}, wantTunnel: true });
		expect(sel).toEqual({ status: "selected", channel: { kind: "cloudflare", options: {} } });
	});

	it("returns none when nothing is selected (localhost-only default)", () => {
		const sel = selectChannel({ channelId: null, channels: [], env: {}, wantTunnel: false });
		expect(sel).toEqual({ status: "none" });
	});

	it("channelId wins over MCP_TUNNEL_PROVIDER env (flag > env)", () => {
		const sel = selectChannel({
			channelId: "ch-1",
			channels: [entry({ id: "ch-1", kind: "nginx" })],
			env: { MCP_TUNNEL_PROVIDER: "ngrok" },
			wantTunnel: false,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "nginx", options: {} } });
	});

	it("MCP_TUNNEL_PROVIDER env wins over the legacy --tunnel flag (env > legacy flag)", () => {
		const sel = selectChannel({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "ngrok" },
			wantTunnel: true,
		});
		expect(sel).toEqual({ status: "selected", channel: { kind: "ngrok", options: {} } });
	});
});

describe("resolveChannelHandle — registry dispatch + null-safety", () => {
	it("returns a null handle with no notice when nothing is selected", async () => {
		const res = await resolveChannelHandle({
			channelId: null,
			channels: [],
			env: {},
			wantTunnel: false,
			localPort: 3000,
		});
		expect(res).toEqual({ handle: null, notice: null });
	});

	it("resolves a static channel via provider.resolve", async () => {
		const provider = fakeProvider({
			kind: "static-url",
			mode: "static",
			resolve: () => ({ url: "https://deployed.example.test" }),
		});
		const res = await resolveChannelHandle(
			{
				channelId: "ch-1",
				channels: [entry({ id: "ch-1", kind: "static-url" })],
				env: {},
				wantTunnel: false,
				localPort: 3000,
			},
			{ getChannel: singleKindRegistry("static-url", provider) },
		);
		expect(res.handle).toEqual({ url: "https://deployed.example.test" });
		expect(res.notice).toBeNull();
	});

	it("starts a live channel via provider.start with the local port + options", async () => {
		let receivedPort = -1;
		let receivedOptions: Record<string, string> | null = null;
		const provider = fakeProvider({
			kind: "ngrok",
			mode: "live",
			start: async (port, options) => {
				receivedPort = port;
				receivedOptions = options;
				return { url: "https://abc.ngrok.app", stop: async () => {} };
			},
		});
		const res = await resolveChannelHandle(
			{
				channelId: "ch-1",
				channels: [entry({ id: "ch-1", kind: "ngrok", options: {} })],
				env: {},
				wantTunnel: false,
				localPort: 4242,
			},
			{ getChannel: singleKindRegistry("ngrok", provider), getCredentials: () => ({ authtoken: "tok" }) },
		);
		expect(res.handle?.url).toBe("https://abc.ngrok.app");
		expect(res.notice).toBeNull();
		expect(receivedPort).toBe(4242);
		expect(receivedOptions).toEqual({ authtoken: "tok" });
	});

	it("a live channel whose start resolves null is null + an 'unavailable' notice", async () => {
		const provider = fakeProvider({ kind: "cloudflare", mode: "live", start: async () => null });
		const res = await resolveChannelHandle(
			{ channelId: null, channels: [], env: {}, wantTunnel: true, localPort: 3000 },
			{ getChannel: singleKindRegistry("cloudflare", provider) },
		);
		expect(res.handle).toBeNull();
		expect(res.notice).toContain("cloudflare");
		expect(res.notice).toContain("continuing localhost-only");
	});

	it("a static channel whose resolve returns null is null + an 'unavailable' notice", async () => {
		const provider = fakeProvider({ kind: "nginx", mode: "static", resolve: () => null });
		const res = await resolveChannelHandle(
			{
				channelId: "ch-1",
				channels: [entry({ id: "ch-1", kind: "nginx" })],
				env: {},
				wantTunnel: false,
				localPort: 3000,
			},
			{ getChannel: singleKindRegistry("nginx", provider) },
		);
		expect(res.handle).toBeNull();
		expect(res.notice).toContain("nginx");
	});

	it("a selected kind with no registered provider is null + a 'no provider registered' notice", async () => {
		const res = await resolveChannelHandle(
			{
				channelId: "ch-1",
				channels: [entry({ id: "ch-1", kind: "static-url" })],
				env: {},
				wantTunnel: false,
				localPort: 3000,
			},
			{ getChannel: () => undefined },
		);
		expect(res.handle).toBeNull();
		expect(res.notice).toContain("no provider registered");
	});

	it("a not-found channelId is null + a 'not found' notice", async () => {
		const res = await resolveChannelHandle({
			channelId: "ghost",
			channels: [],
			env: {},
			wantTunnel: false,
			localPort: 3000,
		});
		expect(res.handle).toBeNull();
		expect(res.notice).toContain("not found");
		expect(res.notice).toContain("ghost");
	});

	it("an unknown MCP_TUNNEL_PROVIDER is null + an 'unknown tunnel provider' notice", async () => {
		const res = await resolveChannelHandle({
			channelId: null,
			channels: [],
			env: { MCP_TUNNEL_PROVIDER: "bogus" },
			wantTunnel: false,
			localPort: 3000,
		});
		expect(res.handle).toBeNull();
		expect(res.notice).toContain("unknown tunnel provider");
		expect(res.notice).toContain("bogus");
	});

	it("preserves the live channel's stop handle for shutdown teardown", async () => {
		let stopped = false;
		const provider = fakeProvider({
			kind: "ngrok",
			mode: "live",
			start: async () => ({
				url: "https://x.ngrok.app",
				stop: async () => {
					stopped = true;
				},
			}),
		});
		const res = await resolveChannelHandle(
			{ channelId: null, channels: [], env: { MCP_TUNNEL_PROVIDER: "ngrok" }, wantTunnel: false, localPort: 3000 },
			{ getChannel: singleKindRegistry("ngrok", provider) },
		);
		const handle: ChannelHandle | null = res.handle;
		expect(handle?.stop).toBeTypeOf("function");
		await handle?.stop?.();
		expect(stopped).toBe(true);
	});
});
