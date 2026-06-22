# 13 — Tunnel: cloudflared Quick-Tunnel (optional `--tunnel`)

## Purpose
Optionally expose the localhost server at a public `https://*.trycloudflare.com` URL via `cloudflared`'s zero-account quick-tunnel, so a remote agent can reach the tools. No account, no config file, ephemeral URL. Hard-depends on the `cloudflared` binary being installed; if absent, the server continues localhost-only.

## Source references
- Locked decision 5 in the plan (localhost bind + optional `--tunnel`).
- File: `src/tunnel/cloudflare.ts`. No reference codebase (greenfield helper).

## Depends on
- `src/tools/bin.ts` → `isToolAvailable` (spec 07) — reuse to detect `cloudflared`.

## `src/tunnel/cloudflare.ts` — `startTunnel(port): Promise<{ url: string; child: ChildProcess } | null>`
1. If `!isToolAvailable("cloudflared")` → **return `null`** (caller logs a notice and continues localhost-only). Never throw on a missing binary.
2. `spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"], { stdio: ["ignore","pipe","pipe"] })`.
3. **cloudflared prints the quick-tunnel URL on `stderr`** (not stdout). Accumulate stderr chunks; regex-scan for `https://[a-z0-9-]+\.trycloudflare\.com`. On first match → resolve `{ url, child }`.
4. Guard with a timeout (~15s): if no URL appears, kill the child and return `null` (don't hang boot). Also surface non-URL stderr lines via the logger for diagnosability.
5. Return both the `url` and the `child` so `main.ts` keeps the process alive for the server's lifetime and kills it on shutdown.
6. If the child dies early (`close`/`error`) before a URL → return `null`.

## Acceptance criteria
- With `cloudflared` installed + `--tunnel`: `startTunnel` resolves a `https://*.trycloudflare.com` URL within the timeout; the server keeps running; the URL is printed (spec 14).
- With `cloudflared` absent: `startTunnel` resolves `null` quickly (no spawn hang); the server boots and runs localhost-only.
- On shutdown (SIGINT/SIGTERM in main.ts), the tunnel child process is killed (no orphaned `cloudflared`).
- **Tier-4 E2E (gated, task T-tunnel-e2e):** `npm run test:tunnel` with `OPENHAMMER_TUNNEL_E2E=1` + `cloudflared` present spins up the compose `tunnel` profile (real `server` + `cloudflared`), parses the public URL from stderr, and a retargeted `test-runner` drives a `tools/call` round-trip **through the public `trycloudflare.com` URL**. With the flag off or the binary absent, the script prints a clear skip and exits 0 (non-blocking — the test traverses Cloudflare's live edge, so it is never part of the hermetic trio; see specs 15/16).

## Decisions & deviations
- **No hard dependency** on cloudflared at install or boot — presence-checked at runtime, graceful fallback. (Matches locked decision 5.)
- Quick-tunnel only (ephemeral, no named-tunnel/credentials-file support in v1).

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tunnel/cloudflare.ts` (`startTunnel`: presence check, spawn, parse trycloudflare URL from stderr, timeout → null, return url+child) with unit tests (mock spawn / regex parsing; presence-check branches)
