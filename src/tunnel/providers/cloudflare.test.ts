import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createCloudflareProvider } from "./cloudflare.ts";

/** Live subprocesses spawned by the fake cloudflared, killed after each test. */
const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const child of spawned) {
		if (!child.killed) child.kill();
	}
	spawned.length = 0;
});

/**
 * Deterministic stand-in for cloudflared (mirrors `cloudflare.test.ts`'s shape):
 * runs a `node -e` script so the real `node:child_process` spawn / stderr
 * streaming / `close` plumbing is exercised hermetically — no `vi.mock`, no live
 * network — returning the real `ChildProcess`.
 */
function fakeCloudflared(script: string): (args: string[]) => ChildProcess {
	return () => {
		const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		spawned.push(child);
		return child;
	};
}

describe("cloudflareProvider", () => {
	it("is a live channel kind with no fields and no resolve", () => {
		const provider = createCloudflareProvider({ isAvailable: () => false });
		expect(provider.kind).toBe("cloudflare");
		expect(provider.mode).toBe("live");
		expect(provider.fields).toEqual([]);
		expect("start" in provider).toBe(true);
		expect("resolve" in provider).toBe(false);
	});

	it("isAvailable reports presence via the injected check", async () => {
		await expect(createCloudflareProvider({ isAvailable: () => true }).isAvailable({})).resolves.toBe(true);
		await expect(createCloudflareProvider({ isAvailable: () => false }).isAvailable({})).resolves.toBe(false);
	});

	it("start resolves null when the presence check reports cloudflared absent", async () => {
		const provider = createCloudflareProvider({ isAvailable: () => false });
		expect(await provider.start?.(3000, {})).toBeNull();
	});

	it("start resolves null via the default presence check when PATH is stripped", async () => {
		// Exercises the real `isToolAvailable("cloudflared")` wiring (not the injected
		// branch): a stripped PATH cannot resolve cloudflared → startTunnel → null.
		const savedPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const provider = createCloudflareProvider();
			expect(await provider.start?.(3000, {})).toBeNull();
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("start lifts { url, child } into { url, stop } via the real startTunnel", async () => {
		const provider = createCloudflareProvider({
			isAvailable: () => true,
			spawn: fakeCloudflared('process.stderr.write("https://my-tunnel.trycloudflare.com\\n")'),
		});
		const handle = await provider.start?.(3000, {});
		expect(handle).not.toBeNull();
		expect(handle?.url).toBe("https://my-tunnel.trycloudflare.com");
		expect(typeof handle?.stop).toBe("function");
	});

	it("stop tears down the spawned cloudflared child", async () => {
		// setInterval keeps the fake alive until stop() signals it; the URL still
		// resolves startTunnel (settle-once), then stop() must kill the live child.
		const provider = createCloudflareProvider({
			isAvailable: () => true,
			spawn: fakeCloudflared(
				'process.stderr.write("https://live.trycloudflare.com\\n"); setInterval(() => {}, 60000)',
			),
		});
		const handle = await provider.start?.(4321, {});
		expect(handle).not.toBeNull();
		expect(spawned.length).toBe(1);
		expect(spawned[0]?.killed).toBe(false);

		await handle?.stop?.();

		// `spawned[0]` is the same ChildProcess the provider closed over; stop()
		// signalled it, so its `killed` flag is now set.
		expect(spawned[0]?.killed).toBe(true);
	});

	it("stop is idempotent (a second stop is a no-op)", async () => {
		const provider = createCloudflareProvider({
			isAvailable: () => true,
			spawn: fakeCloudflared(
				'process.stderr.write("https://live.trycloudflare.com\\n"); setInterval(() => {}, 60000)',
			),
		});
		const handle = await provider.start?.(3000, {});
		expect(handle).not.toBeNull();
		await handle?.stop?.();
		// A second stop must not throw (idempotent teardown).
		await expect(handle?.stop?.()).resolves.toBeUndefined();
	});
});
