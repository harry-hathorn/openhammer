# 02 — Shared Execution Utilities (result, io, path-utils, truncate, output-accumulator)

## Purpose
The foundational modules every tool depends on. `result.ts` and `io.ts` are **new** (not in pi) and underpin the Result error model; `path-utils`/`truncate`/`output-accumulator` are faithful pi ports. Author `result.ts` first — it's the most-imported module in the project.

## Source references
- `result.ts`, `io.ts` — new (no pi equivalent; the Result error model is a deliberate OpenHammer addition).
- `truncate.ts`, `output-accumulator.ts`, `path-utils.ts` — port **verbatim** from `/home/haz/source/pi/packages/coding-agent/src/core/tools/`.

All five live at `src/tools/`.

## `src/tools/result.ts` (new — foundational, no deps)
The Result type + helpers. Plain `Error` as the default error type.
```ts
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> { return { ok: true, value }; }
export function err<E>(error: E): Result<never, E> { return { ok: false, error }; }

export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
	return r.ok ? ok(fn(r.value)) : r;
}
export function andThen<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
	return r.ok ? fn(r.value) : r;
}
export function getOrElse<T, E>(r: Result<T, E>, fallback: T): T {
	return r.ok ? r.value : fallback;
}
export function combine<T, E>(rs: readonly Result<T, E>[]): Result<T[], E> {
	const out: T[] = [];
	for (const r of rs) { if (!r.ok) return r; out.push(r.value); }
	return ok(out);
}
```
Pure, synchronous, no imports. Unit-test `ok`/`err`/`map`/`andThen`/`combine` (success propagation, short-circuit on err).

## `src/tools/io.ts` (new — depends on `result.ts`)
Result-returning wrappers over throwing `node:fs` / `node:fs/promises` (**fs surface only**), so **tool bodies contain zero try/catch** and compose with `andThen`/`map`. Each wraps the throwing call: `try { return ok(await fs.x(...)) } catch (e) { return err(e as Error) }`. Spawn-based code (`bash`/`grep`/`find`/tunnel) does **not** use io.ts — each manages its own streaming spawn and returns `Result` at the end.
- `readFile(path): Promise<Result<Buffer>>` (`node:fs/promises` `readFile`)
- `access(path, mode?): Promise<Result<void>>`
- `stat(path): Promise<Result<Stats>>` and `statSync(path): Result<Stats>`
- `readdir(path): Promise<Result<string[]>>` and `readdirSync(path): Result<string[]>`
- `writeFile(path, data, opts?): Promise<Result<void>>`
- `mkdir(path, opts?): Promise<Result<void>>`
- `exists(path): Result<boolean>` (over `existsSync`)

Unit-test the success + errno-failure branches (e.g. `readFile` of a missing path → `err` whose `.error` is an `Error`).

## `src/tools/truncate.ts` (port verbatim)
Constants `DEFAULT_MAX_LINES=2000`, `DEFAULT_MAX_BYTES=50*1024`, `GREP_MAX_LINE_LENGTH=500`; `formatSize`, `truncateHead`, `truncateTail`, `truncateLine`; `TruncationResult`/`TruncationOptions`. No external deps (uses `Buffer`). Strip nothing — port as-is.

## `src/tools/path-utils.ts` (port verbatim)
`expandPath` (strip leading `@`, normalize unicode spaces, expand `~`) and `resolveToCwd` (expand → absolute pass-through else `resolve(cwd, …)`). **Do NOT port `resolveReadPath`'s macOS screenshot variants.**

## `src/tools/output-accumulator.ts` (port verbatim)
`OutputAccumulator` class. **Change default `tempFilePrefix` from `"pi-output"` → `"openhammer"`.** API: `append`/`finish`/`snapshot({persistIfTruncated})`/`closeTempFile`/`getLastLineBytes`. Spills full output to `os.tmpdir()/<prefix>-<hex>.log` when over limits. Imports `truncateTail` from `./truncate.ts`.

## Acceptance criteria
- `result.ts`: `map(ok(2), x=>x+1)` → `ok(3)`; `andThen(err(e), …)` short-circuits; `combine([ok(1), err(e)])` → the err.
- `io.ts`: `readFile("missing")` → `{ ok:false, error: Error }`; `readFile(real)` → `{ ok:true, value: Buffer }`.
- `truncateHead` of 3000 lines → 2000, `truncatedBy:"lines"`; single 60KB line → `content:""`, `firstLineExceedsLimit:true`. `truncateTail` keeps the LAST 2000. `formatSize(512*1024)` → `"512.0KB"`.
- `resolveToCwd("~/x","/root")`→`/root/x`; `("a/b","/srv")`→`/srv/a/b`; `("/abs","/srv")`→`/abs`.
- `OutputAccumulator`: feed >50KB then `snapshot({persistIfTruncated:true})` → truncated tail + non-empty `fullOutputPath` whose file holds the full output.

## Decisions & deviations
- `result.ts` + `io.ts` are OpenHammer additions (Result error model) — see `docs/coding-standards.md`.
- Temp-file prefix `pi-output` → `openhammer`. `resolveReadPath` macOS variants dropped.

## Suggested plan items (atomic checkboxes)
- [ ] **02a.** `src/tools/result.ts` — `Result` type + `ok`/`err`/`map`/`andThen`/`getOrElse`/`combine` + tests. *deps: none.*
- [ ] **02b.** `src/tools/io.ts` — Result-wrappers over `node:fs`/`spawn` + tests. *deps: 02a.*
- [ ] **02c.** `src/tools/truncate.ts` — verbatim port + tests. *deps: none.*
- [ ] **02d.** `src/tools/path-utils.ts` — `expandPath`/`resolveToCwd` + tests. *deps: none.*
- [ ] **02e.** `src/tools/output-accumulator.ts` — verbatim port (prefix `openhammer`) + tests. *deps: 02c.*
