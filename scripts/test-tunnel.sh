#!/usr/bin/env bash
# Tier-4 tunnel E2E (spec 13/16).
#
# Proves the public `https://*.trycloudflare.com` quick-tunnel routes a real MCP
# `tools/call` round-trip end-to-end. Non-blocking by design: it traverses
# Cloudflare's LIVE edge, so it can NEVER be hermetic. The script exits 0 (skip)
# unless ALL of:
#   1. OPENHAMMER_TUNNEL_E2E=1 is exported, AND
#   2. `cloudflared` is on PATH, AND
#   3. `docker compose` (v2) is available
# are present — otherwise the hermetic trio would flake on a box missing any of
# them (the dev box has none of these reliably).
#
# Orchestration:
#   - brings up the compose `real` + `tunnel` profiles detached (the real
#     `server` + a `cloudflared` quick-tunnel bridging `http://server:3000` to a
#     public URL);
#   - waits for the server `/health` to go healthy AND the trycloudflare URL to
#     appear in cloudflared's stderr (captured in `docker compose logs`);
#   - retargets the existing `test/compose/run-e2e.ts` runner at the PUBLIC url
#     (`<url>/mcp`) and drives a full 7-tool `tools/call` sweep through it;
#   - tears the compose services down on exit (trap), win or lose.
set -euo pipefail

# --- gate (non-blocking) -----------------------------------------------------
if [[ "${OPENHAMMER_TUNNEL_E2E:-0}" != "1" ]]; then
	echo "skip: OPENHAMMER_TUNNEL_E2E is not set to 1 (tunnel E2E is opt-in)."
	exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
	echo "skip: cloudflared is not on PATH (tunnel E2E requires it)."
	exit 0
fi

if ! docker compose version >/dev/null 2>&1; then
	echo "skip: docker compose (v2) is unavailable (tunnel E2E requires it)."
	exit 0
fi

# --- config ------------------------------------------------------------------
# Run from the repo root so docker-compose.yml + tsx resolve regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

PROFILES=(--profile real --profile tunnel)
# cloudflared prints the quick-tunnel URL on stderr. Identical regex to
# `extractTunnelUrl` in src/tunnel/cloudflare.ts — single source of truth.
TUNNEL_URL_RE='https://[a-z0-9-]+\.trycloudflare\.com'
# Must match the `server` service's `MCP_AUTH_TOKEN` in docker-compose.yml.
MCP_TOKEN="real-compose-bearer-token"
READY_WAIT_S=90 # generous: server boot + cloudflared edge registration.
ROUTE_WAIT_S=90 # edge warm-up + DNS for the fresh trycloudflare subdomain. 30s proved marginal (the failing run's healthy tunnel still hadn't routed at ~31s); a hard-failed edge is caught separately + fast, so this budget only guards the warm-up tail.
POLL_INTERVAL_S=2

# --- teardown ----------------------------------------------------------------
teardown() {
	echo "[test-tunnel] tearing down compose services…"
	docker compose "${PROFILES[@]}" down --remove-orphans >/dev/null 2>&1 || true
}
trap teardown EXIT

# --- helpers (always exit 0 so `$(...)` is safe under set -e) ----------------
server_health() {
	local cid
	cid="$(docker compose "${PROFILES[@]}" ps -q server 2>/dev/null)" || cid=""
	if [[ -z "$cid" ]]; then return 0; fi
	docker inspect -f '{{.State.Health.Status}}' "$cid" 2>/dev/null || true
}

tunnel_url() {
	docker compose "${PROFILES[@]}" logs cloudflared 2>/dev/null |
		grep -oE "$TUNNEL_URL_RE" | head -n1 || true
}

# cloudflared (≥ 2026.x) runs a connectivity PRE-CHECK against its tunnel-edge
# regions on startup and logs `precheck complete hard_fail=<bool>`. A hard fail
# means the host's egress CANNOT reach Cloudflare's edge (a region's UDP+TCP is
# blocked), so the public URL will NEVER route — probing is pointless. Used in an
# `if` (not `$()`), so returning grep's non-zero on "no hard fail" is fine.
edge_hard_failed() {
	docker compose "${PROFILES[@]}" logs cloudflared 2>/dev/null |
		grep -q 'precheck complete hard_fail=true'
}

# Probes `<url>/health` through the public trycloudflare URL. ALWAYS exits 0 —
# safe under `set -e` inside `$(...)` (verified: `x=$(false)` aborts under
# `set -euo pipefail`, so success/failure must be encoded in stdout, not the rc).
# Prints "OK" on HTTP 200, else a diagnostic tag: DNS-FAIL / HTTP-<code> / TIMEOUT
# / FETCH-ERR(<code>). An AbortController bounds each attempt so a stalled TLS/TCP
# handshake can't consume the retry budget.
probe_public_url() {
	PROBE_URL="${1}" node -e '
		const u = process.env.PROBE_URL;
		const ctrl = new AbortController();
		const to = setTimeout(() => ctrl.abort(), 5000);
		fetch(u, { signal: ctrl.signal })
			.then(async (r) => {
				clearTimeout(to);
				process.stdout.write(r.status === 200 ? "OK" : "HTTP-" + r.status);
			})
			.catch((e) => {
				clearTimeout(to);
				const c = e && e.cause;
				const code = (c && c.code) || (c && c.message) || String(e);
				const tag = /ENOTFOUND|EAI/.test(code) ? "DNS-FAIL"
					: /abort|AbortError/i.test(String(e)) ? "TIMEOUT"
					: "FETCH-ERR(" + code.slice(0, 40) + ")";
				process.stdout.write(tag);
			});
	'
}

# --- bring up server + cloudflared ------------------------------------------
echo "[test-tunnel] building + starting server + cloudflared (profiles: real, tunnel)…"
docker compose "${PROFILES[@]}" up -d --build server cloudflared

# --- wait for readiness: server healthy AND tunnel URL printed ---------------
echo "[test-tunnel] waiting for server /health + trycloudflare URL (≤ ${READY_WAIT_S}s)…"
url=""
health=""
deadline=$((SECONDS + READY_WAIT_S))
while ((SECONDS < deadline)); do
	health="$(server_health)"
	url="$(tunnel_url)"
	if [[ "$health" == "healthy" && -n "$url" ]]; then
		break
	fi
	sleep "$POLL_INTERVAL_S"
done

if [[ "$health" != "healthy" ]]; then
	echo "FAIL: server did not report healthy within ${READY_WAIT_S}s." >&2
	docker compose "${PROFILES[@]}" logs server >&2 || true
	exit 1
fi

if [[ -z "$url" ]]; then
	echo "FAIL: no trycloudflare URL in cloudflared logs within ${READY_WAIT_S}s." >&2
	docker compose "${PROFILES[@]}" logs cloudflared >&2 || true
	exit 1
fi

# --- probe the public URL until it actually routes --------------------------
# Finding the URL in cloudflared's stderr is NOT enough, for two reasons:
#   (a) cloudflared prints it BEFORE the edge routes traffic, and the brand-new
#       subdomain may not resolve on the host for tens of seconds (DNS
#       propagation / negative caching on the host's resolver);
#   (b) if cloudflared's connectivity PRE-CHECK hard-fails, the host can't reach
#       Cloudflare's tunnel edge and the URL will NEVER route — catch that here
#       and fail fast instead of burning the full ROUTE_WAIT_S budget.
# `probe_public_url` (helper above) classifies each failure so a failed run says
# exactly what was wrong, instead of a blind "(edge warm-up / DNS)" guess.
if edge_hard_failed; then
	echo "FAIL: cloudflared's edge connectivity pre-check hard-failed — this host cannot reach Cloudflare's tunnel edge (a region's UDP+TCP is blocked). The public URL will never route; this is a network-egress problem, not an OpenHammer bug." >&2
	exit 1
fi

echo "[test-tunnel] probing public URL until it routes (≤ ${ROUTE_WAIT_S}s)…"
routed=0
last_diag=""
deadline=$((SECONDS + ROUTE_WAIT_S))
while ((SECONDS < deadline)); do
	last_diag="$(probe_public_url "${url}/health" 2>/dev/null)"
	if [[ "$last_diag" == "OK" ]]; then
		routed=1
		break
	fi
	sleep "$POLL_INTERVAL_S"
done
if ((routed != 1)); then
	if edge_hard_failed; then
		echo "FAIL: cloudflared's edge connectivity pre-check hard-failed during probing — this host cannot reach Cloudflare's tunnel edge. The public URL will never route; this is a network-egress problem, not an OpenHammer bug." >&2
	else
		echo "FAIL: public URL ${url} never returned /health 200 within ${ROUTE_WAIT_S}s (last probe: ${last_diag}). DNS-FAIL ⇒ the host resolver isn't resolving the fresh subdomain; HTTP-5xx ⇒ edge is up but the origin is unreachable through the tunnel; TIMEOUT ⇒ the edge stalled mid-handshake." >&2
	fi
	docker compose "${PROFILES[@]}" logs cloudflared >&2 || true
	exit 1
fi

# --- drive the runner through the PUBLIC url --------------------------------
mcp_url="${url}/mcp"
echo "[test-tunnel] retargeting runner at ${mcp_url}"
# Trust the explicit "ALL CHECKS PASSED" marker over tsx's exit code: tsx (node
# loader) has been observed to exit 0 even when the script calls process.exit(1),
# so the raw rc is an unreliable pass/fail signal. Capture + tee the output.
runner_log="$(mktemp)"
set +e
MCP_URL="$mcp_url" MCP_TOKEN="$MCP_TOKEN" ./node_modules/.bin/tsx test/compose/run-e2e.ts 2>&1 | tee "$runner_log"
set -e
if grep -q "ALL CHECKS PASSED" "$runner_log"; then
	echo "[test-tunnel] PASSED: tools/call round-tripped through ${url}"
	rm -f "$runner_log"
	exit 0
fi
echo "[test-tunnel] FAILED: runner did not report success against ${mcp_url}" >&2
rm -f "$runner_log"
exit 1
