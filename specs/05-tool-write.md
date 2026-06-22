# 05 — Tool: `write`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
Create or overwrite a file under `MCP_ROOT_DIR`, creating parent directories. Port of pi's `write` execute logic.

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/write.ts` — port `execute`. **Strip:** `pi-tui`, `ToolDefinition`/render, `withFileMutationQueue`, `WriteOperations` interface, highlight cache. File: `src/tools/write.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd` (spec 02)

## Tool definition (verbatim from pi)
- **name**: `write`
- **description**: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to the file to write (relative or absolute)" },
    "content": { "type": "string", "description": "Content to write to the file" }
  },
  "required": ["path", "content"]
}
```

## Behavior (port faithfully)
1. `absolutePath = resolveToCwd(path, rootDir)`; `dir = path.dirname(absolutePath)`.
2. `fsPromises.mkdir(dir, { recursive: true })` (creates parents; no-op if exists).
3. `fsPromises.writeFile(absolutePath, content, "utf-8")`.
4. Return `{ content: [{ type: "text", text: "Successfully wrote ${content.length} bytes to ${path}" }] }`.
5. Throw on failure (e.g. permission) → `isError` at MCP layer.

## Acceptance criteria
- `write {path:"sub/dir/new.txt", content:"hi"}` creates `sub/dir/` and writes the file; returns `Successfully wrote 2 bytes to sub/dir/new.txt`.
- `write` to an existing path overwrites it.
- Round-trip: `write` then `read` returns the same content.
- Relative path resolves under `MCP_ROOT_DIR`; absolute path passes through.

## Decisions & deviations
- **No `withFileMutationQueue`** in v1 (pi's per-file serialization). `fs.writeFile` is already atomic for full overwrites; concurrent same-file writes are a low-risk edge case. Note for later if needed.

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/write.ts` (`resolveToCwd` → mkdir recursive → writeFile) with unit tests (incl. parent-dir creation + overwrite round-trip)
