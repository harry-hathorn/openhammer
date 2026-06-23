import { type ChildProcess, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createNgrokProvider, extractNgrokUrl, type NgrokSpawn } from "./ngrok.ts";

/** Live subprocesses spawned by the fake `ngrok` CLI, killed after each test. */
const spawned: ChildProcess[] = [];

afterEach(() => {
	for (const child of spawned) {
		if (!child.killed) child.kill();
	}
	spawned.length = 0;
});

/**
 * A deterministic stand-in for the `ngrok` CLI: runs a `node -e` script (so the real
 * `node:child_process` spawn / `.kill()` / `exitCode` plumbing is exercised hermetically
 * — no `vi.mock`, no live network, no real ngrok binary), returning the real
 * `ChildProcess`. `capture`, when given, records the args `start`/`probe` built and the
 * `NGROK_AUTHTOKEN` env it passed. The public URL does NOT come from this subprocess —
 * ngrok's URL is the inspector API, which the fake `fetch` answers (see {@link fakeFetch}).
 */
function fakeNgrok(script: string, capture?: { args?: string[]; env?: Record<string, string> }): NgrokSpawn {
	return (args, env) => {
		if (capture?.args) capture.args.push(...args);
		if (capture?.env) Object.assign(capture.env, env);
		const child = spawn("node", ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		spawned.push(child);
		return child;
	};
}

/** Flatten a fetch input to its URL string (no `as` — handles string | URL | Request). */
function urlOf(input: string | URL | Request): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

/**
 * A fake `fetch` that answers the inspector poll (`:4040`) and the `/health` probe.
 * `inspectorJson` is returned for the inspector URL (default: one known https tunnel);
 * `inspectorStatus`/`inspectorThrow` shape the poll (empty tunnels / refused ⇒ the
 * tunnel is not up yet); `healthStatus`/`healthThrow` shape the probe's `/health` call.
 */
function fakeFetch(
	opts: {
		inspectorJson?: unknown;
		inspectorStatus?: number;
		inspectorThrow?: Error;
		healthStatus?: number;
		healthThrow?: Error;
	} = {},
): typeof fetch {
	const inspectorJson = opts.inspectorJson ?? { tunnels: [{ public_url: "https://abc-def.ngrok.app" }] };
	const inspectorStatus = opts.inspectorStatus ?? 200;
	const healthStatus = opts.healthStatus ?? 200;
	return async (input: string | URL | Request): Promise<Response> => {
		const url = urlOf(input);
		if (url.includes("127.0.0.1:4040")) {
			if (opts.inspectorThrow) throw opts.inspectorThrow;
			return new Response(JSON.stringify(inspectorJson), {
				status: inspectorStatus,
				headers: { "content-type": "application/json" },
			});
		}
		if (url.includes("/health")) {
			if (opts.healthThrow) throw opts.healthThrow;
			return new Response("ok", { status: healthStatus });
		}
		return new Response("", { status: 404 });
	};
}

describe("extractNgrokUrl", () => {
	it("returns the public_url from the first tunnel", () => {
		expect(extractNgrokUrl({ tunnels: [{ public_url: "https://abc.ngrok.app" }] })).toBe("https://abc.ngrok.app");
	});

	it("prefers an https url when an http variant is also present", () => {
		const data = { tunnels: [{ public_url: "http://abc.ngrok.app" }, { public_url: "https://abc.ngrok.app" }] };
		expect(extractNgrokUrl(data)).toBe("https://abc.ngrok.app");
	});

	it("falls back to the first url when none is https", () => {
		expect(extractNgrokUrl({ tunnels: [{ public_url: "http://abc.ngrok.app" }] })).toBe("http://abc.ngrok.app");
	});

	it("returns null while no tunnel is provisioned yet (empty tunnels)", () => {
		expect(extractNgrokUrl({ tunnels: [] })).toBeNull();
	});

	it("returns null when the body is not the expected shape", () => {
		expect(extractNgrokUrl({ uri: "/api/tunnels" })).toBeNull();
		expect(extractNgrokUrl("not an object")).toBeNull();
		expect(extractNgrokUrl(null)).toBeNull();
	});
});

describe("ngrokProvider — shape & presence", () => {
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

	it("isAvailable reports the injected presence check (binary presence)", async () => {
		await expect(createNgrokProvider({ isAvailable: () => true }).isAvailable({})).resolves.toBe(true);
		await expect(createNgrokProvider({ isAvailable: () => false }).isAvailable({})).resolves.toBe(false);
	});

	it("isAvailable defaults to isToolAvailable('ngrok') — absent on a stripped PATH", async () => {
		// Exercises the real `isToolAvailable("ngrok")` wiring: a stripped PATH cannot
		// resolve ngrok → spawnSync fails → false.
		const provider = createNgrokProvider();
		const savedPath = process.env.PATH;
		process.env.PATH = "/nonexistent";
		try {
			await expect(provider.isAvailable({})).resolves.toBe(false);
		} finally {
			process.env.PATH = savedPath;
		}
	});
});

describe("ngrokProvider.start", () => {
	it("resolves null when there is no authtoken and never spawns", async () => {
		const capture = { args: [] as string[] };
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)", capture),
		});
		expect(await provider.start?.(3000, {})).toBeNull();
		expect(capture.args).toEqual([]);
		expect(spawned).toHaveLength(0);
	});

	it("resolves null when the binary is absent (authtoken present) and never spawns", async () => {
		const capture = { args: [] as string[] };
		const provider = createNgrokProvider({
			isAvailable: () => false,
			spawn: fakeNgrok("setInterval(()=>{},1000)", capture),
		});
		expect(await provider.start?.(3000, { authtoken: "tok" })).toBeNull();
		expect(capture.args).toEqual([]);
		expect(spawned).toHaveLength(0);
	});

	it("spawns `ngrok http <port>` with the authtoken env and lifts the inspector URL into a handle", async () => {
		const capture = { args: [] as string[], env: {} as Record<string, string> };
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)", capture),
			fetch: fakeFetch(),
		});
		const handle = await provider.start?.(4321, { authtoken: "tok-123" });
		expect(handle).not.toBeNull();
		expect(handle?.url).toBe("https://abc-def.ngrok.app");
		expect(typeof handle?.stop).toBe("function");
		// The CLI was driven with the http subcommand + the port, authtoken via env (not an arg).
		expect(capture.args).toEqual(["http", "4321"]);
		expect(capture.env).toEqual({ NGROK_AUTHTOKEN: "tok-123" });
		// The spawned child is live until stop().
		expect(spawned[0]?.killed).toBe(false);
		await handle?.stop?.();
		expect(spawned[0]?.killed).toBe(true);
	});

	it("resolves null and kills the child when no URL appears in time", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch({ inspectorJson: { tunnels: [] } }),
			timeoutMs: 60,
			pollIntervalMs: 10,
		});
		expect(await provider.start?.(3000, { authtoken: "tok" })).toBeNull();
		// The timeout path killed the live child (no orphan).
		expect(spawned[0]?.killed).toBe(true);
	});

	it("resolves null when the spawned ngrok dies early (bad authtoken) without waiting for the timeout", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("process.exit(1)"),
			fetch: fakeFetch({ inspectorJson: { tunnels: [] } }),
			timeoutMs: 5000,
			pollIntervalMs: 10,
		});
		expect(await provider.start?.(3000, { authtoken: "bad" })).toBeNull();
		expect(spawned).toHaveLength(1);
	}, 15000);

	it("stop is idempotent (a second stop is a no-op)", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch(),
		});
		const handle = await provider.start?.(3000, { authtoken: "tok" });
		await handle?.stop?.();
		await expect(handle?.stop?.()).resolves.toBeUndefined();
		expect(spawned[0]?.killed).toBe(true);
	});
});

describe("ngrokProvider.probe", () => {
	it("errs when there is no authtoken and never spawns", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			probePort: 3000,
		});
		const result = await provider.probe?.({});
		expect(result?.ok).toBe(false);
		expect(spawned).toHaveLength(0);
	});

	it("errs when no local port is configured", async () => {
		const provider = createNgrokProvider({ isAvailable: () => true });
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("local server port");
	});

	it("errs when the binary is absent", async () => {
		const provider = createNgrokProvider({ isAvailable: () => false, probePort: 3000 });
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("binary");
	});

	it("connects, fetches /health, resolves ok on a 200, then kills the child", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch({ inspectorJson: { tunnels: [{ public_url: "https://probe.ngrok.app" }] } }),
			probePort: 3000,
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(true);
		// The probe tears its child down win or lose.
		expect(spawned[0]?.killed).toBe(true);
	});

	it("errs when no URL appears in time (and kills the child)", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch({ inspectorJson: { tunnels: [] } }),
			probePort: 3000,
			timeoutMs: 60,
			pollIntervalMs: 10,
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("did not produce a URL");
		expect(spawned[0]?.killed).toBe(true);
	});

	it("errs on a non-ok /health (and kills the child)", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch({
				inspectorJson: { tunnels: [{ public_url: "https://probe.ngrok.app" }] },
				healthStatus: 502,
			}),
			probePort: 3000,
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("/health returned 502");
		expect(spawned[0]?.killed).toBe(true);
	});

	it("errs when /health fetch throws (and kills the child)", async () => {
		const provider = createNgrokProvider({
			isAvailable: () => true,
			spawn: fakeNgrok("setInterval(()=>{},1000)"),
			fetch: fakeFetch({
				inspectorJson: { tunnels: [{ public_url: "https://probe.ngrok.app" }] },
				healthThrow: new Error("network down"),
			}),
			probePort: 3000,
		});
		const result = await provider.probe?.({ authtoken: "tok" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("network down");
		expect(spawned[0]?.killed).toBe(true);
	});
});
