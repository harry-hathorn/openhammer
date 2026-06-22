/**
 * The contract between tool modules and the MCP server.
 *
 * Tools are plain `ToolModule` objects — logic + a JSON-Schema, no MCP coupling.
 * The registry (`src/tools/index.ts`, spec 10-index) lifts each module onto an
 * `McpToolEntry` bound to `MCP_ROOT_DIR`, which the MCP server (spec 12)
 * consumes. Keeping this boundary lets tool bodies stay pure: they return a
 * `Result<ToolOk>` and never throw for expected failures; the single narrowing
 * point (the `CallTool` handler) turns an `err` into an `isError` response.
 *
 * `ToolContent` mirrors the SDK's content-block shapes but is OpenHammer-owned
 * (text + image is the whole surface across the 7 tools).
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "../tools/result.ts";

/** A content block in a successful tool result — text or a base64 image. */
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/**
 * A successful tool result. No `isError` field — failure is encoded as
 * `Result.err`, narrowed only by the `CallTool` handler.
 */
export interface ToolOk {
	content: ToolContent[];
}

/** What each tool module exports (logic + schema, no MCP coupling). */
export interface ToolModule {
	name: "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
	description: string;
	// The SDK's canonical JSON-Schema-object type (requires `type:"object"`; the
	// `[x: string]: unknown` index absorbs arbitrary extra schema keys). Reusing it
	// — rather than `Record<string, unknown>` — is the single source of truth: every
	// tool's inline literal satisfies it, and `createAllTools` lifts it onto
	// `tool.inputSchema` with no cast. See spec 10 decision note.
	inputSchema: Tool["inputSchema"];
	execute: (args: Record<string, unknown>, rootDir: string) => Promise<Result<ToolOk>>;
}

/**
 * What the MCP server consumes. The handler returns a `Result`; the `CallTool`
 * handler (spec 12) narrows it — tools never throw for expected failures.
 */
export interface McpToolEntry {
	tool: Tool; // { name, description, inputSchema }
	handler: (args?: Record<string, unknown>) => Promise<Result<ToolOk>>;
}
