# 08 — Tool: `find`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
Find files under `MCP_ROOT_DIR` by glob pattern via `fd`. Respects `.gitignore`. Port of pi's `find`.

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/find.ts` — port `execute`. **Strip:** `pi-tui`, render, `FindOperations` interface, and **replace `ensureTool("fd", true)` with `isToolAvailable("fd")`** (locked: graceful error if `fd` missing). File: `src/tools/find.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd`; `src/tools/truncate.ts` → `truncateHead`, `DEFAULT_MAX_BYTES`, `formatSize` (spec 02)
- `src/tools/bin.ts` → `isToolAvailable` (spec 07)

## Tool definition (verbatim from pi)
- **name**: `find`
- **description**: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'" },
    "path": { "type": "string", "description": "Directory to search in (default: current directory)" },
    "limit": { "type": "number", "description": "Maximum number of results (default: 1000)" }
  },
  "required": ["pattern"]
}
```

## Behavior (port faithfully)
1. `isToolAvailable("fd")` — if false, **throw** `fd is not installed. Install fd to use the find tool.`
2. `searchPath = resolveToCwd(searchDir || ".", rootDir)`; `effectiveLimit = limit ?? 1000`.
3. Build `fd` args (verbatim from pi): `["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(effectiveLimit)]`.
4. **Pattern-with-slash handling (port verbatim):** if `pattern.includes("/")`, push `--full-path` and, unless the pattern starts with `/`, `**/`, or equals `**`, rewrite `effectivePattern = "**/" + pattern`. Finally push `--", effectivePattern, searchPath`.
5. `spawn(fdPath, args, { stdio: ["ignore","pipe","pipe"] })`; collect stdout lines (each a path). On `error` event → `Failed to run fd: ${msg}`.
6. On close: non-zero exit with no output → error from stderr (`fd exited with code ${code}`); with output, treat as partial success. No lines → return `No files found matching pattern`.
7. Relativize each line against `searchPath` (slice prefix or `path.relative`), preserve trailing `/` for dir entries, convert to POSIX `/`. Cap at `effectiveLimit` (`resultLimitReached`). `truncateHead(joined, { maxLines: MAX_SAFE_INTEGER })` (byte cap only). Append notices: `${effectiveLimit} results limit reached. Use limit=${effectiveLimit*2} for more, or refine pattern` · `${formatSize(DEFAULT_MAX_BYTES)} limit reached`.
8. Return `{ content: [{ type: "text", text: output }] }`.

## Acceptance criteria
- `find {pattern:"**/*.ts"}` returns matching paths relative to the search dir, POSIX separators, respecting `.gitignore`.
- `find {pattern:"*.json"}` matches basenames in the search root.
- `find {pattern:"zzz-none"}` → `No files found matching pattern`.
- With `fd` uninstalled → `isError:true` with the install hint.
- `limit` cap appends the `results limit reached` notice.

## Decisions & deviations
- **Graceful error if `fd` missing** (locked). No Node glob fallback.
- **No `FindOperations` seam** (locked: "None").

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/find.ts` (fd spawn, pattern-with-slash handling, relativization, notices) with unit tests (incl. fd-missing error path)
