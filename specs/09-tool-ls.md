# 09 — Tool: `ls`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
List directory contents under `MCP_ROOT_DIR` — alphabetical, `/` suffix on directories, dotfiles included. Port of pi's `ls`. No external binary required (uses `node:fs`).

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/ls.ts` — port `execute`. **Strip:** `pi-tui`, render, `LsOperations` interface. File: `src/tools/ls.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd`; `src/tools/truncate.ts` → `truncateHead`, `DEFAULT_MAX_BYTES`, `formatSize` (spec 02)

## Tool definition (verbatim from pi)
- **name**: `ls`
- **description**: `List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Directory to list (default: current directory)" },
    "limit": { "type": "number", "description": "Maximum number of entries to return (default: 500)" }
  }
}
```

## Behavior (port faithfully)
1. `dirPath = resolveToCwd(path || ".", rootDir)`; `effectiveLimit = limit ?? 500`.
2. `fs.existsSync(dirPath)` false → throw `Path not found: ${dirPath}`.
3. `fs.statSync(dirPath).isDirectory()` false → throw `Not a directory: ${dirPath}`.
4. `fs.readdirSync(dirPath)`, then `entries.sort((a,b) => a.toLowerCase().localeCompare(b.toLowerCase()))` (case-insensitive alphabetical).
5. For each entry up to `effectiveLimit`: `stat = fs.statSync(path.join(dirPath, entry))`; if it `isDirectory()` append `/`; skip entries that fail to stat. (`entryLimitReached` when hitting the cap.)
6. Empty result → return text `(empty directory)`.
7. Otherwise `truncateHead(joined, { maxLines: MAX_SAFE_INTEGER })` (byte cap only); append notices: `${effectiveLimit} entries limit reached. Use limit=${effectiveLimit*2} for more` · `${formatSize(DEFAULT_MAX_BYTES)} limit reached`.
8. Return `{ content: [{ type: "text", text: output }] }`.

## Acceptance criteria
- `ls {path:"."}` lists entries alphabetically with `/` on directories; dotfiles appear.
- `ls` on an empty dir → `(empty directory)`.
- `ls {path:"<file>"}` → `isError:true` `Not a directory`.
- `ls {path:"missing"}` → `isError:true` `Path not found`.
- A directory with >500 entries appends the `entries limit reached` notice.

## Decisions & deviations
- **No `LsOperations` seam** (locked: "None") — direct `node:fs`.

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/ls.ts` (readdir, case-insensitive sort, `/` suffix, stat-skip, notices) with unit tests (incl. not-a-directory / not-found / empty)
