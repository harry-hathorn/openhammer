import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { extractTunnelUrl, startTunnel } from "./cloudflare.ts";

/** Live subprocesses spawned by the fake cloudflared, killed after each test. */
const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const child of spawned) {
		if (!child.killed) child.kill();
	}
	spawned.length = 0;
});

/**
 * A deterministic stand-in for cloudflared: runs a `node -e` script (so the real
 * `node:child_process` spawn / stderr streaming / `close` plumbing is exercised
 * hermetically — no `vi.mock`, no live network), returning the real `ChildProcess`.
 * `captureArgs`, when given, records the args `startTunnel` built.
 */
function fakeCloudflared(script: string, captureArgs?: string[]): (args: string[]) => ChildProcess {
	return (args: string[]) => {
		if (captureArgs) captureArgs.push(...args);
		const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		spawned.push(child);
		return child;
	};
}

describe("extractTunnelUrl", () => {
	it("returns the URL when present inside a log line", () => {
		expect(extractTunnelUrl("Your quick Tunnel: https://abc-def.trycloudflare.com\n")).toBe(
			"https://abc-def.trycloudflare.com",
		);
	});

	it("returns the first URL when several appear", () => {
		const stderr = "https://one-two.trycloudflare.com https://three-four.trycloudflare.com";
		expect(extractTunnelUrl(stderr)).toBe("https://one-two.trycloudflare.com");
	});

	it("returns the base URL with no trailing path", () => {
		expect(extractTunnelUrl("live at https://aa-bb.trycloudflare.com/mcp now\n")).toBe(
			"https://aa-bb.trycloudflare.com",
		);
	});

	it("returns null when no trycloudflare URL is present", () => {
		expect(extractTunnelUrl("nothing useful here\n")).toBeNull();
	});

	it("ignores non-trycloudflare https URLs", () => {
		expect(extractTunnelUrl("see https://example.com/maybe")).toBeNull();
	});
});

describe("startTunnel", () => {
	it("returns null when the presence check reports cloudflared absent", async () => {
		const result = await startTunnel(3000, { isAvailable: () => false });
		expect(result).toBeNull();
	});

	it("returns null via the default presence check when PATH is stripped", async () => {
		// Exercises the real `isToolAvailable("cloudflared")` wiring (not the injected
		// branch): a stripped PATH cannot resolve cloudflared → spawnSync fails → false.
		const savedPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			const result = await startTunnel(3000);
			expect(result).toBeNull();
		} finally {
			process.env.PATH = savedPath;
		}
	});

	it("spawns cloudflared with the quick-tunnel args", async () => {
		const captured: string[] = [];
		const result = await startTunnel(4321, {
			isAvailable: () => true,
			spawn: fakeCloudflared('process.stderr.write("https://x-y.trycloudflare.com\\n")', captured),
		});
		expect(result).not.toBeNull();
		expect(captured).toEqual(["tunnel", "--url", "http://localhost:4321", "--no-autoupdate"]);
	});

	it("resolves { url, child } once the trycloudflare URL hits stderr", async () => {
		const result = await startTunnel(3000, {
			isAvailable: () => true,
			spawn: fakeCloudflared('process.stderr.write("https://my-tunnel.trycloudflare.com\\n")'),
		});
		expect(result).not.toBeNull();
		if (result) {
			expect(result.url).toBe("https://my-tunnel.trycloudflare.com");
			expect(result.child.pid).toBeTruthy();
		}
	});

	it("forwards pre-URL stderr chunks to onLog", async () => {
		const logged: string[] = [];
		await startTunnel(3000, {
			isAvailable: () => true,
			onLog: (msg) => {
				logged.push(msg);
			},
			spawn: fakeCloudflared(
				'process.stderr.write("starting up\\n"); process.stderr.write("https://aa-bb.trycloudflare.com\\n")',
			),
		});
		expect(logged.some((line) => line.includes("starting up"))).toBe(true);
	});

	it("resolves null and kills the child when no URL appears in time", async () => {
		const children: ChildProcess[] = [];
		const result = await startTunnel(3000, {
			isAvailable: () => true,
			timeoutMs: 100,
			spawn: () => {
				const child = spawn("node", ["-e", "setTimeout(() => {}, 30000)"], {
					stdio: ["ignore", "pipe", "pipe"],
				});
				children.push(child);
				spawned.push(child);
				return child;
			},
		});
		expect(result).toBeNull();
		// The timeout path killed the long-lived child (no orphan).
		expect(children[0]?.killed).toBe(true);
	}, 15000);

	it("resolves null when the child dies before printing a URL", async () => {
		const result = await startTunnel(3000, {
			isAvailable: () => true,
			timeoutMs: 5000,
			spawn: fakeCloudflared("process.exit(1)"),
		});
		expect(result).toBeNull();
	}, 15000);

	it("treats a close after success as a no-op (settle-once)", async () => {
		// URL is printed, then the process exits ~200ms later. The later `close` must NOT
		// override the already-resolved success with null.
		const result = await startTunnel(3000, {
			isAvailable: () => true,
			spawn: fakeCloudflared(
				'process.stderr.write("https://live.trycloudflare.com\\n"); setTimeout(() => process.exit(0), 200)',
			),
		});
		expect(result).not.toBeNull();
		expect(result?.url).toBe("https://live.trycloudflare.com");
	}, 15000);
});
