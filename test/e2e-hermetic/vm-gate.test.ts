/**
 * `test:vm` skip-logic unit (spec 27's gated tier, the test-tunnel.sh recipe).
 * Runs `scripts/test-vm.sh` as a subprocess under manipulated conditions and
 * asserts the GATE stays closed: every missing precondition is NAMED on the one
 * skip line and the exit code is 0 — the hermetic trio can never fail on (or
 * open) the gated VM path. The gate-OPEN path is deliberately NOT exercised
 * here (it would boot a real QEMU guest): the orchestrator's 27k manual run
 * drives it on a provisioned box.
 *
 * The hermetic lock: every subprocess gets HOME pointed at an EMPTY temp dir
 * (no golden manifest can exist under it), so the golden precondition always
 * misses — even on a KVM box with qemu installed, the gate cannot fully open
 * inside the trio. Each run executes only bash builtins on the skip path and
 * finishes well under 2 s (asserted).
 */
import { spawnSync } from "node:child_process";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../scripts/test-vm.sh", import.meta.url));

/** Host writability of /dev/kvm — the one precondition a test cannot fake away. */
function kvmWritable(): boolean {
	try {
		accessSync("/dev/kvm", constants.W_OK);
		return true;
	} catch {
		return false;
	}
}

interface GateRun {
	readonly status: number;
	readonly stdout: string;
	readonly ms: number;
}

/**
 * Run the gate under a curated env. `overrides` win over the runner env, except
 * the keys every run must control itself (the E2E opt-in, and — hygiene — the
 * MCP_VM_* surface the script's gated path sets, which the gate never reads).
 * HOME is ALWAYS an empty temp dir: the lock that keeps the gate closable in
 * the trio (see the module header). `/bin/bash` absolute so an overridden PATH
 * cannot break the lookup.
 */
function runGate(overrides: NodeJS.ProcessEnv): GateRun {
	const env: NodeJS.ProcessEnv = { ...process.env, ...overrides };
	delete env.OPENHAMMER_VM_E2E;
	delete env.MCP_VM_MODE;
	delete env.MCP_VM_PERSIST;
	delete env.MCP_VM_SESSION_ID;
	const home = mkdtempSync(join(tmpdir(), "oh-vm-gate-home-"));
	env.HOME = home;
	const started = Date.now();
	// The 10 s timeout is a hang guard only; the skip path is builtins-only and
	// every assertion below pins the observed runtime to < 2 s.
	const result = spawnSync("/bin/bash", [SCRIPT], { env, encoding: "utf8", timeout: 10_000 });
	const ms = Date.now() - started;
	rmSync(home, { recursive: true, force: true });
	if (result.error !== undefined) throw result.error;
	return { status: result.status ?? -1, stdout: result.stdout ?? "", ms };
}

describe("test:vm gate — skip path (the trio's only exposure)", () => {
	it("no OPENHAMMER_VM_E2E → exit 0, the skip line names it", () => {
		const run = runGate({});
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("skip:");
		expect(run.stdout).toContain("OPENHAMMER_VM_E2E");
		expect(run.ms).toBeLessThan(2000);
	});

	it("E2E set but PATH without qemu-system-x86_64 → exit 0, the skip line names the binary", () => {
		const run = runGate({ OPENHAMMER_VM_E2E: "1", PATH: "" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("skip:");
		expect(run.stdout).toContain("qemu-system-x86_64");
	});

	it("E2E set (real PATH) but no golden under the fake HOME → exit 0, the skip line names the golden tree", () => {
		const run = runGate({ OPENHAMMER_VM_E2E: "1" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("skip:");
		expect(run.stdout).toContain(".openhammer/vm/images");
	});

	it("collects EVERY unmet precondition in the one skip line, not just the first", () => {
		const run = runGate({ OPENHAMMER_VM_E2E: "1", PATH: "" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("qemu-system-x86_64");
		expect(run.stdout).toContain(".openhammer/vm/images");
		expect(run.ms).toBeLessThan(2000);
	});

	// A writable /dev/kvm cannot be faked absent, so the /dev/kvm miss is only
	// assertable on boxes where it is genuinely unwritable (bare CI) — the
	// boot.e2e skipIf precedent (its cloudflared-absent slice).
	it.skipIf(kvmWritable())("E2E set, kvm unwritable → exit 0, the skip line names /dev/kvm", () => {
		const run = runGate({ OPENHAMMER_VM_E2E: "1", PATH: "" });
		expect(run.status).toBe(0);
		expect(run.stdout).toContain("skip:");
		expect(run.stdout).toContain("/dev/kvm");
	});
});
