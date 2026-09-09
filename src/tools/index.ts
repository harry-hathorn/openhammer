/**
 * The tool registry — the single place that lifts pure `ToolModule`s into the
 * MCP-consumable shape.
 *
 * Each tool module is a plain `{ name, description, inputSchema, execute }` with
 * no MCP coupling. `createAllTools(ctx)` closes the `ToolContext` (working root
 * + backend, spec 23) into each module's `execute` via the handler closure and
 * surfaces the descriptor
 * (`{ name, description, inputSchema }`) the MCP `ListTools`/`CallTool` handlers
 * consume (spec 12). The module array order is the stable `tools/list` order:
 * `guide` (orientation, "read this first") leads, then the 7 capability tools.
 *
 * No cast is needed to lift `inputSchema` onto `tool.inputSchema`:
 * `ToolModule.inputSchema` is already typed `Tool["inputSchema"]` (the SDK's
 * canonical JSON-Schema-object type) — single source of truth. See the decision
 * note on `ToolModule` in `src/mcp/types.ts`.
 */
import type { McpToolEntry, ToolContext, ToolModule } from "../mcp/types.ts";
import { bashTool } from "./bash.ts";
import { editTool } from "./edit.ts";
import { findTool } from "./find.ts";
import { grepTool } from "./grep.ts";
import { guideTool } from "./guide.ts";
import { lsTool } from "./ls.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";

/**
 * The local tools, in stable `tools/list` order: `guide` (orientation) first,
 * then the 7 capability tools.
 */
const MODULES: ToolModule[] = [guideTool, readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool];

/**
 * Build the MCP-consumable tool entries bound to `ctx` (`rootDir` + the
 * boot-scoped backend). Each handler closes over `ctx` and forwards call args
 * (defaulting to `{}`) to the module's `execute`, returning its
 * `Result<ToolOk>` untouched — the `CallTool` handler (spec 12) is the single
 * narrowing point.
 */
export function createAllTools(ctx: ToolContext): McpToolEntry[] {
	return MODULES.map((module) => ({
		tool: { name: module.name, description: module.description, inputSchema: module.inputSchema },
		handler: (args?: Record<string, unknown>) => module.execute(args ?? {}, ctx),
	}));
}
