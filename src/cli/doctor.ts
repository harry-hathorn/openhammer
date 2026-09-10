/**
 * The `openhammer doctor` command + its built-in checks (spec 17p).
 *
 * `doctor` runs the diagnostics registry's checks plus one dynamic check per
 * configured channel, and prints the results grouped by status (fail first, then
 * warn, then pass). The built-in checks probe the install: `config.json` parses
 * and is a valid settings doc; each `Settings.channels` entry's provider is
 * `isAvailable` (live — binary/secret present) or `probe`-reachable (static — the
 * operator's declared endpoint answers `/health`); `credentials.json` is
 * owner-only (`0600`); the OAuth `jwtSecret` is set (`OAUTH_JWT_SECRET` env or
 * persisted — minted on first use, so absent is a `warn`, not a `fail`);
 * `rg`/`fd` are on `PATH`. The **vm family** (spec 27d) — `vm-preflight`,
 * `vm-golden`, `vm-ram`, `vm-footprint`, `vm-root` — rides the same registry with
 * **dynamic presence**: each carries a `present()` evaluated at RUN time (never
 * baked at registration — the Batch-0 lazy-path lesson), and an absent check drops
 * out of the report entirely (no row, no count), so the default `off`-mode install
 * with no golden sees exactly the five built-ins and nothing new (spec 28's
 * invisibility starts here). Each check is isolated
 * ({@link safeRun} turns a throw into a `fail`), so `doctor` never throws.
 *
 * **Self-registration.** The built-in checks register into the global
 * {@link DIAGNOSTICS} registry at this module's load, mirroring how the channel
 * providers register into `CHANNELS` at `tunnel/index.ts` load. This is the
 * TDZ-safe shape, **not** the trap the 17g note flags: `doctor.ts → registry.ts`
 * is one-directional (registry.ts imports nothing), so registry.ts fully
 * initializes `DIAGNOSTICS` before this module's top-level code runs — there is
 * no side-effect `import` hoisted above a `const` in the *same* module (the
 * 17g hazard). `doctorCommand` therefore reads `getDiagnostics()` and sees the
 * built-ins in production.
 *
 * **Hermeticity — injection-arg precedent.** Every external touch (paths,
 * `getChannel`, `getCredentials`, `isToolAvailable`, the static check set) is an
 * injectable dep, so the unit tests exercise each check + `runDiagnostics` +
 * `doctorCommand` against temp paths and fakes without touching the real
 * `~/.openhammer` or `PATH` (the `11a`/`13`/`17b`–`17m` precedent).
 *
 * **Exit code.** `1` if any check `fail`s (a real problem — lets CI/scripts
 * gate on `doctor`); `0` otherwise. A `warn` is advisory and does not fail the
 * command (the install still works).
 */
import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { peekJwtSecret } from "../auth/oauth/clients.ts";
import { type CredentialValues, credentialsPath, getCredentials } from "../config/credentials.ts";
import { type ChannelEntry, loadSettings, normalizeSettings, type Settings, settingsPath } from "../config/settings.ts";
import { type ResolvedConfig, resolveConfig } from "../config.ts";
import {
	type DiagnosticCheck,
	type DiagnosticResult,
	type DiagnosticStatus,
	getDiagnostics,
	registerDiagnostic,
} from "../diagnostics/registry.ts";
import { isToolAvailable } from "../tools/bin.ts";
import type { BannerStream } from "../tui/banner.ts";
import { type ChannelProvider, getChannel } from "../tunnel/index.ts";
import { type PreflightDeps, vmPreflight } from "../vm/preflight.ts";
import { loadGuestConfig } from "../vm/provision/guest-config.ts";
import { type DuOf, type GoldenSummary, vmList } from "../vm/provision/manage.ts";
import { resolveVmDirs } from "../vm/session.ts";

/** Narrow an unknown catch value to its message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Wrap a check's `run` so a thrown error becomes a `fail` result. A check should
 * return its own `fail` rather than throw, but the safety net keeps one buggy
 * check from aborting the whole `doctor` run — every check is isolated.
 */
async function safeRun(check: DiagnosticCheck): Promise<DiagnosticResult> {
	try {
		return await check.run();
	} catch (e) {
		return { status: "fail", message: `${check.id} check threw: ${messageOf(e)}` };
	}
}

/** Where {@link doctorCommand} writes — a structural slice of the CLI's `CommandIo` (avoids a `cli.ts` import cycle). */
export interface DoctorIo {
	stdout: BannerStream;
}

/** One check's outcome paired with its id, for grouped printing. */
export interface DiagnosticReport {
	id: string;
	result: DiagnosticResult;
}

/**
 * The `config.json` check: the file is valid JSON **and** a valid {@link Settings}
 * doc. Absent → `pass` (defaults are fine); present-but-unparseable or
 * structurally invalid → `fail`. `loadSettings` hides corruption behind safe
 * defaults; this check surfaces it (via {@link normalizeSettings}, the
 * single-source validator).
 */
export function createConfigCheck(path?: string): DiagnosticCheck {
	return {
		id: "config",
		run: async () => {
			// Resolve the default lazily: the registry self-registers these checks at
			// module load, and a load-time `settingsPath()` default would freeze the
			// importing process's HOME into the closure (breaking HOME-isolated tests
			// on any machine that has a real ~/.openhammer).
			const target = path ?? settingsPath();
			if (!existsSync(target)) return { status: "pass", message: "config.json absent (using defaults)" };
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(target, "utf-8"));
			} catch (e) {
				return { status: "fail", message: `config.json is not valid JSON: ${messageOf(e)}` };
			}
			return normalizeSettings(parsed) !== null
				? { status: "pass", message: "config.json is a valid settings document" }
				: { status: "fail", message: "config.json is not a valid settings document" };
		},
	};
}

/**
 * The `credentials.json` perms check: when present, the secrets file is
 * owner-only (`0600`). Absent → `pass` (no secrets stored yet); too-open → `warn`
 * (the install still works, but secrets are group/other-readable — fix with
 * `chmod 600`). A secrets-file perm drift is advisory, not a hard failure.
 */
export function createCredentialsCheck(path?: string): DiagnosticCheck {
	return {
		id: "credentials",
		run: async () => {
			// Lazy default for the same registry-bakes-at-load reason as createConfigCheck.
			const target = path ?? credentialsPath();
			if (!existsSync(target)) return { status: "pass", message: "credentials.json absent (no secrets stored)" };
			const mode = statSync(target).mode & 0o777;
			if (mode === 0o600) return { status: "pass", message: "credentials.json perms 0600 (owner-only)" };
			return {
				status: "warn",
				message: `credentials.json perms 0${mode.toString(8)}, expected 0600 (run: chmod 600 credentials.json)`,
			};
		},
	};
}

/**
 * The OAuth `jwtSecret`-present check (spec 20f): either `OAUTH_JWT_SECRET` is set
 * in the env, or a secret is persisted in `credentials.json`. Present → `pass`;
 * absent → `warn` — the AS mints one on first use (at server boot or the first
 * `/oauth/token` grant), so a missing secret is advisory, not fatal (the install
 * still works localhost-only with the opaque bearer). **Read-only:** uses
 * {@link peekJwtSecret} (never `resolveJwtSecret`), so `doctor` never mints state.
 */
export function createJwtSecretCheck(
	deps: { env?: NodeJS.ProcessEnv; credentialsPath?: string } = {},
): DiagnosticCheck {
	const env = deps.env ?? process.env;
	return {
		id: "oauth-jwt-secret",
		run: async () => {
			// Lazy path default (registry-bakes-at-load; see createConfigCheck).
			const path = deps.credentialsPath ?? credentialsPath();
			const secret = peekJwtSecret(env, path);
			if (!secret) return { status: "warn", message: "OAuth jwtSecret not set (minted on first use)" };
			const fromEnv = env.OAUTH_JWT_SECRET !== undefined && env.OAUTH_JWT_SECRET.trim() !== "";
			return {
				status: "pass",
				message: fromEnv
					? "OAuth jwtSecret set via OAUTH_JWT_SECRET"
					: "OAuth jwtSecret present in credentials.json",
			};
		},
	};
}

/**
 * The binary-presence check for a runtime tool (`rg`/`fd`): present → `pass`;
 * absent → `fail` (the tool backed by it — `grep` for `rg`, `find` for `fd` — is
 * unavailable). Mirrors the `grep`/`find` `isToolAvailable` gate.
 */
export function createBinaryCheck(
	name: "rg" | "fd",
	isAvailable: (name: string) => boolean = isToolAvailable,
): DiagnosticCheck {
	return {
		id: name,
		run: async () =>
			isAvailable(name)
				? { status: "pass", message: `${name} present` }
				: {
						status: "fail",
						message: `${name} not found on PATH — the ${name === "rg" ? "grep" : "find"} tool will be unavailable`,
					},
	};
}

/**
 * The per-channel check. A **live** channel's provider must be `isAvailable`
 * (its gate satisfied — a binary on PATH for `cloudflared`, or a secret for `ngrok`,
 * whose in-process `@ngrok/ngrok` SDK needs no binary); a **static** channel's
 * declared endpoint must be `probe`-reachable. The full options bag merges the
 * entry's non-secret `options` with its secrets (`getCredentials`) so a
 * secret-gated `isAvailable` (or a `probe`) sees its values.
 * `not available` / unreachable → `warn` (the channel won't function, but the
 * server still boots localhost-only); an unregistered kind → `fail` (config error).
 */
export function createChannelCheck(
	entry: ChannelEntry,
	deps: Pick<DoctorDeps, "getChannel" | "getCredentials"> = {},
): DiagnosticCheck {
	const getChan = deps.getChannel ?? getChannel;
	const getCreds = deps.getCredentials ?? getCredentials;
	return {
		id: `channel:${entry.id}`,
		run: async () => {
			const provider = getChan(entry.kind);
			if (!provider) {
				return { status: "fail", message: `channel ${entry.id}: no provider registered for kind "${entry.kind}"` };
			}
			const options = { ...entry.options, ...getCreds(entry.id) };
			if (provider.mode === "live") {
				const available = await provider.isAvailable(options);
				return available
					? { status: "pass", message: `channel ${entry.id} (${entry.kind}): ready` }
					: {
							status: "warn",
							message: `channel ${entry.id} (${entry.kind}): not available (missing credentials or binary)`,
						};
			}
			// static → probe the operator's declared endpoint (no `start` to run).
			const probe = provider.probe;
			if (!probe) return { status: "pass", message: `channel ${entry.id} (${entry.kind}): configured` };
			const probed = await probe(options);
			return probed.ok
				? { status: "pass", message: `channel ${entry.id} (${entry.kind}): reachable` }
				: { status: "warn", message: `channel ${entry.id} (${entry.kind}): ${probed.error.message}` };
		},
	};
}

// ---- the vm check family (spec 27d) -------------------------------------------

/**
 * A check with **dynamic presence** (the vm family's shape): `present` is evaluated
 * at RUN time — never baked at registration (the Batch-0 lazy-path lesson: the
 * registry self-registers at module load, so load-time resolution would freeze the
 * importing process's HOME/env into the closure) — and `false` removes the check
 * from the report entirely: no row, no count. That is how the default `off`-mode
 * install with no golden sees nothing new — the checks are registered, just not
 * applicable (spec 28's invisibility starts here).
 */
export interface DynamicCheck extends DiagnosticCheck {
	/** Whether this check applies to the install as it stands RIGHT NOW. */
	present(): boolean;
}

/** Does this check carry the {@link DynamicCheck.present} predicate? */
function isDynamicCheck(check: DiagnosticCheck | DynamicCheck): check is DynamicCheck {
	return "present" in check;
}

/**
 * A check's presence, throw-safe: a `present` that throws (e.g. a malformed
 * `MCP_VM_MODE` failing the config merge) defers to `run`, where {@link safeRun}
 * turns the same throw into the check's `fail` row — a presence probe must never
 * crash the whole `doctor` run.
 */
function checkPresent(check: DiagnosticCheck | DynamicCheck): boolean {
	if (!isDynamicCheck(check)) return true;
	try {
		return check.present();
	} catch {
		return true;
	}
}

/** One GiB — the vm family's byte math (preflight.ts's GIB, restated). */
const VM_GIB = 1024 ** 3;

/** The host-side headroom beside the guest RAM: 2 GiB (spec 27's OOM posture). */
const VM_RAM_HEADROOM_BYTES = 2 * VM_GIB;

/** The vm tree's aggregate footprint budget: 40 GiB (spec 27's doctor row). */
const VM_TREE_BUDGET_BYTES = 40 * VM_GIB;

/** preflight.ts's GOLDEN_REMEDY, restated verbatim (module-private there — one pipeline, one line). */
const VM_GOLDEN_REMEDY = "run: openhammer vm install && openhammer vm provision && openhammer vm snapshot";

/** The `images/` golden-dir prefix (preflight.ts/manage.ts's GOLDEN_PREFIX, restated). */
const VM_GOLDEN_PREFIX = "golden-";

/** Bytes → `6G` / `6.6G` — one decimal, a trailing `.0` trimmed (the doctor row style). */
function gib(bytes: number): string {
	return `${(bytes / VM_GIB).toFixed(1).replace(/\.0$/, "")}G`;
}

/** The manifest's ISO stamp → its `YYYY-MM-DD` date half (the `built <date>` row). */
function dayOf(builtAt: string | null): string {
	return builtAt === null ? "unknown" : builtAt.slice(0, 10);
}

/**
 * Injection seams for the vm check family — the `createChannelCheck` pattern
 * (construct with deps, register the instances; every path/mode/env resolves
 * lazily at `present`/`run` time, never at construction). Defaults are the real
 * implementations, so the hermetic trio never requires KVM/QEMU/OVMF.
 */
export interface VmCheckDeps {
	/** Env read for the `MCP_VM_*` precedence (default: `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** Settings to resolve the vm surface from (default: `loadSettings` at the lazily-resolved home's `config.json`). */
	readonly settings?: Settings;
	/**
	 * HOME resolver — CALLED AT RUN TIME so a repointed home changes what an
	 * already-constructed check sees (the Batch-0 regression shape; default:
	 * `os.homedir`).
	 */
	readonly homeDir?: () => string;
	/** Override the boot-preflight probe set (default: 27c's real seams). */
	readonly preflight?: Omit<PreflightDeps, "homeDir">;
	/** Override the golden listing (default: 26f's `vmList` over the same home). */
	readonly listGoldens?: (homeDir: string) => Promise<readonly GoldenSummary[]>;
	/** Override the `/proc/meminfo` read (default: the real file, `undefined` = unreadable). */
	readonly readMeminfo?: () => string | undefined;
	/** Override the vm-tree du (default: 26f's walk; tests return exact bytes). */
	readonly duOf?: DuOf;
}

/**
 * The vm family's HOME — resolved at CALL time (the lazy-path discipline; a
 * construction-time default would bake the importing process's HOME in).
 */
function homeOf(deps: VmCheckDeps): string {
	return (deps.homeDir ?? homedir)();
}

/**
 * The vm family's shared run-time resolution — the 27b {@link resolveConfig} merge
 * over (env, settings), with args `{}` (doctor inspects the persisted+env posture;
 * the boot-scoped `--vm` flags are a boot concern, not a doctor one). **The
 * ResolvedVmConfig assembly choice:** reuse `resolveConfig` rather than
 * hand-assembling, so doctor judges exactly what a boot would judge — one
 * precedence table (env > settings, per-field gap-fill) and one guest-root path
 * (`MCP_ROOT_DIR` reinterpreted as a guest absolute path, defaulting to
 * `/home/<guestUser>`) — and the two can never drift. The `guestUser` seam threads
 * the home resolver, so the default guest root follows the SAME home the golden
 * tree does. Called INSIDE `present`/`run`, never at construction.
 */
function resolveVmCheckConfig(deps: VmCheckDeps): ResolvedConfig {
	const env = deps.env ?? process.env;
	const home = homeOf(deps);
	const settings = deps.settings ?? loadSettings(settingsPath(home));
	return resolveConfig({}, env, settings, {
		guestUser: () => loadGuestConfig(resolveVmDirs({ homeDir: home })).username,
	});
}

/**
 * Does ANY golden exist under this home's `images/` — the cheap presence half
 * (preflight.ts's `GOLDEN_PREFIX` rule, restated: a `golden-*` dir under images/).
 * The expensive half (manifest validity, live disk size) is `vm-golden`'s `run`.
 */
function goldenExists(homeDir: string): boolean {
	let entries: readonly Dirent[];
	try {
		entries = readdirSync(resolveVmDirs({ homeDir }).images, { withFileTypes: true });
	} catch {
		return false; // no images root — no goldens
	}
	return entries.some((entry) => entry.isDirectory() && entry.name.startsWith(VM_GOLDEN_PREFIX));
}

/**
 * Pull `MemAvailable` (in bytes) out of `/proc/meminfo` text. `undefined` when the
 * line is absent or malformed — unmeasurable, NOT zero (the statfs posture: an
 * unreadable measure must not read as "low").
 */
export function parseMemAvailable(text: string): number | undefined {
	for (const line of text.split("\n")) {
		const match = /^MemAvailable:\s+(\d+)\s+kB\b/.exec(line);
		if (match !== null) return Number(match[1]) * 1024;
	}
	return undefined;
}

/** The `/proc/meminfo` seam: the file's text, or `undefined` when unreadable. */
export type ReadMeminfo = () => string | undefined;

const readMeminfoDefault: ReadMeminfo = () => {
	try {
		return readFileSync("/proc/meminfo", "utf-8");
	} catch {
		return undefined;
	}
};

/**
 * The default {@link VmCheckDeps.duOf} — 26f manage.ts's `duOfDefault` walk,
 * restated here because it is module-private there (the `readProcDefault`
 * restatement precedent; consolidate when spec 27's service extracts the shared
 * module): recursive du with session.ts's dirSize semantics — lstat via dirent,
 * symlinks unopened, unreadable entries contribute zero, a bare file its size.
 */
const duOfDefault: DuOf = async (path) => {
	const info = statSync(path, { throwIfNoEntry: false });
	if (info === undefined) return 0;
	if (!info.isDirectory()) return info.size;
	let total = 0;
	const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const child = join(path, entry.name);
		if (entry.isDirectory()) {
			total += await duOfDefault(child);
		} else if (entry.isFile()) {
			total += (await stat(child).catch(() => undefined))?.size ?? 0;
		}
	}
	return total;
};

/**
 * The `vm-preflight` check (spec 27d): 27c's boot gate re-run as ADVICE through
 * the same seams — every preflight failure is this check's `fail` row carrying
 * preflight's one-liner verbatim; a pass names the active mode + the guest root
 * (`vm mode active — guest root /home/sandbox`). A malformed `MCP_VM_*` value
 * fails the {@link resolveVmCheckConfig} merge and surfaces through
 * {@link safeRun} as the `fail` row (boot-fatal at `main`, actionable at doctor).
 *
 * Presence: mode `off` AND no golden → ABSENT (the default npm install sees
 * nothing). Mode `off` with a golden stays PRESENT but idle — `vmPreflight`
 * returns ok before resolving any dep for `off` (the zero-VM-code pin), so the
 * row honestly says the stack is idle rather than vanishing on someone who has
 * built a golden.
 */
export function createVmPreflightCheck(deps: VmCheckDeps = {}): DynamicCheck {
	return {
		id: "vm-preflight",
		present: () => resolveVmCheckConfig(deps).vm.mode !== "off" || goldenExists(homeOf(deps)),
		run: async () => {
			const home = homeOf(deps);
			const config = resolveVmCheckConfig(deps);
			const result = vmPreflight(config.vm, config.rootDir, { ...deps.preflight, homeDir: home });
			if (!result.ok) return { status: "fail", message: result.message };
			if (config.vm.mode === "off") return { status: "pass", message: "vm mode off — VM stack idle" };
			return { status: "pass", message: `${config.vm.mode} mode active — guest root ${config.rootDir}` };
		},
	};
}

/**
 * The `vm-golden` check: the NEWEST golden's row, from 26f's own listing
 * ({@link vmList} — one golden-scan posture) — `golden-<id> (flavor base, 6.6G
 * actual, built <date>)`, the `actual` clause dropped when qemu-img could not
 * measure (0 = unmeasured, the InstallResult convention — never a claim of
 * emptiness). No golden in a vm mode → `warn` with the build pipeline (doctor is
 * advisory: a missing image is advice, not a broken install); a corrupt NEWEST
 * golden → `warn` naming it — never silently skipped past to an older valid one
 * (preflight's no-degrade rule, restated at advisory grade).
 */
export function createVmGoldenCheck(deps: VmCheckDeps = {}): DynamicCheck {
	const listGoldens = deps.listGoldens ?? ((home: string) => vmList({ homeDir: home }));
	return {
		id: "vm-golden",
		present: () => resolveVmCheckConfig(deps).vm.mode !== "off" || goldenExists(homeOf(deps)),
		run: async () => {
			// Resolve the config first (even though the row itself needs none of it) so
			// a malformed `MCP_VM_*` env value surfaces as this check's `fail` exactly
			// like the rest of the family — one world, one failure story.
			resolveVmCheckConfig(deps);
			const newest = (await listGoldens(homeOf(deps)))[0];
			if (newest === undefined) {
				return { status: "warn", message: `no golden image — ${VM_GOLDEN_REMEDY}` };
			}
			if (!newest.manifestOk) {
				return {
					status: "warn",
					message: `newest golden ${newest.id} has a corrupt manifest — ${VM_GOLDEN_REMEDY}`,
				};
			}
			const actual = newest.diskActualBytes > 0 ? `, ${gib(newest.diskActualBytes)} actual` : "";
			return {
				status: "pass",
				message: `${newest.id} (flavor ${newest.flavor ?? "unknown"}${actual}, built ${dayOf(newest.builtAt)})`,
			};
		},
	};
}

/**
 * The `vm-ram` check (spec 27's OOM posture): free host RAM (`/proc/meminfo`
 * `MemAvailable`, via the {@link VmCheckDeps.readMeminfo} seam) below
 * `memoryMb` + 2 GiB headroom → `warn` with the close-apps hint — the guest
 * FREEZES rather than dies when it thrashes, so the operator wants the warning
 * before the hang, not a crash log after. Unmeasurable (no readable
 * `/proc/meminfo`) → `pass` naming it (unmeasured is not low).
 */
export function createVmRamCheck(deps: VmCheckDeps = {}): DynamicCheck {
	const readMeminfo = deps.readMeminfo ?? readMeminfoDefault;
	return {
		id: "vm-ram",
		present: () => resolveVmCheckConfig(deps).vm.mode !== "off" || goldenExists(homeOf(deps)),
		run: async () => {
			const wantBytes = resolveVmCheckConfig(deps).vm.memoryMb * 1024 * 1024 + VM_RAM_HEADROOM_BYTES;
			const text = readMeminfo();
			const freeBytes = text === undefined ? undefined : parseMemAvailable(text);
			if (freeBytes === undefined) {
				return { status: "pass", message: "free RAM unmeasurable (no /proc/meminfo)" };
			}
			if (freeBytes < wantBytes) {
				return {
					status: "warn",
					message:
						`free RAM ${gib(freeBytes)}, vm mode wants ${gib(wantBytes)} — ` +
						"close heavy apps (the guest freezes rather than dies when it thrashes)",
				};
			}
			return { status: "pass", message: `free RAM ${gib(freeBytes)} (vm mode wants ${gib(wantBytes)})` };
		},
	};
}

/**
 * The `vm-footprint` check: the aggregate byte size of the vm tree
 * (`~/.openhammer/vm/` — goldens + overlays + cidata together, via the
 * {@link VmCheckDeps.duOf} seam, 26f's walk) over the 40 GiB budget → `warn`
 * pointing at `openhammer vm gc`; at or under → the informational pass row.
 * Presence is TREE-based (an absent tree is an absent check): bytes on disk are
 * on disk whatever the mode says.
 */
export function createVmFootprintCheck(deps: VmCheckDeps = {}): DynamicCheck {
	const duOf = deps.duOf ?? duOfDefault;
	return {
		id: "vm-footprint",
		present: () => statSync(resolveVmDirs({ homeDir: homeOf(deps) }).root, { throwIfNoEntry: false }) !== undefined,
		run: async () => {
			const bytes = await duOf(resolveVmDirs({ homeDir: homeOf(deps) }).root);
			if (bytes > VM_TREE_BUDGET_BYTES) {
				return { status: "warn", message: `vm tree is ${gib(bytes)} — run: openhammer vm gc` };
			}
			return { status: "pass", message: `vm tree is ${gib(bytes)}` };
		},
	};
}

/**
 * The `vm-root` check (spec 27, matrix row 9's doctor half): an INFO-grade pass
 * row surfacing the EFFECTIVE guest root — `MCP_ROOT_DIR` reinterpreted as a
 * guest absolute path by the same 27b path every vm-mode boot takes
 * ({@link resolveVmCheckConfig}'s `resolveConfig`), defaulting to
 * `/home/<guestUser>` from the spec-26 guest doc. Present only in vm modes: in
 * `off` the value is a host path and the row would lie.
 */
export function createVmRootCheck(deps: VmCheckDeps = {}): DynamicCheck {
	return {
		id: "vm-root",
		present: () => resolveVmCheckConfig(deps).vm.mode !== "off",
		run: async () => {
			const config = resolveVmCheckConfig(deps);
			return {
				status: "pass",
				message: `effective guest root: ${config.rootDir} (MCP_ROOT_DIR reinterpreted in vm modes)`,
			};
		},
	};
}

/**
 * The whole vm family in report order — preflight (can it boot), golden (what it
 * would boot), ram/footprint (can the host carry it), root (where it roots).
 * Registered by {@link createDefaultChecks}; every check resolves its world
 * lazily at `present`/`run` time, so the module-load registration bakes nothing.
 */
export function createVmChecks(deps: VmCheckDeps = {}): DynamicCheck[] {
	return [
		createVmPreflightCheck(deps),
		createVmGoldenCheck(deps),
		createVmRamCheck(deps),
		createVmFootprintCheck(deps),
		createVmRootCheck(deps),
	];
}

/**
 * The canonical static check set (config + credentials + oauth-jwt-secret + rg +
 * fd + the vm family), built with the given paths/env/`isAvailable`/vm seams so
 * tests inject temp paths + an isolated env + scripted vm state; production calls
 * it with no args (real paths + `process.env` + the real implementations — the vm
 * checks' dynamic presence then decides per run whether they appear). Registered
 * into the global registry at module load so `getDiagnostics()` reflects what
 * `doctor` runs.
 */
export function createDefaultChecks(
	deps: {
		settingsPath?: string;
		credentialsPath?: string;
		isAvailable?: (name: string) => boolean;
	} & VmCheckDeps = {},
): DiagnosticCheck[] {
	return [
		createConfigCheck(deps.settingsPath),
		createCredentialsCheck(deps.credentialsPath),
		createJwtSecretCheck({ env: deps.env, credentialsPath: deps.credentialsPath }),
		createBinaryCheck("rg", deps.isAvailable),
		createBinaryCheck("fd", deps.isAvailable),
		...createVmChecks(deps),
	];
}

/**
 * Injectable seams for {@link runDiagnostics} / {@link doctorCommand} — the
 * `11a`/`13`/`17b`–`17m` injection-arg precedent, so the unit tests stay hermetic.
 */
export interface DoctorDeps {
	/** Settings to derive the per-channel checks from (defaults to `loadSettings` at {@link settingsPath}). */
	settings?: Settings;
	/** Path to `config.json` (defaults to {@link settingsPath}; used when `settings` is absent). */
	settingsPath?: string;
	/** Override channel-kind resolution (defaults to the registry {@link getChannel}). */
	getChannel?: (kind: ChannelEntry["kind"]) => ChannelProvider | undefined;
	/** Override secret lookup (defaults to {@link getCredentials} at {@link credentialsPath}). */
	getCredentials?: (id: string) => CredentialValues;
	/** Override the static check set (defaults to the registry {@link getDiagnostics}). */
	checks?: DiagnosticCheck[];
}

/**
 * Run every registered check plus one per configured channel, returning the
 * paired id+result list. The static checks run first (in registry order), then
 * the per-channel checks in `settings.channels` order. A check with dynamic
 * presence (the vm family) whose `present()` is `false` at run time is SKIPPED —
 * no row, no count — so the report counts only the checks that apply. `deps.checks`
 * overrides the static set (tests inject temp-path built-ins); `deps.settings`/
 * `getChannel`/`getCredentials` override the channel family. Production calls
 * with no deps (the registry's built-ins + real settings). Each check is isolated
 * via {@link safeRun}, so a run never throws.
 */
export async function runDiagnostics(deps: DoctorDeps = {}): Promise<DiagnosticReport[]> {
	const settings = deps.settings ?? loadSettings(deps.settingsPath ?? settingsPath());
	const staticChecks = deps.checks ?? getDiagnostics();
	const channelChecks = settings.channels.map((entry) => createChannelCheck(entry, deps));
	const reports: DiagnosticReport[] = [];
	for (const check of [...staticChecks, ...channelChecks]) {
		// Dynamic presence (the vm family): an absent check contributes no row and no
		// count — the default off-mode install reports exactly the five built-ins.
		if (!checkPresent(check)) continue;
		reports.push({ id: check.id, result: await safeRun(check) });
	}
	return reports;
}

// Statuses printed worst-first (a `fail` is the thing to read first); grouped in this order.
const STATUS_ORDER: readonly DiagnosticStatus[] = ["fail", "warn", "pass"];

/**
 * Format the reports as a human-readable block grouped by status (fail, then
 * warn, then pass), each group a `[status]` header over `id: message` lines,
 * led by a one-line summary. Pure — unit-tested without an io stream.
 */
export function formatDoctor(reports: DiagnosticReport[]): string {
	const counts: Record<DiagnosticStatus, number> = { pass: 0, warn: 0, fail: 0 };
	for (const { result } of reports) counts[result.status] += 1;
	const blocks: string[] = [
		`Ran ${reports.length} check(s): ${counts.fail} fail, ${counts.warn} warn, ${counts.pass} pass.`,
	];
	for (const status of STATUS_ORDER) {
		const group = reports.filter((r) => r.result.status === status);
		if (group.length === 0) continue;
		const lines = [`[${status}]`];
		for (const { id, result } of group) lines.push(`  ${id}: ${result.message}`);
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

/**
 * The `openhammer doctor` command: run every check, print the results grouped by
 * status, and return the exit code (`1` if any check `fail`ed, else `0` — a
 * `warn` is advisory). Mirrors the channel/config command shape (io in, exit code
 * out); `deps` threads through to {@link runDiagnostics} for hermetic tests.
 */
export async function doctorCommand(io: DoctorIo, deps: DoctorDeps = {}): Promise<number> {
	const reports = await runDiagnostics(deps);
	io.stdout.write(`${formatDoctor(reports)}\n`);
	return reports.some((r) => r.result.status === "fail") ? 1 : 0;
}

// Register the built-in checks so `getDiagnostics()` reflects what `doctor` runs
// (mirrors how the channel providers register into CHANNELS at index.ts load).
// doctor.ts → registry.ts is one direction, so this self-registration is TDZ-safe
// (registry.ts fully loads before this module's top-level code runs — no cycle).
for (const check of createDefaultChecks()) registerDiagnostic(check);
