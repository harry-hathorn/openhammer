# 07 — Tool: `grep`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
Search file contents under `MCP_ROOT_DIR` for a pattern via `ripgrep` (`rg`), returning matches with file paths + line numbers. Respects `.gitignore`. Port of pi's `grep`.

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/grep.ts` — port `execute`. **Strip:** `pi-tui`, render, `GrepOperations` interface, and **replace `ensureTool("rg", true)` with a presence check** (locked: graceful error if `rg` missing — no download, no Node fallback). File: `src/tools/grep.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd`; `src/tools/truncate.ts` → `truncateHead`, `truncateLine`, `GREP_MAX_LINE_LENGTH`, `DEFAULT_MAX_BYTES`, `formatSize` (spec 02)
- `src/tools/bin.ts` → `isToolAvailable` (new, see below)

## Tool definition (verbatim from pi)
- **name**: `grep`
- **description**: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "pattern": { "type": "string", "description": "Search pattern (regex or literal string)" },
    "path": { "type": "string", "description": "Directory or file to search (default: current directory)" },
    "glob": { "type": "string", "description": "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
    "ignoreCase": { "type": "boolean", "description": "Case-insensitive search (default: false)" },
    "literal": { "type": "boolean", "description": "Treat pattern as literal string instead of regex (default: false)" },
    "context": { "type": "number", "description": "Number of lines to show before and after each match (default: 0)" },
    "limit": { "type": "number", "description": "Maximum number of matches to return (default: 100)" }
  },
  "required": ["pattern"]
}
```

## Behavior (port faithfully)
1. `isToolAvailable("rg")` — if false, **throw** `ripgrep (rg) is not installed. Install ripgrep to use the grep tool.`
2. `searchPath = resolveToCwd(searchDir || ".", rootDir)`. `isDirectory` via `fs.statSync`; throw → `Path not found: ${searchPath}`.
3. `contextValue = context && context > 0 ? context : 0`; `effectiveLimit = Math.max(1, limit ?? 100)`.
4. Build `rg` args (verbatim from pi): `["--json", "--line-number", "--color=never", "--hidden"]`; push `--ignore-case` if `ignoreCase`, `--fixed-strings` if `literal`, `--glob <glob>` if `glob`; finally `--", pattern, searchPath`.
5. `spawn(rgPath, args, { stdio: ["ignore","pipe","pipe"] })`. Read stdout as **NDJSON** (`--json` emits one JSON object per line). Collect `event.type === "match"` events (`event.data.path.text`, `event.data.line_number`, `event.data.lines.text`) until `matchCount >= effectiveLimit` → set `matchLimitReached`, kill child.
6. After exit: rg exits **1** on no-match (NOT an error — only codes other than 0/1 are errors). `matchCount === 0` → return text `No matches found`.
7. Format matches: if `contextValue === 0`, emit `${relPath}:${lineno}: ${truncateLine(lineText)}`; else read the file (`fs.readFileSync`, cache per file) and emit a block: match line `${relPath}:${n}: ...` and context lines `${relPath}-${n}- ...` for `[lineno-context, lineno+context]`. `relPath` = path relative to `searchPath` (POSIX `/`) when searching a dir, else basename.
8. `truncateHead(joined, { maxLines: MAX_SAFE_INTEGER })` (byte cap only — match count already bounds rows). Append notices: `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit*2} for more, or refine pattern` · `${formatSize(DEFAULT_MAX_BYTES)} limit reached` · `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`.
9. Return `{ content: [{ type: "text", text: output }] }`.

## `src/tools/bin.ts` (new shared helper)
`isToolAvailable(name): boolean` — runs `spawnSync(name, ["--version"], { stdio:"ignore" })` and returns `true` iff it exits 0 (i.e. the binary resolves in `PATH`). Shared by `grep` (`rg`) and `find` (`fd`). Small, unit-tested.

## Acceptance criteria
- `grep {pattern:"TODO", path:"."}` returns matches as `path:line: text`, respects `.gitignore`.
- `grep` with `ignoreCase:true` matches case-insensitively; `literal:true` escapes regex.
- `grep {pattern:"zzz-nope"}` → `No matches found`.
- With `rg` uninstalled (PATH stripped in the test), the call returns `isError:true` with the install hint.
- A `limit:2` search that finds more appends the `matches limit reached` notice.

## Decisions & deviations
- **Graceful error if `rg` missing** (locked). Replaces pi's `ensureTool` auto-download. No Node fallback search.
- **No `GrepOperations` seam** (locked: "None") — direct `fs` reads for context lines.

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/bin.ts` (`isToolAvailable` via `spawnSync --version`) with unit tests
- [ ] Implement `src/tools/grep.ts` (rg NDJSON parsing, match cap, context formatting, notices) with unit tests (incl. rg-missing error path)
