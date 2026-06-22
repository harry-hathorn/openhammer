# 06 — Tool: `edit`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. `applyEditsToNormalizedContent` (spec 06-M) returns `Result` instead of throwing on not-found/duplicate/overlap/no-change. See spec 02 + `docs/coding-standards.md`.

## Purpose
Apply one or more exact-text replacements to a file under `MCP_ROOT_DIR`. The trickiest tool — faithful port of pi's edit + the subset of `edit-diff` it needs.

## Source references (port)
- `/home/haz/source/pi/packages/coding-agent/src/core/tools/edit.ts` — port `execute` + `validateEditInput` + `prepareEditArguments`. **Strip:** `pi-tui`, render/preview, `EditOperations` interface, the `details` diff/patch generation.
- `/home/haz/source/pi/packages/coding-agent/src/core/tools/edit-diff.ts` — port **only** the apply path: `stripBom`, `detectLineEnding`, `normalizeToLF`, `restoreLineEndings`, `normalizeForFuzzyMatch`, `fuzzyFindText`, `applyEditsToNormalizedContent`, `countOccurrences`, and the error builders. **Do NOT port** `generateDiffString`/`generateUnifiedPatch`/`computeEditsDiff`/`computeEditDiff` (TUI preview only) → therefore **no `diff` npm dependency**.
- Files: `src/tools/edit.ts`, `src/tools/edit-diff.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd` (spec 02)

## Tool definition (verbatim from pi)
- **name**: `edit`
- **description**: `Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to the file to edit (relative or absolute)" },
    "edits": {
      "type": "array",
      "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
      "items": {
        "type": "object",
        "properties": {
          "oldText": { "type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call." },
          "newText": { "type": "string", "description": "Replacement text for this targeted edit." }
        },
        "required": ["oldText", "newText"],
        "additionalProperties": false
      }
    }
  },
  "required": ["path", "edits"],
  "additionalProperties": false
}
```

## Behavior (port faithfully)
1. `prepareEditArguments`: tolerate models that send `edits` as a JSON string (parse it) and the legacy `{oldText,newText}` form (fold into `edits:[{oldText,newText}]`). Port as-is.
2. `validateEditInput`: `edits` must be a non-empty array, else throw `Edit tool input is invalid. edits must contain at least one replacement.`
3. `absolutePath = resolveToCwd(path, rootDir)`.
4. `access(absolutePath, R_OK|W_OK)`; on failure throw `Could not edit file: ${path}. Error code: ${code}.`
5. Read file UTF-8. `const { bom, text: content } = stripBom(raw)`; `originalEnding = detectLineEnding(content)`; `normalized = normalizeToLF(content)`.
6. `const { baseContent, newContent } = applyEditsToNormalizedContent(normalized, edits, path)` (see contract below).
7. `finalContent = bom + restoreLineEndings(newContent, originalEnding)`; `writeFile(absolutePath, finalContent)`.
8. Return `{ content: [{ type: "text", text: "Successfully replaced ${edits.length} block(s) in ${path}." }] }`.

### `applyEditsToNormalizedContent` contract (port verbatim; **returns `Result<{ baseContent, newContent }, Error>`**)
**Every `→ throw <msg>` below is `→ return err(new Error(<msg>))`** — this function never throws; it returns `ok({ baseContent, newContent })` on success or `err(...)` on any validation failure.
- Normalize each edit's `oldText`/`newText` with `normalizeToLF`.
- Empty `oldText` → throw (single: `oldText must not be empty in ${path}.`, multi: `edits[${i}].oldText must not be empty in ${path}.`).
- If ANY edit needs fuzzy match, operate in fully-normalized space (`normalizeForFuzzyMatch`) for the whole file.
- For each edit: `fuzzyFindText` (exact `indexOf` first, then fuzzy via `normalizeForFuzzyMatch`).
  - Not found → throw (single: `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`, multi: `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`).
  - `countOccurrences` > 1 → throw (single: `Found ${n} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`, multi: `Found ${n} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`).
- Sort matches by index; adjacent overlap (`prev.index+prev.length > cur.index`) → throw `edits[${prev}] and edits[${cur}] overlap in ${path}. Merge them into one edit or target disjoint regions.`
- Apply replacements in reverse index order so offsets stay stable.
- `baseContent === newContent` → throw (single: `No changes made to ${path}. The replacement produced identical content. ...`, multi: `No changes made to ${path}. The replacements produced identical content.`).

### `normalizeForFuzzyMatch` (port verbatim)
`NFKC` normalize → strip trailing whitespace per line (`split("\n").map(trimEnd).join("\n")`) → smart single/double quotes → ASCII quotes → Unicode dashes/hyphens (U+2010..2015, U+2212) → `-` → special spaces (NBSP, U+2002–200A, U+202F, U+205F, U+3000) → regular space.

## Acceptance criteria
- Single exact edit on a unique block succeeds; file content updated; returns `Successfully replaced 1 block(s) in <path>.`.
- Multiple disjoint edits in one call all apply; none apply incrementally (each matched against original).
- Non-unique `oldText` (2+ occurrences) → `isError:true` with the "must be unique" message; file unchanged.
- Not-found `oldText` → `isError` with the "match exactly" message; file unchanged.
- Overlapping edits → `isError` with the "overlap" message; file unchanged.
- Fuzzy: an `oldText` differing only by trailing whitespace or smart quotes still matches (and the file ends up with normalized whitespace there).
- BOM preserved on write; CRLF files keep CRLF line endings after edit.

## Decisions & deviations
- **No diff/patch output.** pi returns a rendered diff in `details`; OpenHammer has no TUI, so we return only the success text and drop the `diff` dependency.
- **No `EditOperations` interface seam** (locked: "None").

## Suggested plan items (atomic checkboxes)
- [ ] Port `src/tools/edit-diff.ts` (BOM/line-ending helpers, `normalizeForFuzzyMatch`, `fuzzyFindText`, `applyEditsToNormalizedContent` + error builders) with unit tests (match, not-found, duplicate, overlap, fuzzy, no-change)
- [ ] Implement `src/tools/edit.ts` (`prepareEditArguments`, `validateEditInput`, read→stripBom→normalize→apply→restore→write) with unit tests (single, multi, BOM/CRLF preservation)
