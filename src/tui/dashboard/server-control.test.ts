import { describe, expect, it } from "vitest";
import type { Config } from "../../config.ts";
import { ensureServer, type ServerChild, serverArgs } from "./server-control.ts";

/** A minimal config — only `host`/`port` feed the URL construction. */
function config(port = 3000): Config {
	return {
		port,
		host: "127.0.0.1",
		rootDir: "/tmp",
		authToken: undefined,
		maxResponseBytes: 512_000,
		logLevel: "silent",
	};
}

/**
 * A controllable fake child. `emitExit` fires the registered exit listener; a
 * `cooperative` child emits exit shortly after `kill` (so graceful `stop` reaps
 * it), a non-cooperative one ignores `kill` (exercising the SIGKILL backstop).
 * `stderrLine`, when set, is delivered to the `data` listener (early-exit capture).
 * `signals` records every signal sent, in order.
 */
class FakeChild implements ServerChild {
	pid = 4242;
	killed = false;
	cooperative = true;
	stderrLine: string | undefined;
	signals: string[] = [];
	private exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
	stderr = {
		on: (_event: string, cb: (chunk: Buffer) => void): void => {
			if (this.stderrLine !== undefined) cb(Buffer.from(this.stderrLine));
		},
	};
	once(_event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
		this.exitListeners.push(listener);
	}
	kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
		const sig = typeof signal === "number" ? String(signal) : signal;
		this.signals.push(sig);
		this.killed = true;
		if (this.cooperative) setTimeout(() => this.emitExit(null, null), 0);
		return true;
	}
	emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
		const listeners = this.exitListeners;
		this.exitListeners = [];
		for (const listener of listeners) listener(code, signal);
	}
}

/** A spawn fake over a controllable child that also records each invocation. */
function spawnOf(child: FakeChild): ((mainPath: string, args: string[]) => ServerChild) & {
	seen: Array<{ mainPath: string; args: string[] }>;
} {
	const seen: Array<{ mainPath: string; args: string[] }> = [];
	const fn = (mainPath: string, args: string[]): ServerChild => {
		seen.push({ mainPath, args });
		return child;
	};
	return Object.assign(fn, { seen });
}

describe("serverArgs", () => {
	it("forwards --tunnel", () => {
		expect(serverArgs(true, undefined)).toEqual(["--tunnel"]);
	});

	it("forwards --channel <id>", () => {
		expect(serverArgs(false, "abc")).toEqual(["--channel", "abc"]);
	});

	it("forwards both, tunnel first", () => {
		expect(serverArgs(true, "abc")).toEqual(["--tunnel", "--channel", "abc"]);
	});

	it("is empty when neither flag is set", () => {
		expect(serverArgs(false, undefined)).toEqual([]);
	});
});

describe("ensureServer", () => {
	it("attaches (no spawn) when /health is already up, and stop is a no-op", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		const result = await ensureServer(config(), {
			probeHealth: async () => true,
			spawn,
			token: "tok",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.ownsServer).toBe(false);
		expect(result.value.localUrl).toBe("http://127.0.0.1:3000/mcp");
		expect(result.value.token).toBe("tok");
		expect(spawn.seen).toEqual([]); // never spawned
		const stopResult = await result.value.stop();
		expect(stopResult.ok).toBe(true);
		expect(child.killed).toBe(false); // attached → stop does not touch a child
	});

	it("spawns a child when /health is down, waits for ready, and owns it", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		// First probe (attach check) → down; subsequent probes (ready poll) → up.
		let calls = 0;
		const result = await ensureServer(config(4242), {
			probeHealth: async () => {
				calls += 1;
				return calls > 1;
			},
			spawn,
			exists: () => true,
			token: "tok",
			readyIntervalMs: 1,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.ownsServer).toBe(true);
		expect(result.value.localUrl).toBe("http://127.0.0.1:4242/mcp");
		expect(spawn.seen).toHaveLength(1);
		// Clean teardown: cooperative child exits on SIGTERM → no SIGKILL.
		const stopResult = await result.value.stop();
		expect(stopResult.ok).toBe(true);
		expect(child.signals).toContain("SIGTERM");
		expect(child.signals).not.toContain("SIGKILL");
	});

	it("forwards the built argv + mainPath to spawn", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		await ensureServer(config(), {
			probeHealth: async () => false,
			spawn,
			exists: () => true,
			args: ["--tunnel", "--channel", "abc"],
			mainPath: "/srv/main.js",
			readyTimeoutMs: 10,
			readyIntervalMs: 2,
		});
		expect(spawn.seen).toEqual([{ mainPath: "/srv/main.js", args: ["--tunnel", "--channel", "abc"] }]);
	});

	it("returns err + reaps the child on an early exit (e.g. EADDRINUSE)", async () => {
		const child = new FakeChild();
		child.stderrLine = "Error: listen EADDRINUSE";
		const spawn = spawnOf(child);
		const pending = ensureServer(config(), {
			probeHealth: async () => false,
			spawn,
			exists: () => true,
			readyTimeoutMs: 1000,
			readyIntervalMs: 1,
		});
		// Emit the early exit after waitForReady has registered its exit listener.
		setTimeout(() => child.emitExit(1), 0);
		const result = await pending;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("exit code 1");
		expect(result.error.message).toContain("EADDRINUSE");
		expect(child.killed).toBe(true); // reaped on the failure path
	});

	it("returns err when the server entry is missing (no spawn)", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		const result = await ensureServer(config(), {
			probeHealth: async () => false,
			spawn,
			exists: () => false,
			mainPath: "/nope/main.js",
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("server entry not found");
		expect(result.error.message).toContain("npm run build");
		expect(spawn.seen).toEqual([]);
	});

	it("returns err on a ready-timeout (child alive but never healthy) and reaps it", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		const result = await ensureServer(config(), {
			probeHealth: async () => false,
			spawn,
			exists: () => true,
			readyTimeoutMs: 40,
			readyIntervalMs: 5,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("did not become ready within 40ms");
		expect(child.killed).toBe(true); // reaped on the failure path
	});

	it("stop is idempotent", async () => {
		const child = new FakeChild();
		const spawn = spawnOf(child);
		const result = await ensureServer(config(), {
			probeHealth: async () => true, // attach → owning control with a trivial no-op stop
			spawn,
		});
		if (!result.ok) return;
		const first = await result.value.stop();
		const second = await result.value.stop();
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
	});

	it("stop SIGKILLs a stubborn child that ignores SIGTERM", async () => {
		const child = new FakeChild();
		child.cooperative = false; // ignores kill — never emits exit
		const spawn = spawnOf(child);
		let probeCalls = 0;
		const result = await ensureServer(config(), {
			probeHealth: async () => {
				probeCalls += 1;
				return probeCalls > 1; // attach-down, then ready-up
			},
			spawn,
			exists: () => true,
			token: "tok",
			readyIntervalMs: 1,
			stopGraceMs: 5,
		});
		if (!result.ok) return;
		expect(result.value.ownsServer).toBe(true);
		const stopResult = await result.value.stop();
		expect(stopResult.ok).toBe(true);
		expect(child.signals).toContain("SIGTERM");
		expect(child.signals).toContain("SIGKILL"); // backstop after the grace period
	});
});
