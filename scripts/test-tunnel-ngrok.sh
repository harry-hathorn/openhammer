#!/usr/bin/env bash
# Tier-4 ngrok channel E2E (spec 17i/17u + 16).
#
# Proves the public `https://*.ngrok.app` URL routes a real MCP `tools/call`
# round-trip end-to-end through the ngrok channel provider's path. Non-blocking
# by design: it traverses ngrok's LIVE edge, so it can NEVER be hermetic. The
# script exits 0 (skip) unless BOTH:
#   1. NGROK_AUTHTOKEN is exported, AND
#   2. `ngrok` is on PATH
# are present — otherwise the hermetic trio would flake on a box missing either
# (the dev box has neither). NGROK_AUTHTOKEN is the opt-in CI gate (spec 17),
# intentionally NOT in `.env.example` (seeding a runtime env copy with it would
# be a footgun — the same reasoning as OPENHAMMER_TUNNEL_E2E for cloudflare).
#
# Host-only orchestration (unlike the cloudflare Tier-4, which runs cloudflared
# INSIDE the compose network): ngrok is a host CLI that bridges a LOCAL port, so
# the real server runs on the host too — the same `tsx src/main.ts` boot path
# `test/e2e-hermetic/boot.e2e.test.ts` drives — and ngrok reaches it at
# `127.0.0.1:<port>`. No docker compose is involved: the compose `server` is only
# reachable on the Docker network, which a host ngrok cannot address without
# port-publishing, so it is simpler to run the server on the host directly. (The
# server image/code is already container-validated by `test:compose:real`;
# this tier proves the *tunnel* routes the round-trip.)
#
#   - starts the real server on the host (free loopback port, temp MCP_ROOT_DIR,
#     a known bearer, isolated HOME so the status socket never touches the real
#     ~/.openhammer);
#   - starts `ngrok http <port>` with the authtoken as NGROK_AUTHTOKEN env (never
#     a CLI arg, so it never appears in a `ps` listing — exactly how
#     `ngrokProvider.start` spawns it) and polls the ngrok inspector API
#     (`http://127.0.0.1:4040/api/tunnels`) for the public URL — the same source
#     `ngrokProvider.start`/`extractNgrokUrl` read, with the same "prefer the
#     first https:// public_url" rule;
#   - probes `<url>/health` through the public URL until it routes;
#   - retargets the existing `test/compose/run-e2e.ts` runner at the PUBLIC url
#     (`<url>/mcp`) and drives the full real-server tools/call sweep through it;
#   - tears the ngrok process + server down on exit (trap), win or lose.
set -euo pipefail

# --- gate (non-blocking) -----------------------------------------------------
if [[ -z "${NGROK_AUTHTOKEN:-}" ]]; then
	echo "skip: NGROK_AUTHTOKEN is not set (ngrok tunnel E2E is opt-in)."
	exit 0
fi

if ! command -v ngrok >/dev/null 2>&1; then
	echo "skip: ngrok is not on PATH (ngrok tunnel E2E requires it)."
	exit 0
fi

# --- config ------------------------------------------------------------------
# Run from the repo root so tsx + test/compose/run-e2e.ts resolve regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

# Must match the bearer the runner sends (run-e2e.ts reads MCP_TOKEN). Mirrors
# docker-compose.yml's `server` MCP_AUTH_TOKEN, so the same runner works for both.
MCP_TOKEN="real-compose-bearer-token"
# The ngrok inspector returns the public URL as JSON once the tunnel is up — the
# same endpoint `ngrokProvider.start` polls (DEFAULT_INSPECTOR_URL).
INSPECTOR_URL="http://127.0.0.1:4040/api/tunnels"
SERVER_WAIT_S=30 # tsx cold-start + server boot (~1s in practice; generous for slow CI).
URL_WAIT_S=30    # ngrok provisions a subdomain fast — no cloudflare-style DNS-provisioning wait.
ROUTE_WAIT_S=60  # edge warm-up; the /health probe is the real guard.
POLL_INTERVAL_S=2

# Tracks for teardown (all empty until their process/temp is created).
SERVER_PID=""
NGROK_PID=""
SERVER_LOG=""
NGROK_LOG=""
RUNNER_LOG=""
TEMP_HOME=""
TEMP_ROOT=""

# --- helpers (always exit 0 so `$(...)` is safe under set -e) ----------------

# SIGTERM a tracked pid, then SIGKILL it after a short grace so a hung child
# cannot orphan — ngrok holds :4040 + the live tunnel, so a leftover would block
# re-runs. The SIGKILL is harmless if the process already exited.
kill_pid() {
	local pid="$1"
	[[ -z "$pid" ]] && return 0
	kill "$pid" >/dev/null 2>&1 || true
	sleep 1
	kill -9 "$pid" >/dev/null 2>&1 || true
}

teardown() {
	# Kill ngrok first so it stops advertising the tunnel, then the server.
	kill_pid "$NGROK_PID"
	kill_pid "$SERVER_PID"
	rm -f "$SERVER_LOG" "$NGROK_LOG" "$RUNNER_LOG" 2>/dev/null || true
	[[ -n "$TEMP_HOME" ]] && rm -rf "$TEMP_HOME" 2>/dev/null || true
	[[ -n "$TEMP_ROOT" ]] && rm -rf "$TEMP_ROOT" 2>/dev/null || true
}
trap teardown EXIT

# A free loopback port for the server (listen 0 → read the assigned port → close).
# Mirrors boot.e2e.test.ts's getFreePort. TOCTOU-accepted: a collision fails fast
# (the server dies on EADDRINUSE → the readiness wait reports it from the log).
free_port() {
	node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{process.stdout.write(String(s.address().port));s.close()})'
}

# Probes `<url>` (any http(s) URL). ALWAYS exits 0 — safe under `set -e` inside
# `$(...)` (verified: `x=$(false)` aborts under `set -euo pipefail`, so success/
# failure is encoded in stdout, not the rc). Prints "OK" on HTTP 200, else a
# diagnostic tag: DNS-FAIL / HTTP-<code> / TIMEOUT / FETCH-ERR(<code>). An
# AbortController bounds each attempt so a stalled TLS/TCP handshake can't
# consume the retry budget. (Identical shape to test-tunnel.sh's probe_public_url.)
probe_url() {
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

# Reads the ngrok inspector `GET /api/tunnels` body and prints the public URL —
# the same parse as `extractNgrokUrl` in src/tunnel/providers/ngrok.ts (single
# source of truth): prefer the first `https://` `public_url`, else the first URL.
# Prints "" until the tunnel is provisioned (the inspector replies `{tunnels:[]}`
# meanwhile). ALWAYS exits 0 — the `.catch` writes "" so `$(...)` is safe.
ngrok_url() {
	INSPECTOR_URL="$INSPECTOR_URL" node -e '
		const u = process.env.INSPECTOR_URL;
		fetch(u)
			.then(async (r) => {
				if (!r.ok) { process.stdout.write(""); return; }
				const data = await r.json();
				const tunnels = Array.isArray(data && data.tunnels) ? data.tunnels : [];
				const urls = tunnels.map((t) => t && t.public_url).filter((x) => typeof x === "string");
				const https = urls.find((x) => x.startsWith("https://"));
				process.stdout.write(https || urls[0] || "");
			})
			.catch(() => process.stdout.write(""));
	'
}

# --- temp workspace ----------------------------------------------------------
TEMP_HOME="$(mktemp -d)"
TEMP_ROOT="$(mktemp -d)"
SERVER_LOG="$(mktemp)"
NGROK_LOG="$(mktemp)"
RUNNER_LOG="$(mktemp)"

# Ensure the authtoken reaches the spawned ngrok child (export, not just set).
export NGROK_AUTHTOKEN

# --- start the real server on the host ---------------------------------------
SERVER_PORT="$(free_port)"
echo "[test-tunnel-ngrok] starting server on 127.0.0.1:${SERVER_PORT} (node --import tsx src/main.ts)…"
# Run via `node --import tsx` (NOT the `tsx` CLI): the CLI spawns a CHILD node
# that actually runs the server, so killing `$!` (the CLI) orphans the server —
# it survives, still holding its port. `node --import tsx` runs the server in the
# MAIN process (verified: a SIGTERM on `$!` reaps the server + its esbuild helper
# child cleanly), so `kill_pid "$SERVER_PID"` in teardown is complete.
# MCP_AUTH_TOKEN set ⇒ ensureToken short-circuits (no cred-file write). Isolated
# HOME keeps the status socket (spec 17s) off the real ~/.openhammer. LOG_LEVEL=
# warn keeps the boot quiet. The auto-run guard fires (process.argv[1] ===
# src/main.ts); Fastify's listening socket keeps the process alive serving.
PORT="$SERVER_PORT" \
HOST="127.0.0.1" \
MCP_ROOT_DIR="$TEMP_ROOT" \
MCP_AUTH_TOKEN="$MCP_TOKEN" \
HOME="$TEMP_HOME" \
LOG_LEVEL="warn" \
	node --import tsx src/main.ts >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

echo "[test-tunnel-ngrok] waiting for server /health (≤ ${SERVER_WAIT_S}s)…"
server_ok=0
deadline=$((SECONDS + SERVER_WAIT_S))
while ((SECONDS < deadline)); do
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "FAIL: server process exited before becoming ready." >&2
		cat "$SERVER_LOG" >&2 || true
		exit 1
	fi
	if [[ "$(probe_url "http://127.0.0.1:${SERVER_PORT}/health")" == "OK" ]]; then
		server_ok=1
		break
	fi
	sleep "$POLL_INTERVAL_S"
done
if ((server_ok != 1)); then
	echo "FAIL: server did not report /health 200 within ${SERVER_WAIT_S}s." >&2
	cat "$SERVER_LOG" >&2 || true
	exit 1
fi

# --- start ngrok + wait for the public URL -----------------------------------
echo "[test-tunnel-ngrok] starting ngrok http ${SERVER_PORT}…"
# `ngrok http <port>` with NGROK_AUTHTOKEN inherited via env — exactly how
# `ngrokProvider.start` spawns it (the authtoken never rides on the CLI / in `ps`).
ngrok http "$SERVER_PORT" >"$NGROK_LOG" 2>&1 &
NGROK_PID=$!

echo "[test-tunnel-ngrok] waiting for ngrok public URL (≤ ${URL_WAIT_S}s)…"
url=""
deadline=$((SECONDS + URL_WAIT_S))
while ((SECONDS < deadline)); do
	# A bad authtoken (or a rate-limited/blocked account) makes ngrok exit at
	# once — bail fast with its log rather than burning the full budget.
	if ! kill -0 "$NGROK_PID" 2>/dev/null; then
		echo "FAIL: ngrok process exited before producing a URL (bad authtoken? rate-limited?)." >&2
		cat "$NGROK_LOG" >&2 || true
		exit 1
	fi
	url="$(ngrok_url)"
	if [[ -n "$url" ]]; then
		break
	fi
	sleep "$POLL_INTERVAL_S"
done
if [[ -z "$url" ]]; then
	echo "FAIL: no ngrok public URL from the inspector within ${URL_WAIT_S}s." >&2
	cat "$NGROK_LOG" >&2 || true
	exit 1
fi
echo "[test-tunnel-ngrok] tunnel URL: ${url}"

# --- probe the public URL until it actually routes ---------------------------
# Finding the URL in the inspector is NOT a proof the edge routes traffic yet
# (ngrok provisions fast, but a brief warm-up can precede the first 200). Poll
# `<url>/health` until it returns 200 — `probe_url` classifies each failure so a
# failed run says exactly what was wrong, instead of a blind timeout guess.
echo "[test-tunnel-ngrok] probing public URL until it routes (≤ ${ROUTE_WAIT_S}s)…"
routed=0
last_diag=""
deadline=$((SECONDS + ROUTE_WAIT_S))
while ((SECONDS < deadline)); do
	last_diag="$(probe_url "${url}/health" 2>/dev/null)"
	if [[ "$last_diag" == "OK" ]]; then
		routed=1
		break
	fi
	sleep "$POLL_INTERVAL_S"
done
if ((routed != 1)); then
	echo "FAIL: public URL ${url} never returned /health 200 within ${ROUTE_WAIT_S}s (last probe: ${last_diag}). DNS-FAIL ⇒ the host resolver isn't resolving the subdomain; HTTP-5xx ⇒ edge is up but the origin is unreachable through the tunnel; TIMEOUT ⇒ the edge stalled mid-handshake." >&2
	cat "$NGROK_LOG" >&2 || true
	exit 1
fi

# --- drive the runner through the PUBLIC url ---------------------------------
mcp_url="${url}/mcp"
echo "[test-tunnel-ngrok] retargeting runner at ${mcp_url}"
# Trust the explicit "ALL CHECKS PASSED" marker over tsx's exit code: tsx (node
# loader) has been observed to exit 0 even when the script calls process.exit(1),
# so the raw rc is an unreliable pass/fail signal. Capture + tee the output
# (identical to test-tunnel.sh).
set +e
MCP_URL="$mcp_url" MCP_TOKEN="$MCP_TOKEN" ./node_modules/.bin/tsx test/compose/run-e2e.ts 2>&1 | tee "$RUNNER_LOG"
set -e
if grep -q "ALL CHECKS PASSED" "$RUNNER_LOG"; then
	echo "[test-tunnel-ngrok] PASSED: tools/call round-tripped through ${url}"
	exit 0
fi
echo "[test-tunnel-ngrok] FAILED: runner did not report success against ${mcp_url}" >&2
exit 1
