import { describe, expect, it } from "vitest";
import { createNgrokProvider, type NgrokProviderDeps } from "./ngrok.ts";

/**
 * A recording listener stand-in (mirrors the SDK `Listener`'s `url()`/`close()`
 * slice the provider touches). `closeCount` exposes how many times `close()` ran
 * so the idempotent-`stop` and probe-teardown assertions read it directly.
 */
function fakeListener(urlValue: string | null) {
	let closeCount = 0;
	return {
		url: () => urlValue,
		close: async () => {
			closeCount += 1;
		},
		closeCount: () => closeCount,
	};
}

/**
 * A recording ngrok-module stand-in. `authtoken`/`connect` record their args;
 * `connect` resolves the shared {@link fakeListener} (or rejects) so start/probe
 * exercise the real `await`/`url()`/`close()` plumbing hermetically — no native
 * binding, no network. Structurally satisfies the provider's `NgrokModule`.
 */
function fakeModule(setup: { url?: string | null; rejectConnect?: Error } = {}) {
	const authtokenCalls: string[] = [];
	const connectCalls: Array<{ addr: number | string }> = [];
	const listener = fakeListener(setup.url === undefined ? "https://abc-def.ngrok.app" : setup.url);
	return {
		authtokenCalls,
		connectCalls,
		listener,
		module: {
			authtoken: async (token: string) => {
				authtokenCalls.push(token);
			},
			connect: async (config: { addr: number | string }) => {
				connectCalls.push(config);
				if (setup.rejectConnect) throw setup.rejectConnect;
				return listener;
			},
		},
	};
}

/** Build a provider whose lazy SDK load resolves `mod` (and tracks whether it ran). */
function providerWith(mod: ReturnType<typeof fakeModule>, extra: Omit<NgrokProviderDeps, "loadModule"> = {}) {
	let loaded = false;
	const provider = createNgrokProvider({
		loadModule: async () => {
			loaded = true;
			return mod.module;
		},
		...extra,
	});
	return { provider, wasLoaded: () => loaded };
}

describe("ngrokProvider", () => {
	it("is a live channel kind with the authtoken field and no resolve", () => {
		const provider = createNgrokProvider();
		expect(provider.kind).toBe("ngrok");
		expect(provider.mode).toBe("live");
		expect(provider.fields).toEqual([
			{ key: "authtoken", label: "ngrok authtoken", kind: "secret", required: true, help: "dashboard.ngrok.com" },
		]);
		expect("start" in provider).toBe(true);
		expect("resolve" in provider).toBe(false);
	});

	it("isAvailable reports presence of a non-empty authtoken", async () => {
		const provider = createNgrokProvider();
		await expect(provider.isAvailable({ authtoken: "tok-123" })).resolves.toBe(true);
		await expect(provider.isAvailable({})).resolves.toBe(false);
		await expect(provider.isAvailable({ authtoken: "" })).resolves.toBe(false);
		await expect(provider.isAvailable({ authtoken: "   " })).resolves.toBe(false);
	});

	it("start resolves null when there is no authtoken and never loads the SDK", async () => {
		const { provider, wasLoaded } = providerWith(fakeModule());
		expect(await provider.start?.(3000, {})).toBeNull();
		expect(wasLoaded()).toBe(false);
	});

	it("start sets the authtoken, connects to the local port, and lifts the URL into a handle", async () => {
		const mod = fakeModule({ url: "https://my-tunnel.ngrok.app" });
		const { provider } = providerWith(mod);

		const handle = await provider.start?.(4321, { authtoken: "tok-123" });

		expect(handle).not.toBeNull();
		expect(handle?.url).toBe("https://my-tunnel.ngrok.app");
		expect(typeof handle?.stop).toBe("function");
		expect(mod.authtokenCalls).toEqual(["tok-123"]);
		expect(mod.connectCalls).toEqual([{ addr: 4321 }]);
	});

	it("start resolves null (never throws) when connect rejects — bad authtoken", async () => {
		const mod = fakeModule({ rejectConnect: new Error("invalid authtoken") });
		const { provider } = providerWith(mod);
		expect(await provider.start?.(3000, { authtoken: "bad" })).toBeNull();
	});

	it("start resolves null when the listener returns no URL (and closes the listener)", async () => {
		const mod = fakeModule({ url: null });
		const { provider } = providerWith(mod);
		expect(await provider.start?.(3000, { authtoken: "tok" })).toBeNull();
		expect(mod.listener.closeCount()).toBe(1);
	});

	it("stop closes the listener", async () => {
		const mod = fakeModule();
		const { provider } = providerWith(mod);
		const handle = await provider.start?.(3000, { authtoken: "tok" });
		expect(handle).not.toBeNull();
		expect(mod.listener.closeCount()).toBe(0);

		await handle?.stop?.();
		expect(mod.listener.closeCount()).toBe(1);
	});

	it("stop is idempotent (a second stop is a no-op)", async () => {
		const mod = fakeModule();
		const { provider } = providerWith(mod);
		const handle = await provider.start?.(3000, { authtoken: "tok" });

		await handle?.stop?.();
		await expect(handle?.stop?.()).resolves.toBeUndefined();
		expect(mod.listener.closeCount()).toBe(1);
	});

	it("probe errs when there is no authtoken (and never loads the SDK)", async () => {
		const { provider, wasLoaded } = providerWith(fakeModule(), { probePort: 3000 });
		const result = await provider.probe?.({});
		expect(result?.ok).toBe(false);
		expect(wasLoaded()).toBe(false);
	});

	it("probe errs when no local port is configured", async () => {
		const { provider } = providerWith(fakeModule());
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("local server port");
	});

	it("probe connects, fetches /health, and resolves ok on a 200 (then closes the listener)", async () => {
		const mod = fakeModule({ url: "https://probe.ngrok.app" });
		const { provider } = providerWith(mod, {
			probePort: 3000,
			fetch: async () => new Response("ok", { status: 200 }),
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(true);
		expect(mod.connectCalls).toEqual([{ addr: 3000 }]);
		// The probe tears its listener down win or lose.
		expect(mod.listener.closeCount()).toBe(1);
	});

	it("probe errs when connect rejects (bad authtoken) but still closes the listener", async () => {
		const mod = fakeModule({ rejectConnect: new Error("invalid authtoken") });
		const { provider } = providerWith(mod, {
			probePort: 3000,
			fetch: async () => new Response("ok", { status: 200 }),
		});
		const result = await provider.probe?.({ authtoken: "bad" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("failed to connect");
		// connect rejected before a listener existed → nothing to close.
		expect(mod.listener.closeCount()).toBe(0);
	});

	it("probe errs on a non-ok /health (and closes the listener)", async () => {
		const mod = fakeModule({ url: "https://probe.ngrok.app" });
		const { provider } = providerWith(mod, {
			probePort: 3000,
			fetch: async () => new Response("bad gateway", { status: 502 }),
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("/health returned 502");
		expect(mod.listener.closeCount()).toBe(1);
	});

	it("probe errs when /health fetch throws (and closes the listener)", async () => {
		const mod = fakeModule({ url: "https://probe.ngrok.app" });
		const { provider } = providerWith(mod, {
			probePort: 3000,
			fetch: async () => {
				throw new Error("network down");
			},
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("network down");
		expect(mod.listener.closeCount()).toBe(1);
	});
});
