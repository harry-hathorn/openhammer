/**
 * The tool registry — the single place that lifts pure `ToolModule`s into the
 * MCP-consumable shape.
 *
 * Each of the 7 tool modules is a plain `{ name, description, inputSchema,
 * execute }` with no MCP coupling. `createAllTools(rootDir)` binds a rootDir
 * into each module's `execute` via the handler closure and surfaces the
 * descriptor (`{ name, description, inputSchema }`) the MCP `ListTools`/
 * `CallTool` handlers consume (spec 12). The module array order is the stable
 * `tools/list` order.
 *
 * No cast is needed to lift `inputSchema` onto `tool.inputSchema`:
 * `ToolModule.inputSchema` is already typed `Tool["inputSchema"]` (the SDK's
 * canonical JSON-Schema-object type) — single source of truth. See the decision
 * note on `ToolModule` in `src/mcp/types.ts`.
 */
import type { McpToolEntry, ToolModule } from "../mcp/types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

/** The 7 local tools, in stable `tools/list` order. */
const MODULES: ToolModule[] = [readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool];

/**
 * Build the MCP-consumable tool entries bound to `rootDir` (`MCP_ROOT_DIR`).
 * Each handler closes over `rootDir` and forwards call args (defaulting to `{}`)
 * to the module's `execute`, returning its `Result<ToolOk>` untouched — the
 * `CallTool` handler (spec 12) is the single narrowing point.
 */
export function createAllTools(rootDir: string): McpToolEntry[] {
	return MODULES.map((module) => ({
		tool: { name: module.name, description: module.description, inputSchema: module.inputSchema },
		handler: (args?: Record<string, unknown>) => module.execute(args ?? {}, rootDir),
	}));
}
