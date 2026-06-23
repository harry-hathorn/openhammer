/**
 * Unit tests for `createMcpServer` (spec 12). Drives the real MCP `Server`
 * handlers — `ListTools`/`CallTool`, the Result narrowing, and the
 * `maxResponseBytes` backstop — through an official SDK `Client` linked to the
 * server over an in-memory transport. Hermetic: no Fastify, no network, no port.
 *
 * This is the Tier-0 unit view of the server (the full Tier-1 in-process E2E
 * over `POST /mcp` + bearer auth lands in `test/e2e-hermetic/mcp.e2e.test.ts`,
 * task T-mcp-e2e). Here we assert the four behaviours the spec pins for 12a:
 * ListTools = the 8 tools (`guide` + the 7 capability tools) in stable order; an
 * unknown tool → `isError` (no 500); a tool returning `err` → `isError` without
 * throwing; and the backstop replacing
 * oversized content with a single `response_too_large` block.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createMcpServer } from "./server.ts";

const TOOL_NAMES = ["guide", "read", "bash", "edit", "write", "grep", "find", "ls"];

/** Connect a real SDK `Client` to `server` over a linked in-memory transport. */
async function connectClient(server: ReturnType<typeof createMcpServer>): Promise<Client> {
	const client = new Client({ name: "test-client", version: "0.0.0" }, { capabilities: {} });
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return client;
}

/**
 * Run `fn` against a freshly built server+client pair (lifecycle encapsulated).
 * `rootDir` is threaded in so every tool resolves under a throwaway temp dir.
 */
async function withServer<T>(
	rootDir: string,
	maxResponseBytes: number,
	fn: (client: Client) => Promise<T>,
): Promise<T> {
	const server = createMcpServer(rootDir, maxResponseBytes);
	const client = await connectClient(server);
	try {
		return await fn(client);
	} finally {
		await client.close().catch(() => {});
		await server.close().catch(() => {});
	}
}

/**
 * Pull the first content block's text out of a `callTool` result. The SDK types
 * `callTool`'s return as a `content | toolResult` union; we never use structured
 * output, so narrow on `"content" in result`, then on the `text` discriminant —
 * no `as` casts (the guards carry the narrowing).
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

describe("createMcpServer", () => {
	let rootDir: string;

	beforeEach(() => {
		rootDir = mkdtempSync(join(tmpdir(), "openhammer-server-"));
	});
	afterEach(() => {
		rmSync(rootDir, { recursive: true, force: true });
	});

	it("ListTools returns all 8 tools in the stable registry order", async () => {
		await withServer(rootDir, 512_000, async (client) => {
			const { tools } = await client.listTools();
			expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
		});
	});

	it("an unknown tool returns isError with the message (no 500)", async () => {
		await withServer(rootDir, 512_000, async (client) => {
			const result = await client.callTool({ name: "nope", arguments: {} });
			expect(result.isError).toBe(true);
			expect(firstText(result)).toBe("Unknown tool: nope");
		});
	});

	it("a tool returning err narrows to isError without throwing", async () => {
		await withServer(rootDir, 512_000, async (client) => {
			// `read` of a path that does not exist under rootDir → the tool returns
			// `err` (Result spine), never throws. The narrowing turns it into isError.
			const result = await client.callTool({ name: "read", arguments: { path: "definitely-missing.txt" } });
			expect(result.isError).toBe(true);
			expect(typeof firstText(result)).toBe("string");
		});
	});

	it("the maxResponseBytes backstop replaces oversized content with a response_too_large block", async () => {
		// A 1-byte cap makes any non-empty tool result trigger the backstop. `write`
		// returns a "Successfully wrote N bytes to <path>" line (>> 1 byte).
		await withServer(rootDir, 1, async (client) => {
			const result = await client.callTool({
				name: "write",
				arguments: { path: "big.txt", content: "x".repeat(100) },
			});
			// The backstop is a structured success-payload (not isError) per spec.
			expect(result.isError).toBeFalsy();
			const parsed = JSON.parse(firstText(result) ?? "null") as Record<string, unknown>;
			expect(parsed).toMatchObject({ ok: false, error: "response_too_large", cap: 1 });
			expect(typeof parsed.bytes).toBe("number");
			expect(parsed.bytes as number).toBeGreaterThan(1);
		});
	});
});
