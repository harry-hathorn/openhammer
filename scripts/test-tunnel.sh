#!/usr/bin/env bash
# Tier-4 tunnel E2E gate (spec 13/16).
#
# Non-blocking by design: the tunnel traverses Cloudflare's live edge, so it can
# never be hermetic. This script MUST exit 0 (skip) unless BOTH:
#   1. OPENHAMMER_TUNNEL_E2E=1 is exported, AND
#   2. `cloudflared` is on PATH
# are present — otherwise the hermetic trio would flake on a box without the
# binary or the opt-in flag.
#
# The full orchestration (real `server` + `cloudflared` quick-tunnel on the
# compose `tunnel` profile, parse the https://*.trycloudflare.com URL from
# stderr, retarget the SDK-client runner at the public URL) lands with task
# T-tunnel-e2e. Until then the "both-present" branch is a documented no-op.
set -euo pipefail

if [[ "${OPENHAMMER_TUNNEL_E2E:-0}" != "1" ]]; then
	echo "skip: OPENHAMMER_TUNNEL_E2E is not set to 1 (tunnel E2E is opt-in)."
	exit 0
fi

if ! command -v cloudflared >/dev/null 2>&1; then
	echo "skip: cloudflared is not on PATH (tunnel E2E requires it)."
	exit 0
fi

# Gate passed. Orchestration (compose `tunnel` profile) ships with T-tunnel-e2e.
echo "pending: tunnel E2E orchestration lands with task T-tunnel-e2e (spec 13)."
exit 0
