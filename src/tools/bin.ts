/**
 * The `bin` helper (spec 07).
 *
 * `isToolAvailable(name)` is the presence check that replaces pi's `ensureTool`
 * auto-download. pi's `tools-manager` would download a missing tool on demand;
 * OpenHammer is presence-only — no download, no Node fallback search. It runs
 * `<name> --version` with all stdio ignored and returns `true` iff the binary
 * resolves in `PATH` and exits 0. Shared by `grep` (`rg`), `find` (`fd`), and
 * the tunnel (`cloudflared`) — each turns a `false` into a graceful `err`/`null`
 * rather than a crash.
 *
 * Synchronous on purpose: it is a cheap, infrequent guard run once per tool
 * invocation, and callers need the answer before they spawn the real work.
 */
import { spawnSync } from "node:child_process";

/**
 * Returns `true` iff `<name> --version` resolves in `PATH` and exits 0.
 *
 * Any spawn error (binary not found → ENOENT) or non-zero status collapses to
 * `false`: `spawnSync` sets `status` to `null` on spawn failure and to the exit
 * code on a successful exec, so the single `status === 0` test covers both the
 * "absent" and "present-but-broken" cases.
 */
export function isToolAvailable(name: string): boolean {
	const result = spawnSync(name, ["--version"], { stdio: "ignore" });
	return result.status === 0;
}
