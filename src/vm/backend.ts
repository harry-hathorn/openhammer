// VmBackend — spec 25c: the ToolBackend whose every op runs INSIDE the QEMU guest, over 25a's
// ssh transport (sshExec/sshCloseMux) and 25b's ssh FsBackend (createSshFs, embedded as `fs`).
// Tool bodies are untouched: `kind: "vm"` swaps the execution target from the host user to
// /home/<guestUser> in the sandbox image, and every cap and the MAX_RESPONSE_BYTES backstop keep
// working because the guest stream still flows through the host-side OutputAccumulator the tools
// already own — spec 25's parity requirement, proven in backend.test.ts by driving the bash
// tool's own 23e FakeBackend fixtures against this backend over a scripted fake sshExec.
//
// THE WRAPPER (runShell) — ONE sshExec whose remote argv is
// ["bash", "-c", RUN_SHELL_SCRIPT, "bash", cwd, timeoutSec, cmd, overflowPath]:
//
//   cd -- "$1" || exit 125
//   set -a; [ ! -f ~/.openhammer/env ] || . ~/.openhammer/env; set +a
//   set -o pipefail
//   mkdir -p -- "$(dirname -- "$4")"
//   exec timeout -k 5 "$2"s bash -c "$3" 2>&1 | tee -- "$4"
//
// Slot table ($0 is the name operand "bash", cosmetic): $1 = cwd, $2 = timeout seconds, $3 = the
// user's command string, $4 = the guest overflow path. Every rider is an argv element that
// remoteQuote delivers as ONE quoted word — nothing is ever spliced into the script text, which
// is a compile-time constant. The one sanctioned shell-string use is `bash -c "$3"` itself: the
// bash tool's input IS a shell string (LocalBackend runs it through `bash -c` too); the slot
// guarantees it arrives verbatim as a single argument to that inner bash, never re-parsed by
// this wrapper. Line by line:
//
// - `cd -- "$1" || exit 125` — the cwd; 125 (timeout's own "wrapper failed" code) marks a
//   wrapper-environment failure, distinct from any command exit. Mostly defensive: bash.ts
//   prechecks fs.exists(rootDir) before calling.
// - the env prefix — 22-measured gate 4 / finding 11: plain non-interactive ssh sees NOTHING
//   from ~/.openhammer/env, so prefix-sourcing it is the ONLY context that works for
//   `ssh host cmd` (environment.d is the graphical/user-manager complement, spec 29 owns the
//   file). `set -a` exports plain KEY=value lines while sourcing; the `[ ! -f … ] ||` guard
//   keeps a not-yet-provisioned guest silent instead of emitting sourcing errors into the
//   merged stream. `~` expands in the GUEST (remoteQuote single-quotes the script verbatim;
//   bash performs the tilde expansion guest-side).
// - `set -o pipefail` — the pipeline below reports timeout's/the command's status, not tee's 0.
// - `mkdir -p -- "$(dirname -- "$4")"` — tee cannot create the overflow dir; without this, a
//   fresh guest's missing /tmp/.openhammer would make EVERY command exit 1 via tee's failure
//   under pipefail. Idempotent, ~free.
// - `exec timeout -k 5 "$2"s bash -c "$3" 2>&1 | tee -- "$4"` — the whole reason this wrapper
//   exists. Killing the ssh client does NOT kill a remote non-PTY child (spec 25's sshd-orphan
//   note), so the kill story lives GUEST-side: `timeout` runs the command in its own process
//   group, TERMs at $2 seconds, and KILLs 5 s later (`-k 5`). `2>&1` merges stderr into the
//   pipe guest-side — one stream, true write order — so sshExec's onChunk delivers the same
//   merged-arrival contract LocalBackend's two-pipe merge gives locally. tee duplicates that
//   stream: stdout rides the ssh channel to the host accumulator (caps apply unchanged,
//   host-side), the file at $4 is the GUEST overflow copy the bash tool's "Full output:" footer
//   will name — fetchable via `read`, fixing host-tmpdir footer semantics (footer wiring is
//   spec 27/29's concern; this box only guarantees the file exists guest-side).
//
// ALWAYS-WRAPPED TIMEOUT: LocalBackend arms no timer when `timeoutSec` is undefined; here the
// wrapper still runs, with a LONG ceiling (GUEST_TIMEOUT_CEILING_SEC = 24 h). Without it, an
// untimed command orphaned by a dead ssh client would run in the guest FOREVER; with it, the
// guest guarantees eventual death. `timeoutSec <= 0` also falls to the ceiling (LocalBackend's
// `> 0` gate — never a zero-second kill).
//
// EXIT-CODE MAPPINGS (documented, tested):
// - guest rc N (0, 3, 127, …) → `{ exitCode: N, timedOut: false }` — the caller judges.
// - rc 124 → `{ exitCode: -1, timedOut: true }` — timeout(1)'s timed-out code, TERM and
//   post-`-k` KILL alike; -1 (not 124) is LocalBackend's timeout shape, so the bash tool's
//   "Command timed out after N seconds" text is byte-identical cross-backend. Known ambiguity,
//   inherent to wrapping: a command that exits 124 ON ITS OWN is indistinguishable from a
//   timeout (GNU timeout's own wart) — reported as a timeout, the safe reading.
// - rc 255 → REJECTS with the actionable error naming the serial log (spec 25's edge case: the
//   mux client exits 255 when the master/guest dies mid-command). Relaunch policy is spec 27's,
//   never this layer. The ssh wart that a guest command exiting 255 is indistinguishable is
//   accepted: the serial-log pointer is the actionable reading either way.
// - rc -1 (the ssh client itself signal-died) → passes through `{ exitCode: -1, timedOut:
//   false }` — LocalBackend's signal-death shape.
// - Known, unavoidable divergence: the wrapper's slots are visible to the command ($1 = cwd,
//   $2 = timeout, $4 = overflow; locally positional params are empty). Commands reading $1..$4
//   are exotic; the alternative — splicing values into the script text — is a non-starter.
//
// THE ARGV TWIN (runArgv) — same discipline, no shell string for the operands:
// ["bash", "-c", RUN_ARGV_SCRIPT, bin, cwd, timeoutSec, ...args] with
//
//   cd -- "$1" || exit 125
//   t="$2"s
//   shift 2
//   exec timeout -k 5 "$t" "$0" "$@"
//
// $0 = bin (the name operand), $1/$2 = cwd/timeout (shifted away), then "$@" IS the caller's
// args — each an argv element remoteQuote delivered whole, `exec` replaces the shell so the
// binary sees EXACTLY its argv (no re-parse, no merge). Streams stay SPLIT (no 2>&1): rg's
// NDJSON needs stdout alone. `signal` abort resolves `{ exitCode: -1, timedOut: false }`
// immediately (grep's match-cap kill) WITHOUT killing anything host-side — killing ssh cannot
// kill the remote child; forwarding stops and the guest-side ceiling bounds the orphan.
//
// PROBES are SYNCHRONOUS (the interface demands boolean): a spawnSync over the same pinned
// argv (the mux makes it ~ms). probe = `command -v <bin>` (spec 25: resolution, deliberately
// not LocalBackend's `--version` exec check); probeFlag = `<bin> <flag> --help`. Both cached
// per instance in LocalBackend's exact Map shape; rc 255 (dead guest) reads as absent.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { FsBackend, ShellResult, ToolBackend } from "../tools/backend.ts";
import { createSshFs } from "./fs-ssh.ts";
import type { QmpClient } from "./qmp/client.ts";
import { type SshExecResult, type SshTarget, sshCloseMux, sshExec, sshExecArgv, sshTargetForPort } from "./ssh.ts";
import { discoverSshPort } from "./usernet.ts";

/**
 * The ceiling every wrapped command runs under when the caller gave no `timeoutSec` (or a
 * non-positive one): 24 h, long enough to be operationally "no timeout", finite enough that a
 * channel-killed orphan still dies guest-side (the always-wrapped decision — see the header).
 */
export const GUEST_TIMEOUT_CEILING_SEC = 86400;

/** Default guest overflow dir (spec 25's `/tmp/.openhammer/<hex>.log`); overridable per spec. */
export const DEFAULT_GUEST_OVERFLOW_DIR = "/tmp/.openhammer";

/** The runShell wrapper — a compile-time constant; every variable rides an argv slot. */
const RUN_SHELL_SCRIPT = [
	'cd -- "$1" || exit 125',
	"set -a; [ ! -f ~/.openhammer/env ] || . ~/.openhammer/env; set +a",
	"set -o pipefail",
	'mkdir -p -- "$(dirname -- "$4")"',
	'exec timeout -k 5 "$2"s bash -c "$3" 2>&1 | tee -- "$4"',
].join("\n");

/** The runArgv twin — bin rides $0, metadata rides $1/$2 (shifted away), args ride "$@". */
const RUN_ARGV_SCRIPT = ['cd -- "$1" || exit 125', 't="$2"s', "shift 2", 'exec timeout -k 5 "$t" "$0" "$@"'].join("\n");

/** probe's script: does the bin resolve in the GUEST's PATH (spec 25's `command -v`). */
const PROBE_SCRIPT = 'command -v "$1"';

/** probeFlag's script: does this bin build accept the flag (LocalBackend's --help probe). */
const PROBE_FLAG_SCRIPT = 'exec "$0" "$1" --help';

/** Bound on the synchronous probe spawn — a hung guest must not freeze the event loop forever. */
const PROBE_SYNC_TIMEOUT_MS = 30_000;

/** The synchronous probe seam: run remoteArgv guest-side, return the exit code (-1 = no code). */
export type VmExecSync = (target: SshTarget, remoteArgv: readonly string[]) => number;

// The production probe exec: the same pinned, muxed argv sshExec builds (gate 7's ~7 ms warm
// ops), run synchronously because ToolBackend.probe is a boolean. stdio "ignore" discards the
// command -v path / --help noise; node's spawnSync timeout bounds a hung guest (killing the ssh
// CLIENT is safe here — the probe has no remote side effects worth orphaning).
const execSyncDefault: VmExecSync = (target, remoteArgv) => {
	const argv = sshExecArgv(target, remoteArgv);
	const result = spawnSync(argv[0], argv.slice(1), {
		env: process.env,
		stdio: "ignore",
		timeout: PROBE_SYNC_TIMEOUT_MS,
		windowsHide: true,
	});
	return result.status ?? -1;
};

/** What a VmBackend is built from: the transport target plus the guest facts the tools ask about. */
export interface VmBackendSpec {
	readonly target: SshTarget;
	/** The manifest's guestUser — homedir() derives from it, never from the host. */
	readonly guestUser: string;
	/** Guest home override; default `/home/<guestUser>`. */
	readonly guestHome?: string;
	/** Host-side path of the VM's serial log — named in the transport-death error (actionable). */
	readonly serialLogPath: string;
	/** Guest overflow dir for tee'd runShell output; default {@link DEFAULT_GUEST_OVERFLOW_DIR}. */
	readonly overflowDir?: string;
}

/** Injectable seams (the qemu/process.ts injection-arg precedent: the production call shape stays clean). */
export interface VmBackendDeps {
	/** Override the async transport exec (runShell/runArgv/fs). Default: the real muxed sshExec. */
	readonly exec?: typeof sshExec;
	/** Override the synchronous probe exec. Default: spawnSync over the same pinned argv. */
	readonly execSync?: VmExecSync;
	/** Override the mux teardown. Default: the real sshCloseMux. */
	readonly closeMux?: typeof sshCloseMux;
}

/** LocalBackend's `> 0` gate, with the always-wrapped ceiling as the fallback (see the header). */
function guestTimeoutSec(timeoutSec: number | undefined): number {
	return timeoutSec !== undefined && timeoutSec > 0 ? timeoutSec : GUEST_TIMEOUT_CEILING_SEC;
}

/**
 * The ToolBackend against one QEMU guest (spec 25c). One instance per session: it shares 25a's
 * ControlMaster via `spec.target`, embeds 25b's ssh FsBackend, and caches probes for its
 * lifetime — `close()` tears the mux down.
 */
export class VmBackend implements ToolBackend {
	readonly kind: "vm" = "vm";

	private readonly spec: VmBackendSpec;
	private readonly guestHome: string;
	private readonly overflowDir: string;
	private readonly exec: typeof sshExec;
	private readonly execSync: VmExecSync;
	private readonly closeMux: typeof sshCloseMux;
	private closed = false;

	/**
	 * Per-instance probe results, LocalBackend's exact cache shape (spec 23): `probe` keys are
	 * the bare bin, `probeFlag` keys are `"<bin> <flag>"` — the keyspaces cannot collide.
	 */
	private readonly probeCache = new Map<string, boolean>();

	readonly fs: FsBackend;

	constructor(spec: VmBackendSpec, deps: VmBackendDeps = {}) {
		this.spec = spec;
		this.guestHome = spec.guestHome ?? `/home/${spec.guestUser}`;
		this.overflowDir = spec.overflowDir ?? DEFAULT_GUEST_OVERFLOW_DIR;
		this.exec = deps.exec ?? sshExec;
		this.execSync = deps.execSync ?? execSyncDefault;
		this.closeMux = deps.closeMux ?? sshCloseMux;
		// The fs rides the SAME injected exec seam so one fake scripts both fs ops and spawns.
		this.fs = createSshFs(spec.target, deps.exec === undefined ? {} : { exec: deps.exec });
	}

	/**
	 * The GUEST home, derived from the manifest's guestUser — never `os.homedir()` (spec 25's
	 * edge case: `~` expands in the guest, so the tools' home-relative paths must name the
	 * guest's home, not the host user's).
	 */
	homedir(): string {
		return this.guestHome;
	}

	/**
	 * Run one shell command in the guest, wrapped per the module header: env prefix, guest-side
	 * `timeout -k 5`, merged `2>&1` stream tee'd to a guest overflow file. `opts.onChunk`
	 * receives the guest-merged stream in arrival order (sshExec's onChunk, wired straight
	 * through). The tee target is minted HERE — the ToolBackend interface threads no path into
	 * runShell — as a fresh `overflowPath("openhammer")`; bash.ts's accumulator mints its own
	 * (different) path for the host-side spill, and reconciling the two (one fetchable footer
	 * file) is spec 27/29's rewiring. Resolution per the header's exit-code table; rejects only
	 * on rc 255 (transport death, serial log named) or a spawn error.
	 */
	async runShell(
		cmd: string,
		opts: { cwd: string; timeoutSec?: number; onChunk?: (b: Buffer) => void },
	): Promise<ShellResult> {
		const timeoutSec = guestTimeoutSec(opts.timeoutSec);
		const overflow = this.overflowPath("openhammer");
		const result = await this.exec(
			this.spec.target,
			["bash", "-c", RUN_SHELL_SCRIPT, "bash", opts.cwd, String(timeoutSec), cmd, overflow],
			{ onChunk: opts.onChunk, timeoutSec }, // sshExec ignores timeoutSec; the wrapper owns it
		);
		if (result.exitCode === 255) throw this.transportDeath(result);
		if (result.exitCode === 124) return { exitCode: -1, timedOut: true };
		return { exitCode: result.exitCode, timedOut: false };
	}

	/**
	 * Run `bin` with an argument array in the guest — runShell's hygiene-preserving twin: the
	 * operands ride argv slots (bin as the script's `$0`, args as `$@` after the metadata
	 * slots are shifted away), so a pattern with spaces, quotes, `$()`, newlines or a leading
	 * `-` arrives as EXACTLY the argv element the caller passed — no shell re-parse anywhere
	 * (25a's remoteQuote closes the transport half; `exec`-replacement closes the guest half).
	 * Streams stay split (`onStdout`/`onStderr`); `cwd` defaults to the guest home (sshd's own
	 * start-in-home — the argv tools pass no cwd today). Same timeout wrapper (ceiling when
	 * untimed), same 124/255 mappings as runShell. `opts.signal` abort resolves
	 * `{ exitCode: -1, timedOut: false }` immediately — aborted is not timed out — without a
	 * host-side kill (killing ssh cannot kill the remote child): forwarding stops, the drained
	 * exec's eventual outcome is swallowed, and the guest-side ceiling bounds the orphan.
	 */
	runArgv(
		bin: string,
		args: readonly string[],
		opts: {
			cwd?: string;
			timeoutSec?: number;
			signal?: AbortSignal;
			onStdout?: (b: Buffer) => void;
			onStderr?: (b: Buffer) => void;
		},
	): Promise<ShellResult> {
		const signal = opts.signal;
		if (signal?.aborted) {
			// Aborted before anything spawned: nothing to kill, nothing orphaned.
			return Promise.resolve({ exitCode: -1, timedOut: false });
		}
		const timeoutSec = guestTimeoutSec(opts.timeoutSec);
		const remoteArgv = ["bash", "-c", RUN_ARGV_SCRIPT, bin, opts.cwd ?? this.guestHome, String(timeoutSec), ...args];
		let aborted = false;
		const gate = (cb?: (b: Buffer) => void): ((b: Buffer) => void) | undefined =>
			cb === undefined
				? undefined
				: (b) => {
						if (!aborted) cb(b);
					};
		const outcome = this.exec(this.spec.target, remoteArgv, {
			timeoutSec, // sshExec ignores it; the wrapper's slot carries it (see the header)
			onStdout: gate(opts.onStdout),
			onStderr: gate(opts.onStderr),
		}).then((result) => {
			if (result.exitCode === 255) throw this.transportDeath(result);
			if (result.exitCode === 124) return { exitCode: -1, timedOut: true };
			return { exitCode: result.exitCode, timedOut: false };
		});
		if (signal === undefined) return outcome;
		return new Promise<ShellResult>((resolve, reject) => {
			const onAbort = () => {
				aborted = true;
				resolve({ exitCode: -1, timedOut: false });
				// The ssh exec keeps draining (forwarding gated off) until the guest-side wrapper
				// reaps the remote; its eventual outcome — a 255 rejection included — is moot now
				// and must not surface as unhandled.
				void outcome.catch(() => {
					// deliberately swallowed: the caller already resolved via the abort
				});
			};
			signal.addEventListener("abort", onAbort, { once: true });
			void outcome.then(
				(result) => {
					signal.removeEventListener("abort", onAbort);
					resolve(result);
				},
				(error) => {
					signal.removeEventListener("abort", onAbort);
					reject(error);
				},
			);
		});
	}

	/**
	 * Whether `bin` resolves in the GUEST's PATH (`command -v` over the sync ssh seam — spec
	 * 25's probe; deliberately resolution-only, not LocalBackend's `--version` exec check).
	 * Synchronous on purpose (the interface's contract); the mux makes it ~ms. rc 255 (dead
	 * guest) reads as absent — the safe direction. Results cached per instance.
	 */
	probe(bin: string): boolean {
		const cached = this.probeCache.get(bin);
		if (cached !== undefined) return cached;
		const supported = this.execSync(this.spec.target, ["bash", "-c", PROBE_SCRIPT, "probe", bin]) === 0;
		this.probeCache.set(bin, supported);
		return supported;
	}

	/**
	 * Whether this guest's `bin` build accepts `flag` (`<bin> <flag> --help` exits 0) —
	 * LocalBackend's probeFlag over the sync ssh seam; cached per instance under
	 * `"<bin> <flag>"`.
	 */
	probeFlag(bin: string, flag: string): boolean {
		const key = `${bin} ${flag}`;
		const cached = this.probeCache.get(key);
		if (cached !== undefined) return cached;
		const supported = this.execSync(this.spec.target, ["bash", "-c", PROBE_FLAG_SCRIPT, bin, flag]) === 0;
		this.probeCache.set(key, supported);
		return supported;
	}

	/**
	 * A fresh unique GUEST path for tee'd overflow: `<overflowDir>/<prefix>-<8 random hex
	 * bytes>.log` — LocalBackend's exact path shape, relocated to the guest (spec 25: the
	 * "Full output:" footer must name a path `read` can fetch, which in VM mode is a guest
	 * path). Creates nothing host-side; the guest-side `mkdir -p` + `tee` in the runShell
	 * wrapper materialize it (empty for silent commands — cleanup of the dir is the session
	 * layer's concern, spec 27).
	 */
	overflowPath(prefix: string): string {
		const id = randomBytes(8).toString("hex");
		return `${this.overflowDir}/${prefix}-${id}.log`;
	}

	/**
	 * Tear the session down: kill the ControlMaster (`sshCloseMux` — a dead guest cannot hang
	 * it) and drop the probe cache. Idempotent; a second call is a no-op. Propagates a spawn
	 * error from the teardown itself (the one genuine-throw path); a master that was already
	 * gone resolves false inside sshCloseMux and is fine here.
	 */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.probeCache.clear();
		await this.closeMux(this.spec.target);
	}

	/** The actionable transport-death error (rc 255): names the serial log, per spec 25. */
	private transportDeath(result: SshExecResult): Error {
		const detail = result.stderrTail.trim();
		const reason = detail === "" ? "no ssh stderr captured" : detail;
		return new Error(
			`ssh transport died (exit 255; the guest is unreachable or the connection was lost): ${reason}; see the VM serial log: ${this.spec.serialLogPath}`,
		);
	}
}

/** Construct the guest backend (factory style, matching `createLocalBackend`). */
export function createVmBackend(spec: VmBackendSpec, deps: VmBackendDeps = {}): VmBackend {
	return new VmBackend(spec, deps);
}

/**
 * A {@link VmBackendSpec} whose target lacks exactly the port: everything a session layer
 * knows at build time, minus the one fact that only exists after QEMU is up (25d's discovery
 * supplies it).
 */
export type VmBackendPendingSpec = Omit<VmBackendSpec, "target"> & { target: Omit<SshTarget, "port"> };

/** createVmBackendFromQmp's seams: {@link VmBackendDeps} threaded through, plus the discovery override. */
export interface VmBackendFromQmpDeps extends VmBackendDeps {
	/** Override the port discovery. Default: {@link discoverSshPort} over the passed qmp. */
	readonly discover?: typeof discoverSshPort;
}

/**
 * The connection factory the session layer consumes (spec 25d's wiring): discover the
 * slirp-assigned ephemeral port over the LIVE QMP connection (`discoverSshPort` — poll
 * `info usernet` until the hostfwd row parses), complete the target with it
 * (`sshTargetForPort`), and build the {@link VmBackend}. The spec deliberately takes a
 * port-LESS target, so a caller cannot smuggle in a stale port — production always learns it
 * here from the guest that is actually running (a fixed `MCP_VM_SSH_PORT` is a manual-debug
 * escape hatch, never this path). Rejects with discovery's actionable error when the netdev
 * never answers; everything else is createVmBackend's.
 */
export async function createVmBackendFromQmp(
	spec: VmBackendPendingSpec,
	qmp: Pick<QmpClient, "humanMonitorCommand">,
	deps: VmBackendFromQmpDeps = {},
): Promise<VmBackend> {
	const port = await (deps.discover ?? discoverSshPort)(qmp);
	return createVmBackend({ ...spec, target: sshTargetForPort(spec.target, port) }, deps);
}
