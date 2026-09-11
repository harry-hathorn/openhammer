#!/usr/bin/env bash
# Tier-5 VM E2E — the gated `test:vm` tier (spec 27, the test-tunnel.sh recipe).
#
# Proves mode B (vm-as-surface) end to end on a provisioned box: the REAL server
# (`tsx src/main.ts`, MCP_VM_MODE=vm) boots a real QEMU guest, an MCP client round-
# trips tools through the guest (bash `uname -r` returns the GUEST kernel — the
# in-guest proof), and SIGINT tears everything down with no orphan qemu process and
# no leftover session dir. It can NEVER be hermetic (it boots a real guest), so it
# exits 0 (skip) unless ALL of:
#   1. OPENHAMMER_VM_E2E=1 is exported, AND
#   2. `qemu-system-x86_64` is on PATH, AND
#   3. `/dev/kvm` is writable, AND
#   4. a built golden manifest exists (`~/.openhammer/vm/images/golden-*/manifest.json`)
# are present — otherwise the hermetic trio would flake on a box missing any of them.
# Every unmet precondition is NAMED in the one skip line. The hermetic trio never sets
# OPENHAMMER_VM_E2E, so it only ever exercises the skip path (test/e2e-hermetic/
# vm-gate.test.ts); the gated path is the orchestrator's 27k manual run.
#
# The script's gate is the cheap pre-filter: the server's own fail-fatal preflight
# (src/vm/preflight.ts, 27c) re-judges every precondition with full rigor at boot —
# a gate pass that preflight then refuses surfaces as the one-line non-zero boot
# failure below (log tail printed), never as a silent skip.
#
# Orchestration:
#   - picks a free port, mints a unique MCP_VM_SESSION_ID, and spawns the real
#     server with MCP_VM_MODE=vm MCP_VM_PERSIST=discard (logs to a temp file);
#   - waits for the startup banner's one-time bearer token (printed after
#     `listen()` — it doubles as the bind signal; the boot.e2e extract pattern);
#   - polls the guest with a cheap `bash uname -r` tools/call until the sandbox
#     stops answering the actionable booting-err (server health ≠ VM health, so
#     /health alone proves nothing here);
#   - drives the existing SDK-client runner (test/compose/run-e2e.ts via
#     MCP_URL/MCP_TOKEN) — its real-server sweep is the read + bash round-trip;
#   - SIGINTs the server, waits for exit 0, then asserts: no orphan qemu process
#     (pgrep, settle-windowed) AND no leftover session dir. The no-leftover
#     assertion is honest ONLY because PERSIST=discard — the discard policy removes
#     the dir at stop (service.ts "persist=discard — the overlay dies with the
#     session"); `retain` keeps it by design (the recovery path), so the script
#     never runs under retain.
#   - any failure exits non-zero with the server log tail + the session artifacts
#     (serial log / qemu stderr / debug dir) printed for diagnosis.
set -euo pipefail

# --- gate (non-blocking; names EVERY unmet precondition) ----------------------
misses=()
if [[ "${OPENHAMMER_VM_E2E:-0}" != "1" ]]; then
	misses+=("OPENHAMMER_VM_E2E is not set to 1 (the VM E2E tier is opt-in)")
fi
if ! command -v qemu-system-x86_64 >/dev/null 2>&1; then
	misses+=("qemu-system-x86_64 is not on PATH (Arch: sudo pacman -S qemu-desktop)")
fi
# The shell-side cheap check for preflight's /dev/kvm R_OK|W_OK verdict — `-w` is
# the writable half; preflight re-judges both at boot (see the header).
if [[ ! -w /dev/kvm ]]; then
	misses+=("/dev/kvm is not writable (enable the kvm module, add yourself to the kvm group)")
fi
if ! compgen -G "$HOME/.openhammer/vm/images/golden-*/manifest.json" >/dev/null 2>&1; then
	misses+=("no built golden manifest under ${HOME}/.openhammer/vm/images (golden-*/manifest.json) — run: openhammer vm install && openhammer vm provision && openhammer vm snapshot")
fi
if ((${#misses[@]} > 0)); then
	joined="${misses[0]}"
	for ((i = 1; i < ${#misses[@]}; i++)); do joined+="; ${misses[$i]}"; done
	echo "skip: VM E2E preconditions unmet (${joined}) — the gated VM tier stays off the hermetic trio."
	exit 0
fi

# --- config ------------------------------------------------------------------
# Run from the repo root so tsx + test/compose/run-e2e.ts resolve regardless of cwd.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_DIR}"

TSX="./node_modules/.bin/tsx"
HOST_KERNEL="$(uname -r)"
# A fresh port per run: a live server on 3000 must not fail (or worse, be served by)
# this run. Free-port-then-bind has a tiny race — an EADDRINUSE boot failure exits
# through the fail path with the log tail, honestly.
PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
MCP_URL="http://127.0.0.1:${PORT}/mcp"
# Unique per run (session.ts's SESSION_ID_PATTERN: one safe path segment). Pinned
# + discard: the service uses the pinned id for THIS boot and removes the dir at
# stop — which is exactly what the no-leftover assertion below checks.
SESSION_ID="vm-e2e-$(date -u +%Y%m%dT%H%M%S)-$$"
SESSION_DIR="${HOME}/.openhammer/vm/sessions/${SESSION_ID}"

SERVER_WAIT_S=30    # banner token (post-listen) — a miss means the boot failed fast
VM_READY_WAIT_S=240 # the sandbox's own boot budget is 180 s; this adds poll slack
EXIT_WAIT_S=90      # SIGINT → exit 0 (ACPI powerdown + stop ladder + persist teardown)
ORPHAN_SETTLE_S=10  # grace for a just-reaped qemu before the no-orphan verdict
POLL_INTERVAL_S=5
WORK="$(mktemp -d "${TMPDIR:-/tmp}/openhammer-test-vm.XXXXXX")"
LOG="${WORK}/server.log"
RUNNER_LOG="${WORK}/runner.log"

# The child must NOT inherit config that would hijack the run: MCP_ROOT_DIR is
# reinterpreted as a GUEST path in vm mode (a host cwd would point the tools at a
# wrong inside-guest dir), and a stray MCP_VM_* (image/memory/…) would silently
# re-shape the boot. Everything else (HOME, PATH, MCP_AUTH_TOKEN) is inherited —
# the goldens live under the real HOME, and the banner prints whichever token is
# authoritative (a set MCP_AUTH_TOKEN included).
unset MCP_ROOT_DIR
for var in "${!MCP_VM_@}"; do unset "$var"; done

# --- teardown + failure reporting --------------------------------------------
cleanup() {
	if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
		echo "[test-vm] cleaning up: SIGINT to the server ($SERVER_PID)…" >&2
		kill -INT "$SERVER_PID" 2>/dev/null || true
		for ((i = 0; i < 15; i++)); do
			kill -0 "$SERVER_PID" 2>/dev/null || break
			sleep 1
		done
		if kill -0 "$SERVER_PID" 2>/dev/null; then
			kill -KILL "$SERVER_PID" 2>/dev/null || true
		fi
	fi
	if [[ "${OPENHAMMER_VM_E2E_KEEP:-0}" == "1" ]]; then
		echo "[test-vm] kept work dir (OPENHAMMER_VM_E2E_KEEP=1): ${WORK:-}" >&2
	elif [[ -n "${WORK:-}" ]]; then
		rm -rf "$WORK"
	fi
}
trap cleanup EXIT

# One failure shape: name the step, print the server log tail + any session
# artifacts (paths at minimum, tails where they exist), exit non-zero.
fail() {
	echo "FAIL: $*" >&2
	if [[ -f "$LOG" ]]; then
		echo "--- server log tail (${LOG}) ---" >&2
		tail -n 80 "$LOG" >&2 || true
	fi
	if [[ -d "$SESSION_DIR" ]]; then
		echo "--- session artifacts: ${SESSION_DIR} ---" >&2
		ls -la "$SESSION_DIR" >&2 || true
		for artifact in serial.log qemu.stderr; do
			if [[ -f "${SESSION_DIR}/${artifact}" ]]; then
				echo "--- ${artifact} (tail) ---" >&2
				tail -c 2048 "${SESSION_DIR}/${artifact}" >&2 || true
				echo >&2
			fi
		done
		if [[ -d "${SESSION_DIR}/debug" ]]; then
			echo "--- debug/ ---" >&2
			ls -la "${SESSION_DIR}/debug" >&2 || true
		fi
	fi
	if [[ -f "$RUNNER_LOG" ]]; then
		echo "--- runner log tail (${RUNNER_LOG}) ---" >&2
		tail -n 40 "$RUNNER_LOG" >&2 || true
	fi
	exit 1
}

# --- helpers (always exit 0 so `$(...)` is safe under set -e) ----------------
# The banner's one-time token: the line after "Bearer token", trimmed (the
# test/e2e-hermetic/boot.e2e.test.ts extractToken pattern, in awk).
banner_token() {
	awk '/Bearer token/ { if ((getline line) > 0) { gsub(/^[ \t]+/, "", line); print line; exit } }' "$1" 2>/dev/null || true
}

# One cheap MCP `bash` tools/call through the FULL stack (SDK Client over
# Streamable HTTP, the boot.e2e callBash pattern). ALWAYS exits 0 and prints a
# classified tag, so it is safe under `set -euo pipefail` inside `$()`:
#   OK:<text>                 — the call succeeded (the sandbox is READY)
#   BOOTING:<err text>        — the actionable booting-err ("sandbox booting, Xs of 180s")
#   TOOLERR:<err text>        — any other tool-level error (incl. the post-budget failed line)
#   FETCH:<cause>             — the server was unreachable (transport death / not listening)
vm_probe() {
	OH_PROBE_URL="${1}" OH_PROBE_TOKEN="${2}" OH_PROBE_CMD="${3}" node --input-type=module -e '
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const url = process.env.OH_PROBE_URL;
const token = process.env.OH_PROBE_TOKEN;
const command = process.env.OH_PROBE_CMD;
const ctrl = new AbortController();
const timer = setTimeout(() => ctrl.abort(), 10000);
const client = new Client({ name: "test-vm-probe", version: "0.0.0" }, { capabilities: {} });
const transport = new StreamableHTTPClientTransport(new URL(url), {
	requestInit: { headers: { authorization: `Bearer ${token}` } },
});
const finish = (tag) => { clearTimeout(timer); process.stdout.write(tag); process.exit(0); };
try {
	await client.connect(transport, { signal: ctrl.signal });
	const result = await client.callTool({ name: "bash", arguments: { command } }, undefined, { signal: ctrl.signal });
	const block = Array.isArray(result.content) ? result.content[0] : undefined;
	const text = block !== null && typeof block === "object" && "text" in block ? String(block.text) : "";
	if (result.isError === true) {
		finish(text.includes("sandbox booting") ? "BOOTING:" + text.slice(0, 100) : "TOOLERR:" + text.slice(0, 160));
	}
	finish("OK:" + text);
} catch (error) {
	const cause = error && error.cause ? (error.cause.code ?? error.cause.message) : String(error);
	finish("FETCH:" + String(cause).slice(0, 80));
}
'
}

# --- gated path begins --------------------------------------------------------
newest_golden="$(ls -1d "$HOME"/.openhammer/vm/images/golden-* 2>/dev/null | sort -r | head -n1 || true)"
echo "[test-vm] gate open — qemu-system-x86_64 on PATH, /dev/kvm writable, golden tree: ${newest_golden}"
echo "[test-vm] (the server picks the NEWEST golden by manifest builtAt; session id: ${SESSION_ID}, port: ${PORT})"

# --- boot the real server -----------------------------------------------------
PORT="$PORT" MCP_VM_MODE=vm MCP_VM_PERSIST=discard MCP_VM_SESSION_ID="$SESSION_ID" \
	"$TSX" src/main.ts >"$LOG" 2>&1 &
SERVER_PID=$!

echo "[test-vm] server booting (pid ${SERVER_PID}, log ${LOG}) — waiting for the banner token (≤ ${SERVER_WAIT_S}s)…"
token=""
deadline=$((SECONDS + SERVER_WAIT_S))
while ((SECONDS < deadline)); do
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		fail "server exited before serving — a preflight/config miss exits the one-line boot failure (log tail below)"
	fi
	token="$(banner_token "$LOG")"
	if [[ -n "$token" ]]; then break; fi
	sleep "$POLL_INTERVAL_S"
done
if [[ -z "$token" ]]; then
	fail "the startup banner (with the bearer token) never appeared within ${SERVER_WAIT_S}s"
fi
echo "[test-vm] server is listening (banner captured; /health is instant — VM readiness is polled next)"

# --- wait for VM readiness: poll the guest until the booting-err stops --------
echo "[test-vm] polling the guest with bash uname -r until the sandbox is ready (≤ ${VM_READY_WAIT_S}s)…"
guest_kernel=""
last_diag="(never probed)"
deadline=$((SECONDS + VM_READY_WAIT_S))
while ((SECONDS < deadline)); do
	if ! kill -0 "$SERVER_PID" 2>/dev/null; then
		fail "server exited while the sandbox was booting (last probe: ${last_diag})"
	fi
	last_diag="$(vm_probe "$MCP_URL" "$token" "uname -r")"
	case "$last_diag" in
		OK:*)
			guest_kernel="${last_diag#OK:}"
			break
			;;
		*boot*failed* | *"died again"*)
			fail "sandbox boot failed permanently (probe: ${last_diag})"
			;;
	esac
	sleep "$POLL_INTERVAL_S"
done
if [[ -z "$guest_kernel" ]]; then
	fail "the sandbox never became ready within ${VM_READY_WAIT_S}s (last probe: ${last_diag})"
fi
echo "[test-vm] sandbox READY after polling — bash uname -r answered: ${guest_kernel}"

# The in-guest proof: the kernel the tool executed under is NOT this host's.
if [[ "$guest_kernel" == "$HOST_KERNEL" ]]; then
	fail "bash uname -r returned the HOST kernel (${HOST_KERNEL}) — the call executed outside the guest, the VM wall did not hold"
fi

# --- drive the SDK-client runner (boot → read → bash round-trip) --------------
echo "[test-vm] driving test/compose/run-e2e.ts at ${MCP_URL} (the 8-tool real-server sweep)…"
set +e
MCP_URL="$MCP_URL" MCP_TOKEN="$token" "$TSX" test/compose/run-e2e.ts 2>&1 | tee "$RUNNER_LOG"
set -e
# Trust the "ALL CHECKS PASSED" marker over tsx's exit code (the test-tunnel
# finding: the tsx/node loader has exited 0 through a process.exit(1)).
if ! grep -q "ALL CHECKS PASSED" "$RUNNER_LOG"; then
	fail "the runner did not report success against ${MCP_URL}"
fi

# --- SIGINT: stop serving first, then the VM teardown; exit must be 0 ---------
echo "[test-vm] SIGINT → waiting for exit 0 (≤ ${EXIT_WAIT_S}s: ACPI powerdown + stop ladder + discard teardown)…"
kill -INT "$SERVER_PID"
deadline=$((SECONDS + EXIT_WAIT_S))
while kill -0 "$SERVER_PID" 2>/dev/null && ((SECONDS < deadline)); do
	sleep 1
done
if kill -0 "$SERVER_PID" 2>/dev/null; then
	fail "the server did not exit within ${EXIT_WAIT_S}s of SIGINT"
fi
set +e
wait "$SERVER_PID"
server_rc=$?
set -e
if [[ "$server_rc" -ne 0 ]]; then
	fail "the server exited ${server_rc} on SIGINT (want 0 — the clean-teardown contract)"
fi
echo "[test-vm] server exited 0"

# --- assertion 1: no orphan qemu (settle-windowed) ----------------------------
orphans=""
deadline=$((SECONDS + ORPHAN_SETTLE_S))
while ((SECONDS < deadline)); do
	orphans="$(pgrep -u "$(id -un)" -f qemu-system-x86_64 2>/dev/null || true)"
	if [[ -z "$orphans" ]]; then break; fi
	sleep 1
done
if [[ -n "$orphans" ]]; then
	echo "--- orphan qemu processes (ours) ---" >&2
	ps -fp $orphans >&2 || true
	fail "orphan qemu process(es) survived the teardown: $(echo $orphans | tr '\n' ' ')"
fi

# --- assertion 2: no leftover session dir --------------------------------------
# Honest ONLY because MCP_VM_PERSIST=discard: the discard policy removes the dir
# at stop; `retain` KEEPS it by design (the recovery path — service.ts), so this
# assertion would be wrong under retain.
if [[ -e "$SESSION_DIR" ]]; then
	fail "leftover session dir ${SESSION_DIR} — persist=discard must remove it at stop (retain keeps it by design; this run is discard)"
fi

echo "[test-vm] PASSED: boot → tools/call round-trip in the guest (kernel ${guest_kernel}) → clean SIGINT teardown (no orphan qemu, no leftover session dir)"
