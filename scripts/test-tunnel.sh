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
ROUTE_WAIT_S=30 # edge warm-up + DNS for the freshly-minted trycloudflare subdomain.
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
# cloudflared prints the trycloudflare URL several seconds BEFORE Cloudflare's
# edge is ready to route traffic to it, and the brand-new subdomain may not
# resolve on the first lookup. Finding the URL in the logs is not enough — hit
# `/health` through the PUBLIC url until it answers 200 (proves edge → tunnel →
# server), else the runner's first request dies with a bare `fetch failed`
# (TCP/DNS), not an HTTP error. Node's global fetch is used (node is guaranteed
# present — tsx runs the runner next); PROBE_URL env avoids quoting the URL.
echo "[test-tunnel] probing public URL until it routes (≤ ${ROUTE_WAIT_S}s)…"
routed=0
deadline=$((SECONDS + ROUTE_WAIT_S))
while ((SECONDS < deadline)); do
	if PROBE_URL="${url}/health" node -e "fetch(process.env.PROBE_URL).then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
		routed=1
		break
	fi
	sleep "$POLL_INTERVAL_S"
done
if ((routed != 1)); then
	echo "FAIL: public URL ${url} never routed within ${ROUTE_WAIT_S}s (edge warm-up / DNS)." >&2
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
