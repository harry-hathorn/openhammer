import { describe, expect, it, vi } from "vitest";
import { credentialPath } from "./auth/token.ts";
import { formatStartup, mcpServersConfig, printStartup } from "./startup-print.ts";

describe("mcpServersConfig", () => {
	it("builds an http mcpServers entry pointing at the endpoint with the bearer header", () => {
		expect(mcpServersConfig("http://127.0.0.1:3000/mcp", "tok")).toEqual({
			mcpServers: {
				openhammer: {
					type: "http",
					url: "http://127.0.0.1:3000/mcp",
					headers: { Authorization: "Bearer tok" },
				},
			},
		});
	});

	it("stringifies to a parseable JSON block with the bearer header", () => {
		const json = JSON.stringify(mcpServersConfig("http://127.0.0.1:3000/mcp", "tok"), null, 2);
		expect(JSON.parse(json)).toEqual(mcpServersConfig("http://127.0.0.1:3000/mcp", "tok"));
		expect(json).toContain('"Authorization": "Bearer tok"');
	});
});

describe("formatStartup", () => {
	const base = { localUrl: "http://127.0.0.1:3000", token: "abc123" };

	it("emits the local /mcp endpoint, the token, and the exact mcpServers JSON block", () => {
		const out = formatStartup(base);
		expect(out).toContain("http://127.0.0.1:3000/mcp");
		expect(out).toContain("abc123");
		expect(out).toContain("Bearer abc123");
		expect(out).toContain("Hand this URL + token to your remote agent (e.g. pi, Claude Code, a cloud LLM).");
		// The pasteable block is the exact stringification of the config — therefore parseable.
		expect(out).toContain(JSON.stringify(mcpServersConfig("http://127.0.0.1:3000/mcp", "abc123"), null, 2));
	});

	it("omits the tunnel line when no tunnelUrl is given", () => {
		const out = formatStartup(base);
		expect(out).not.toContain("Tunnel URL");
		expect(out).not.toContain("trycloudflare.com");
	});

	it("includes the tunnel /mcp endpoint when a tunnelUrl is given", () => {
		const out = formatStartup({
			...base,
			tunnelUrl: "https://foo-bar.trycloudflare.com",
		});
		expect(out).toContain("https://foo-bar.trycloudflare.com/mcp");
		expect(out).toContain("Tunnel URL");
	});

	it("surfaces the credential file path and the reuse note", () => {
		const out = formatStartup(base);
		expect(out).toContain(credentialPath());
		expect(out).toContain("MCP_AUTH_TOKEN");
		expect(out).toContain("reused on restart");
	});
});

describe("printStartup", () => {
	it("writes the formatted banner to console.log exactly once", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			printStartup({ localUrl: "http://127.0.0.1:3000", token: "abc123" });
			expect(spy).toHaveBeenCalledTimes(1);
			expect(spy.mock.calls[0]?.[0]).toBe(formatStartup({ localUrl: "http://127.0.0.1:3000", token: "abc123" }));
		} finally {
			spy.mockRestore();
		}
	});
});
