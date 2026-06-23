import { describe, expect, it } from "vitest";
import { createStaticProvider, nginxProvider, staticUrlProvider } from "./static.ts";

/** A recording fetch: appends `/health` is wired right by capturing the called URL. */
function recordingFetch(status = 200) {
	const calls: string[] = [];
	return {
		calls,
		fetch: async (input: string | URL | Request): Promise<Response> => {
			calls.push(typeof input === "string" ? input : input.toString());
			return new Response("ok", { status });
		},
	};
}

/** Build a provider whose probe uses a recording fetch (and exposes the calls it recorded). */
function providerWithFetch(status = 200) {
	const { fetch, calls } = recordingFetch(status);
	const provider = createStaticProvider("static-url", { fetch });
	return { provider, calls };
}

describe("static providers (nginx / static-url)", () => {
	it("static-url is a static channel with the publicUrl field and no start", () => {
		const provider = createStaticProvider("static-url");
		expect(provider.kind).toBe("static-url");
		expect(provider.mode).toBe("static");
		expect(provider.fields).toEqual([
			{ key: "publicUrl", label: "public URL", kind: "text", required: true, help: expect.any(String) },
		]);
		expect("resolve" in provider).toBe(true);
		expect("start" in provider).toBe(false);
	});

	it("nginx is a static channel that adds an optional upstream hint", () => {
		const provider = createStaticProvider("nginx");
		expect(provider.kind).toBe("nginx");
		expect(provider.mode).toBe("static");
		expect(provider.fields).toHaveLength(2);
		expect(provider.fields[0]).toMatchObject({ key: "publicUrl", required: true });
		expect(provider.fields[1]).toMatchObject({ key: "upstream", required: false });
		expect("resolve" in provider).toBe(true);
		expect("start" in provider).toBe(false);
	});

	it("isAvailable reports presence of a non-empty publicUrl", async () => {
		const provider = createStaticProvider("static-url");
		await expect(provider.isAvailable({ publicUrl: "https://mcp.example.com" })).resolves.toBe(true);
		await expect(provider.isAvailable({})).resolves.toBe(false);
		await expect(provider.isAvailable({ publicUrl: "" })).resolves.toBe(false);
		await expect(provider.isAvailable({ publicUrl: "   " })).resolves.toBe(false);
	});

	it("resolve lifts the declared publicUrl into a handle with no stop", () => {
		const provider = createStaticProvider("static-url");
		const handle = provider.resolve?.({ publicUrl: "https://deployed.example.com" });
		expect(handle?.url).toBe("https://deployed.example.com");
		expect(handle?.stop).toBeUndefined();
	});

	it("resolve is null (graceful-absent) when no publicUrl is set", () => {
		const provider = createStaticProvider("nginx");
		expect(provider.resolve?.({})).toBeNull();
		expect(provider.resolve?.({ publicUrl: "" })).toBeNull();
	});

	it("probe errs when no publicUrl is set (and never fetches)", async () => {
		const { provider, calls } = providerWithFetch();
		const result = await provider.probe?.({});
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("publicUrl is required");
		expect(calls).toEqual([]);
	});

	it("probe fetches <publicUrl>/health and resolves ok on a 200", async () => {
		const { provider, calls } = providerWithFetch(200);
		const result = await provider.probe?.({ publicUrl: "https://mcp.example.com" });
		expect(result?.ok).toBe(true);
		expect(calls).toEqual(["https://mcp.example.com/health"]);
	});

	it("probe strips a trailing slash before appending /health", async () => {
		const { provider, calls } = providerWithFetch(200);
		await provider.probe?.({ publicUrl: "https://mcp.example.com/" });
		expect(calls).toEqual(["https://mcp.example.com/health"]);
	});

	it("probe errs on a non-ok /health response", async () => {
		const { provider } = providerWithFetch(502);
		const result = await provider.probe?.({ publicUrl: "https://mcp.example.com" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("/health returned 502");
	});

	it("probe errs when /health fetch throws", async () => {
		const provider = createStaticProvider("static-url", {
			fetch: async () => {
				throw new Error("network down");
			},
		});
		const result = await provider.probe?.({ publicUrl: "https://mcp.example.com" });
		expect(result?.ok).toBe(false);
		expect(result && !result.ok ? result.error.message : "").toContain("network down");
	});

	it("the production exports are the nginx and static-url kinds", () => {
		expect(nginxProvider.kind).toBe("nginx");
		expect(nginxProvider.mode).toBe("static");
		expect("resolve" in nginxProvider).toBe(true);
		expect("start" in nginxProvider).toBe(false);
		expect(staticUrlProvider.kind).toBe("static-url");
		expect(staticUrlProvider.mode).toBe("static");
		expect("resolve" in staticUrlProvider).toBe(true);
		expect("start" in staticUrlProvider).toBe(false);
	});
});
