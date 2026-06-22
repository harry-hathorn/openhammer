/**
 * Tier-1 walking skeleton (specs 15 + 16). Proves the hermetic E2E harness is
 * wired end-to-end — vitest's `test/e2e-hermetic/**` include, a real SDK
 * `Client` driving the standalone fixture (`test/fixtures/minimal-mcp-server.ts`)
 * over loopback HTTP on an ephemeral port — against a deterministic, src-
 * independent target. A green canary means "the test infra works", isolating
 * that from "the production server works" (T-mcp-e2e's job with the real
 * `buildFastify`).
 *
 * Covers the four behaviours the canary exists to exercise: initialize (connect)
 * + `tools/list` sees the `echo` tool; `tools/call` echoes the message; a missing
 * OR wrong bearer is rejected with 401; and the universal size backstop fires on
 * an oversized echo. T-compose's runner reuses the same fixture + client logic
 * across the Docker network — only the URL differs.
 */
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import { buildFixtureServer } from "../fixtures/minimal-mcp-server.ts";

const TOKEN = "fixture-canary-bearer-token";

/** Listen the fixture on an ephemeral port; close the app after `fn` runs. */
async function withServer<T>(
	options: { maxResponseBytes?: number } = {},
	fn: (ctx: { app: FastifyInstance; baseUrl: string }) => Promise<T>,
): Promise<T> {
	const app = await buildFixtureServer({ token: TOKEN, ...options });
	// Real listen on an ephemeral port — the SDK client uses its own fetch, so
	// `inject` can't satisfy it; it needs a genuine HTTP endpoint.
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		return await fn({ app, baseUrl });
	} finally {
		await app.close();
	}
}

/** Connect a bearer-carrying SDK client; the caller closes it. */
async function connectClient(baseUrl: string): Promise<Client> {
	const client = new Client({ name: "canary-client", version: "0.0.0" }, { capabilities: {} });
	// The bearer rides on every request via `requestInit` headers — no
	// `authProvider`, so the SDK never tries the OAuth discovery flow.
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
	});
	await client.connect(transport);
	return client;
}

/**
 * Pull the first content block's text out of a `callTool` result. The SDK types
 * `callTool`'s return as a union; narrow on `"content" in result`, then on the
 * `text` discriminant — no `as` casts (the guards carry the narrowing).
 */
function firstText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
	const { content } = result;
	if (!Array.isArray(content)) return undefined;
	const block = content[0];
	if (
		block !== null &&
		typeof block === "object" &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	) {
		return block.text;
	}
	return undefined;
}

describe("Tier-1 canary: SDK client ↔ fixture server", () => {
	it("initializes (connect) and lists the echo tool", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const client = await connectClient(baseUrl);
			try {
				const { tools } = await client.listTools();
				expect(tools.map((t) => t.name)).toEqual(["echo"]);
			} finally {
				await client.close().catch(() => {});
			}
		});
	});

	it("echoes the provided message over tools/call", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const client = await connectClient(baseUrl);
			try {
				const result = await client.callTool({ name: "echo", arguments: { message: "hello canary" } });
				expect(result.isError).toBeFalsy();
				expect(firstText(result)).toBe("hello canary");
			} finally {
				await client.close().catch(() => {});
			}
		});
	});

	it("rejects tools/call with no bearer (401)", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "x" } },
				}),
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm="openhammer"/);
		});
	});

	it("rejects tools/call with a wrong bearer (401)", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer definitely-wrong" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "echo", arguments: { message: "x" } },
				}),
			});
			expect(res.status).toBe(401);
		});
	});

	it("fires the response_too_large backstop on an oversized echo", async () => {
		// An 8-byte cap makes any non-trivial echo trigger the backstop; the
		// 1000-byte message is well over it.
		await withServer({ maxResponseBytes: 8 }, async ({ baseUrl }) => {
			const client = await connectClient(baseUrl);
			try {
				const result = await client.callTool({ name: "echo", arguments: { message: "x".repeat(1000) } });
				// The backstop is a structured success-payload (not isError) per spec.
				expect(result.isError).toBeFalsy();
				const parsed = JSON.parse(firstText(result) ?? "null") as Record<string, unknown>;
				expect(parsed).toMatchObject({ ok: false, error: "response_too_large", cap: 8 });
				expect(typeof parsed.bytes).toBe("number");
			} finally {
				await client.close().catch(() => {});
			}
		});
	});
});
