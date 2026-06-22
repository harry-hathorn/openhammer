/**
 * The MCP `Server` — the integration core (spec 12).
 *
 * Builds a stateless MCP `Server` over the 7 local tools (`createAllTools`,
 * spec 10): `ListTools` lifts each entry's `{ name, description, inputSchema }`,
 * and `CallTool` dispatches by name. This module is the **single narrowing point**
 * for the Result spine — a tool's `err(...)` becomes an `isError: true` text block
 * here, never inside the tool. A fallback `try/catch` catches only genuine bugs
 * (tools never throw for *expected* failures), so a bug still degrades to an
 * `isError` response instead of crashing the request with a 500.
 *
 * The universal `maxResponseBytes` backstop runs after success: it sums every
 * content block (text `Buffer.byteLength` + image `data.length`) and, when the
 * total exceeds the cap, replaces the **entire** content with one
 * `response_too_large` JSON text block — a structured error the model can act on
 * ("narrow / page the results"), never a silently truncated body. (Per-tool
 * truncation already bounds line/byte counts; this is the whole-response ceiling.)
 *
 * Copy-adapted from `the-reference/.../mcp-server/server.ts`: the the-reference
 * `JSON.stringify(result)` payload path is replaced by the Result model (tools
 * already return `ToolOk` content blocks), and the per-tool permission filtering
 * is gone — bearer auth lives in the transport `preHandler` (spec 11/12b), so the
 * server sees only authorized requests. The version comes straight from
 * `package.json` (single source).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../package.json" with { type: "json" };
import { createAllTools } from "../tools/index.ts";
import { err, type Result } from "../tools/result.ts";
import type { ToolOk } from "./types.ts";

/**
 * Build a stateless MCP `Server` over the 7 tools, each bound to `rootDir`.
 *
 * `maxResponseBytes` is the whole-response cap (the `MAX_RESPONSE_BYTES`
 * backstop); it is threaded in from `config.maxResponseBytes` (spec 12b/12c)
 * rather than read from `process.env` here so the single config boundary owns it.
 */
export function createMcpServer(rootDir: string, maxResponseBytes: number): Server {
	const entries = createAllTools(rootDir);

	const server = new Server({ name: "openhammer", version: pkg.version }, { capabilities: { tools: {} } });

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: entries.map((entry) => entry.tool),
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args } = request.params;
		const entry = entries.find((e) => e.tool.name === name);
		if (!entry) {
			return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
		}

		// Single narrowing point. Expected failures arrive as `err` (tools never
		// throw for them); the try/catch is a bug safety-net only — a genuine bug
		// still degrades to `isError` instead of crashing the request.
		let r: Result<ToolOk>;
		try {
			r = await entry.handler(args);
		} catch (e) {
			r = err(e instanceof Error ? e : new Error(String(e)));
		}
		if (!r.ok) {
			return { content: [{ type: "text", text: r.error.message }], isError: true };
		}

		// Universal size backstop: sum text + image bytes; over the cap, replace the
		// whole content with one structured `response_too_large` block (text
		// `Buffer.byteLength` for text blocks, base64 `data.length` for images — a
		// deliberately conservative count, since base64 overestimates decoded size).
		let bytes = 0;
		for (const block of r.value.content) {
			bytes += block.type === "text" ? Buffer.byteLength(block.text) : block.data.length;
		}
		if (bytes > maxResponseBytes) {
			const text = JSON.stringify({
				ok: false,
				error: "response_too_large",
				bytes,
				cap: maxResponseBytes,
				message: `The "${name}" response was ${bytes} bytes, over the ${maxResponseBytes}-byte limit. Narrow the query or page the results.`,
			});
			return { content: [{ type: "text", text }] };
		}

		return { content: r.value.content };
	});

	return server;
}
