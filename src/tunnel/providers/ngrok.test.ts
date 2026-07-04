import { describe, expect, it } from "vitest";
import { createNgrokProvider, type NgrokForwardConfig, type NgrokListener } from "./ngrok.ts";

/**
 * A deterministic stand-in for an SDK `Listener`. `urlValue` is what `url()` returns;
 * `close()` flips `closed` (and never throws), mirroring the real listener's teardown.
 * No `vi.mock`, no live network, no real napi binary — the fake is the entire seam.
 */
function fakeListener(urlValue: string | null): NgrokListener & { closed: boolean } {
	const self: NgrokListener & { closed: boolean } = {
		url: () => urlValue,
		close: async () => {
			self.closed = true;
		},
		closed: false,
	};
	return self;
}

/** A `forward` fake that records the config it was called with and returns a listener. */
function fakeForward(
	listener: NgrokListener,
	capture?: { config?: NgrokForwardConfig },
): (config: NgrokForwardConfig) => Promise<NgrokListener> {
	return async (config) => {
		if (capture) capture.config = config;
		return listener;
	};
}

const AUTH = { authtoken: "tok-123" };

describe("ngrokProvider — shape & availability", () => {
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

	it("isAvailable tracks the authtoken, not a binary", async () => {
		const provider = createNgrokProvider();
		await expect(provider.isAvailable(AUTH)).resolves.toBe(true);
		await expect(provider.isAvailable({})).resolves.toBe(false);
		await expect(provider.isAvailable({ authtoken: "  " })).resolves.toBe(false);
	});
});

describe("ngrokProvider.start", () => {
	it("resolves null when there is no authtoken and never forwards", async () => {
		let calls = 0;
		const provider = createNgrokProvider({
			forward: async () => {
				calls += 1;
				return fakeListener("https://x.ngrok.app");
			},
		});
		expect(await provider.start?.(3000, {})).toBeNull();
		expect(calls).toBe(0);
	});

	it("forwards { addr, authtoken, proto:'http' } and lifts the listener URL into a handle", async () => {
		const capture = { config: undefined as NgrokForwardConfig | undefined };
		const provider = createNgrokProvider({
			forward: fakeForward(fakeListener("https://abc-def.ngrok.app"), capture),
			disconnect: async () => {},
		});
		const handle = await provider.start?.(4321, AUTH);
		expect(handle).not.toBeNull();
		expect(handle?.url).toBe("https://abc-def.ngrok.app");
		expect(typeof handle?.stop).toBe("function");
		// The SDK was driven with the port + authtoken + http proto (no CLI, no env).
		expect(capture.config).toMatchObject({ addr: 4321, authtoken: "tok-123", proto: "http" });
	});

	it("stop closes the listener and sweeps the session", async () => {
		const listener = fakeListener("https://abc-def.ngrok.app");
		let disconnects = 0;
		const provider = createNgrokProvider({
			forward: fakeForward(listener),
			disconnect: async () => {
				disconnects += 1;
			},
		});
		const handle = await provider.start?.(4321, AUTH);
		await handle?.stop?.();
		expect(listener.closed).toBe(true);
		expect(disconnects).toBe(1);
	});

	it("stop is idempotent (a second stop is a no-op)", async () => {
		const listener = fakeListener("https://abc.ngrok.app");
		let closes = 0;
		let disconnects = 0;
		const provider = createNgrokProvider({
			forward: fakeForward(listener),
			disconnect: async () => {
				disconnects += 1;
			},
		});
		// Wrap close to count calls (the fakeListener close is a fixed closure).
		const originalClose = listener.close.bind(listener);
		listener.close = async () => {
			closes += 1;
			await originalClose();
		};
		const handle = await provider.start?.(4321, AUTH);
		await handle?.stop?.();
		await expect(handle?.stop?.()).resolves.toBeUndefined();
		expect(closes).toBe(1);
		expect(disconnects).toBe(1);
	});

	it("resolves null when the agent throws (never throws)", async () => {
		const provider = createNgrokProvider({
			forward: async () => {
				throw new Error("ERR_NGROK_105");
			},
			disconnect: async () => {},
		});
		expect(await provider.start?.(3000, AUTH)).toBeNull();
	});

	it("resolves null on timeout (a hang degrades to localhost-only)", async () => {
		const provider = createNgrokProvider({
			forward: () => new Promise<NgrokListener>(() => {}),
			disconnect: async () => {},
			timeoutMs: 20,
		});
		expect(await provider.start?.(3000, AUTH)).toBeNull();
	}, 5000);

	it("resolves null and closes the listener when no URL appears", async () => {
		const listener = fakeListener(null);
		const provider = createNgrokProvider({
			forward: fakeForward(listener),
			disconnect: async () => {},
		});
		expect(await provider.start?.(3000, AUTH)).toBeNull();
		expect(listener.closed).toBe(true);
	});
});

describe("ngrokProvider.probe", () => {
	it("errs when there is no authtoken and never forwards", async () => {
		let calls = 0;
		const provider = createNgrokProvider({
			forward: async () => {
				calls += 1;
				return fakeListener("https://x.ngrok.app");
			},
			disconnect: async () => {},
			probePort: 3000,
		});
		const result = await provider.probe?.({});
		expect(result?.ok).toBe(false);
		expect(calls).toBe(0);
	});

	it("errs when no local port is configured", async () => {
		const provider = createNgrokProvider({
			forward: fakeForward(fakeListener("https://x.ngrok.app")),
			disconnect: async () => {},
		});
		const result = await provider.probe?.(AUTH);
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("local server port");
	});

	it("oks a good token and tears the listener + session down", async () => {
		const listener = fakeListener("https://probe.ngrok.app");
		let disconnects = 0;
		const provider = createNgrokProvider({
			forward: fakeForward(listener),
			disconnect: async () => {
				disconnects += 1;
			},
			probePort: 3000,
		});
		const result = await provider.probe?.(AUTH);
		expect(result?.ok).toBe(true);
		expect(listener.closed).toBe(true);
		expect(disconnects).toBe(1);
	});

	it("errs on a bad token (agent throws)", async () => {
		const provider = createNgrokProvider({
			forward: async () => {
				throw new Error("bad authtoken");
			},
			disconnect: async () => {},
			probePort: 3000,
		});
		const result = await provider.probe?.(AUTH);
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("bad authtoken");
	});

	it("errs on timeout", async () => {
		const provider = createNgrokProvider({
			forward: () => new Promise<NgrokListener>(() => {}),
			disconnect: async () => {},
			probePort: 3000,
			timeoutMs: 20,
		});
		const result = await provider.probe?.(AUTH);
		expect(result?.ok).toBe(false);
	}, 5000);
});
