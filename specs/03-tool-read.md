# 03 — Tool: `read`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
Read a file's contents (text or image) under `MCP_ROOT_DIR`. Faithful port of pi's `read` execute logic.

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/read.ts` — port `execute`, **strip everything else**: the `@earendil-works/pi-*` imports, `pi-tui`, `ToolDefinition`/`renderCall`/`renderResult`, the compact-read classification, `getReadmePath`, theme/highlight code, `resizeImage`, and `detectSupportedImageMimeTypeFromFile`. File: `src/tools/read.ts`.

## Depends on
- `src/tools/path-utils.ts` → `resolveToCwd` (spec 02)
- `src/tools/truncate.ts` → `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize`, `truncateHead`, `TruncationResult` (spec 02)

## Tool definition (verbatim from pi)
- **name**: `read`
- **description**: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to 2000 lines or 50KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`
- **inputSchema** (plain JSON-Schema object):
```json
{
  "type": "object",
  "properties": {
    "path": { "type": "string", "description": "Path to the file to read (relative or absolute)" },
    "offset": { "type": "number", "description": "Line number to start reading from (1-indexed)" },
    "limit": { "type": "number", "description": "Maximum number of lines to read" }
  },
  "required": ["path"]
}
```

## Behavior (port faithfully)
1. `absolutePath = resolveToCwd(path, rootDir)`.
2. `fsPromises.access(absolutePath, R_OK)` — throw on missing/unreadable (becomes `isError`).
3. **Image detection (v1 simplification):** by file extension → `.png`=image/png, `.jpg`/`.jpeg`=image/jpeg, `.gif`=image/gif, `.webp`=image/webp. (Deviation from pi's magic-byte + resize path — see below.)
4. If image: read bytes, `base64 = buffer.toString("base64")`, return content blocks:
   ```json
   [
     { "type": "text", "text": "Read image file [image/png]" },
     { "type": "image", "data": "<base64>", "mimeType": "image/png" }
   ]
   ```
   No resize. If the base64 exceeds `MAX_RESPONSE_BYTES`, the MCP backstop (spec 12) replaces it with `response_too_large`.
5. If text: read UTF-8, `split("\n")`. Apply `offset` (1-indexed → 0-indexed, `Math.max(0, offset-1)`); if `startLine >= allLines.length` throw `Offset ${offset} is beyond end of file (${allLines.length} lines total)`. If `limit` set, slice `[startLine, min(startLine+limit, length))`.
6. `truncateHead(selectedContent)`. Build output text:
   - `firstLineExceedsLimit` → message telling the caller to use bash: `sed -n '${line}p' <path> | head -c <bytes>`.
   - `truncated` (by lines) → append `\n\n[Showing lines ${start}-${end} of ${total}. Use offset=${next} to continue.]`.
   - `truncated` (by bytes) → same with `(${formatSize(DEFAULT_MAX_BYTES)} limit)`.
   - user `limit` stopped early with more remaining → append `\n\n[${remaining} more lines in file. Use offset=${next} to continue.]`.
   - else → raw truncated content.
7. Return `{ content: [{ type: "text", text: outputText }] }`.
8. **No line numbers.** Output is raw content (matches pi). Do NOT prepend `cat -n`-style numbering. (Locked decision.)

## Acceptance criteria
- `read {path:"a.txt"}` on a 10-line file returns the full text, no line-number prefixes.
- `read {path:"big.txt"}` on a 3000-line file returns the first 2000 lines + the `Use offset=2001 to continue` notice.
- `read {path:"x.txt", offset:5, limit:3}` returns lines 5–7.
- `read {path:"x.txt", offset:99999}` → `isError:true`, message mentions "beyond end of file".
- `read {path:"missing"}` → `isError:true`.
- `read {path:"pic.png"}` returns two content blocks: a `text` note and an `image` block with base64 data + `mimeType:"image/png"`.
- Relative paths resolve under `MCP_ROOT_DIR`; absolute paths pass through.

## Decisions & deviations
- **Image detection by extension, no resize, no `sharp`.** pi resizes to 2000×2000 and sniffs magic bytes; v1 skips both. Oversized images are caught by the universal `MAX_RESPONSE_BYTES` backstop.
- **No line numbers** (locked: match pi).
- Uses `resolveToCwd` (not pi's `resolveReadPath` macOS variants).

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/read.ts` (`execute` port: text path with offset/limit + `truncateHead` notices) with unit tests
- [ ] Add image-content-block path to `read` (extension detection → base64 image block) with unit tests
