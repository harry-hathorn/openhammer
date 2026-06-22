# 10 — Tool Registry & McpToolEntry Type

## Purpose
Define the contract between tools and the MCP server (`McpToolEntry`), and the registry that builds all 7 tool entries bound to `MCP_ROOT_DIR`. This is the glue spec 12 consumes.

## Source references
- Entry-shape pattern: `/home/haz/source/redacted/the-reference/src/mcp-server/types.ts` (`McpToolDefinition { tool, handler }`) — adapted (we drop `permission`; `handler` returns a `Result`).
- Tool factory shape: `/home/haz/source/pi/packages/coding-agent/src/core/tools/index.ts` (`createAllTools`).
- Files: `src/mcp/types.ts`, `src/tools/index.ts`.

## Depends on
- `src/tools/result.ts` (spec 02a) — `Result`/`ok`/`err`.
- All 7 tool modules (specs 03–09).

## `src/mcp/types.ts`
```ts
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { Result } from "../tools/result.ts";

export type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/** A successful tool result. No `isError` — failure is encoded as `Result.err`. */
export interface ToolOk {
  content: ToolContent[];
}

/** What each tool module exports (logic + schema, no MCP coupling). */
export interface ToolModule {
  name: "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";
  description: string;
  inputSchema: Record<string, unknown>; // plain JSON-Schema object
  execute: (args: Record<string, unknown>, rootDir: string) => Promise<Result<ToolOk>>;
}

/** What the MCP server consumes. The handler returns a Result; the CallTool
 *  handler (spec 12) narrows it — tools never throw for expected failures. */
export interface McpToolEntry {
  tool: Tool; // { name, description, inputSchema }
  handler: (args?: Record<string, unknown>) => Promise<Result<ToolOk>>;
}
```
> Note: each tool module (specs 03–09) exports a `ToolModule`. Its `execute(args, rootDir)` returns `Promise<Result<ToolOk>>` — `ok({ content })` on success, `err(new Error(msg))` on expected failure (**never throws**). See `docs/coding-standards.md` § Error model.

## `src/tools/index.ts`
```ts
import { readTool } from "./read.ts";
import { bashTool } from "./bash.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { grepTool } from "./grep.ts";
import { findTool } from "./find.ts";
import { lsTool } from "./ls.ts";
import type { McpToolEntry, ToolModule } from "../mcp/types.ts";

const MODULES: ToolModule[] = [readTool, bashTool, editTool, writeTool, grepTool, findTool, lsTool];

export function createAllTools(rootDir: string): McpToolEntry[] {
  return MODULES.map((m) => ({
    tool: { name: m.name, description: m.description, inputSchema: m.inputSchema },
    handler: (args) => m.execute(args ?? {}, rootDir),
  }));
}
```

## Acceptance criteria
- `createAllTools("/srv")` returns exactly 7 entries whose `tool.name`s are `read, bash, edit, write, grep, find, ls`.
- Each entry's `tool.inputSchema` is a plain JSON-Schema object matching its spec.
- Calling `entries[i].handler({ ... })` invokes the tool bound to `/srv` and returns a `Result<ToolOk>` (`{ ok:true, value }` or `{ ok:false, error }`).

## Decisions & deviations
- **Result error model** — `execute` returns `Promise<Result<ToolOk, Error>>`; expected failures are `err(new Error(msg))`, never thrown. The MCP `CallTool` handler narrows (spec 12). This is a deliberate deviation from pi's throw-style. See `docs/coding-standards.md`.
- **No separate `schema.ts`** — schemas live inline in each tool module (faithful to pi); `index.ts` lifts them onto `tool.inputSchema`.
- Tool modules are plain objects (`ToolModule`), not pi's `ToolDefinition`/`AgentTool` wrappers — we strip the TUI/agent coupling entirely.

## Suggested plan items (atomic checkboxes)
- [ ] Author `src/mcp/types.ts` (`ToolContent`, `ToolOk`, `ToolModule` w/ `Result<ToolOk>` execute, `McpToolEntry`). *deps: 02a (result.ts).*
- [ ] Author `src/tools/index.ts` (`createAllTools`) — wires the 7 modules into entries. *deps: 10-types, 03–09.*
