/**
 * The diagnostics registry (spec 17p) — the "doctor" check registry.
 *
 * A {@link DiagnosticCheck} is a named, async `run()` that probes one aspect of
 * the OpenHammer install and reports a {@link DiagnosticStatus}; `openhammer
 * doctor` runs every registered check and prints the results grouped by status,
 * mirroring pi's `diagnostics[]`. The built-in checks (`config.json` parses,
 * each channel's provider is available/reachable, `credentials.json` perms,
 * `rg`/`fd` present) are defined + registered in `src/cli/doctor.ts`.
 *
 * The registry mirrors the channel (17g) and settings-section (17l) registries:
 * pure vocabulary + a container + mutators + a reader, so adding a check is one
 * `registerDiagnostic` call and `doctor` runs it unchanged — the same
 * scalability seam. This module imports **nothing** (parity with `result.ts`),
 * which keeps it a clean, dependency-free container. The built-in checks
 * self-register from `doctor.ts` (a one-directional `doctor → registry` import),
 * so importing `registry.ts` alone yields an empty registry — the unit tests
 * register fakes on it directly.
 *
 * **Deviation recorded:** the container is an **array** (`DIAGNOSTICS`), not a
 * `Record` keyed by id — `doctor` prints results grouped by status and the
 * "run-all ordering" is meaningful (the static checks run in registration order,
 * before the dynamic per-channel checks `doctor` appends at run time). A `Record`
 * would lose insertion order as a first-class property.
 * {@link registerDiagnostic} replaces by `id` (last-wins, preserving the
 * first-insert position — the array analog of the channel registry's keyed
 * overwrite) and {@link getDiagnostics} returns a **copy** so a caller cannot
 * mutate the registry through the result (the channel registry avoids this by
 * exposing `getChannel` lookups, not the map itself; an array needs the copy).
 */

/** A check's verdict: `pass` (ok), `warn` (advisory — the install still works), or `fail` (broken). */
export type DiagnosticStatus = "pass" | "warn" | "fail";

/** The {@link DiagnosticCheck.run} outcome — a status plus a one-line human message. */
export interface DiagnosticResult {
	status: DiagnosticStatus;
	message: string;
}

/**
 * One doctor check. `id` groups/labels the result in the printed report; `run`
 * performs the probe and returns a {@link DiagnosticResult}. A check's `run`
 * **should not throw** — `doctor` wraps each in a safety net so a thrown error
 * becomes a `fail`, but a well-behaved check returns its own `fail` result.
 */
export interface DiagnosticCheck {
	id: string;
	run(): Promise<DiagnosticResult>;
}

/**
 * The registered checks, in insertion order. Populated at `doctor.ts` load by
 * the built-in checks. Mutate via {@link registerDiagnostic} /
 * {@link unregisterDiagnostic}; read via {@link getDiagnostics}.
 */
export const DIAGNOSTICS: DiagnosticCheck[] = [];

/**
 * Register a check under its `id` (a later registration overwrites an earlier
 * one with the same id, preserving the first-insert position). Exposed (not a
 * private helper) so a test registers a fake check the same way the built-ins do.
 */
export function registerDiagnostic(check: DiagnosticCheck): void {
	const idx = DIAGNOSTICS.findIndex((c) => c.id === check.id);
	if (idx >= 0) DIAGNOSTICS[idx] = check;
	else DIAGNOSTICS.push(check);
}

/** Remove a registered check by id (restores registry state — used by tests). No-op when absent. */
export function unregisterDiagnostic(id: string): void {
	const idx = DIAGNOSTICS.findIndex((c) => c.id === id);
	if (idx >= 0) DIAGNOSTICS.splice(idx, 1);
}

/**
 * Every registered check, in insertion order, as a fresh array (a caller cannot
 * mutate the registry through the result). `doctor` runs these plus the dynamic
 * per-channel checks.
 */
export function getDiagnostics(): DiagnosticCheck[] {
	return [...DIAGNOSTICS];
}
