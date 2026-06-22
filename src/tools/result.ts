/**
 * The Result error model — the spine of OpenHammer's tool layer.
 *
 * Tool `execute` functions return `Promise<Result<ToolOk>>`: expected failures
 * (missing file, no match, non-zero exit, missing `rg`) become `err(...)` rather
 * than thrown exceptions, and the single narrowing point — the MCP `CallTool`
 * handler in `src/mcp/server.ts` — is the only place that turns an `err` into an
 * `isError` response. Keeping the throwing boundary in one spot makes control
 * flow explicit and lets tool bodies read top-to-bottom via `andThen`/`map`.
 *
 * Plain `Error` is the default error type; OpenHammer throws no custom error
 * classes (see AGENTS.md). This module is pure and synchronous — no imports.
 */

/**
 * A value that is either a success (`{ ok: true; value }`) or a known failure
 * (`{ ok: false; error }`). The `ok` flag is the discriminant; narrow on it.
 */
export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/** Wrap a successful value. */
export function ok<T>(value: T): Result<T, never> {
	return { ok: true, value };
}

/** Wrap a known failure. */
export function err<E>(error: E): Result<never, E> {
	return { ok: false, error };
}

/** Map a success value, leaving a failure untouched (short-circuits on err). */
export function map<T, U, E>(r: Result<T, E>, fn: (v: T) => U): Result<U, E> {
	return r.ok ? ok(fn(r.value)) : r;
}

/**
 * Chain a function that itself returns a `Result` (the monadic bind). A failure
 * short-circuits and skips `fn` entirely — this is how tool bodies compose
 * multiple fallible steps without try/catch ladders.
 */
export function andThen<T, U, E>(r: Result<T, E>, fn: (v: T) => Result<U, E>): Result<U, E> {
	return r.ok ? fn(r.value) : r;
}

/** Return the success value, or `fallback` on failure. */
export function getOrElse<T, E>(r: Result<T, E>, fallback: T): T {
	return r.ok ? r.value : fallback;
}

/**
 * Collect a list of `Result`s into a single `Result<T[]>`. Short-circuits on the
 * first failure (returns it verbatim) — useful when several validations must all
 * pass before proceeding. An empty list yields `ok([])`.
 */
export function combine<T, E>(rs: readonly Result<T, E>[]): Result<T[], E> {
	const out: T[] = [];
	for (const r of rs) {
		if (!r.ok) {
			return r;
		}
		out.push(r.value);
	}
	return ok(out);
}
