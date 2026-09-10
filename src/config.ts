import { resolve } from "node:path";
import type { Settings, VmSettings } from "./config/settings.ts";
import { loadGuestConfig } from "./vm/provision/guest-config.ts";
import { resolveVmDirs } from "./vm/session.ts";

/**
 * Resolved OpenHammer configuration. All values are final (defaults applied,
 * numbers coerced) before boot — nothing in here is optional at read time.
 */
export interface Config {
	port: number; // PORT, default 3000
	host: string; // HOST, default "127.0.0.1"
	/** MCP_ROOT_DIR resolved absolute; default process.cwd(). In vm/agent modes the value is reinterpreted as a GUEST path — see {@link resolveConfig}. */
	rootDir: string;
	authToken: string | undefined; // MCP_AUTH_TOKEN override; undefined → mint on boot
	publicUrl: string | undefined; // MCP_PUBLIC_URL override; undefined → tunnel/host:port at boot
	maxResponseBytes: number; // MCP_MAX_RESPONSE_BYTES, default 512_000
	logLevel: string; // LOG_LEVEL, default "info"
}

/**
 * The parsed command-line flags that select configuration (see `src/cli/args.ts`,
 * 17n). `--channel` and `--vm`/`--vm-agent` participate in the {@link resolveConfig}
 * merge; the rest of argv is irrelevant here, so this is the minimal flag subset.
 */
export interface CliArgs {
	/** `--channel <id>` selects the active channel, overriding `defaultChannel`. */
	channel?: string;
	/**
	 * `--vm` / `--vm-agent` — the boot-scoped VM mode override (`"vm"` / `"agent"`),
	 * overriding `MCP_VM_MODE` and `settings.vm.mode`. Both flags map onto this one
	 * field and a LATER occurrence wins (`parseArgs` assigns sequentially), so
	 * `--vm --vm-agent` boots agent and `--vm-agent --vm` boots vm.
	 */
	vmMode?: "vm" | "agent";
}

/**
 * The fully-resolved config: the env-driven {@link Config} server shape plus the
 * §3.4-merged channel selection and MCP client allowlist. Produced by
 * {@link resolveConfig}; the boot/registry layer (17q) reads `channelId`, and the
 * auth middleware's `allowedClients` gate (17r) reads `allowedClients`.
 */
export interface ResolvedConfig extends Config {
	/** The active channel id — `args.channel` (`--channel`) > `settings.defaultChannel`; `null` = localhost-only. */
	channelId: string | null;
	/** The MCP client allowlist — `MCP_ALLOWED_CLIENTS` (env) > `settings.mcp.allowedClients`; `[]` = any client. */
	allowedClients: string[];
	/**
	 * The resolved VM-sandbox surface (spec 27). Always present; inert when
	 * `vm.mode` is `off` (the zero-VM-code pin — see {@link resolveConfig}).
	 */
	vm: ResolvedVmConfig;
}

/**
 * The resolved VM-sandbox surface (spec 27) — every knob the boot/service layers
 * read, already coerced and validated. Precedence is per field, **flags > env >
 * settings** (`--vm`/`--vm-agent` > `MCP_VM_*` > `settings.vm`), the same
 * gap-fill style as `defaultChannel`: a source that doesn't mention a field
 * leaves the value the previous layer set.
 */
export interface ResolvedVmConfig {
	/** Resolved boot mode — `--vm`/`--vm-agent` > `MCP_VM_MODE` > `settings.vm.mode`. `off` = local backend, today's behavior. */
	mode: VmSettings["mode"];
	/** Golden-image path override (`MCP_VM_IMAGE`); `null` = the manifest-selected golden. */
	image: string | null;
	/** Guest RAM in MiB — `MCP_VM_MEMORY` > `settings.vm.memoryMb` (4096, the 22-measured default). */
	memoryMb: number;
	/** vCPUs — `MCP_VM_CPUS` > `settings.vm.cpus` (4). */
	cpus: number;
	/** Host-side ssh port (`MCP_VM_SSH_PORT`); `0` = ephemeral (the usernet-assigned port). */
	sshPort: number;
	/** Overlay teardown policy — `MCP_VM_PERSIST` > `settings.vm.persist`. `auto` resolves per mode at the service layer (vm→retain, agent→discard). */
	persist: VmSettings["persist"];
	/** Stable retained-identity id (`MCP_VM_SESSION_ID`); `null` = a fresh session per boot. */
	sessionId: string | null;
	/** Display config (`MCP_VM_DISPLAY`) — `"headless"` is the 22-measured winner and the only valid value. */
	display: "headless";
	/** Boot-readiness budget (`MCP_VM_BOOT_TIMEOUT_MS`), default 180 s. */
	bootTimeoutMs: number;
	/** Bounded first-call block (`MCP_VM_BOOT_BLOCK_MS`), default 0 = the async booting-err instead. */
	bootBlockMs: number;
	/** Overlay disk cap in GiB (`MCP_VM_DISK_CAP_GB`), default 45 — checked via `qemu-img info` at boot/teardown/doctor. */
	diskCapGb: number;
	/** Opt-in idle reaper (`MCP_VM_IDLE_TIMEOUT_MS` > `settings.vm.idleTimeoutMs`); `0` = never (a workspace is not a 10-minute test session). */
	idleTimeoutMs: number;
	/** The in-guest agent command (`MCP_VM_AGENT_CMD` > `settings.vm.agentCmd`). */
	agentCmd: string;
	/** Provisioned-secrets dir override (`MCP_VM_SECRETS_DIR` > `settings.vm.secretsDir`); `null` = the default `~/.openhammer/vm/secrets`. */
	secretsDir: string | null;
}

/**
 * Injectable seams so {@link resolveConfig} stays hermetic (the repo's
 * injection-arg precedent — tests never touch the real guest-config doc).
 */
export interface ResolveConfigDeps {
	/**
	 * The guest username behind the vm-mode `rootDir` default
	 * (`/home/<guestUser>`). Defaults to reading the spec-26 guest-config doc
	 * (`loadGuestConfig(resolveVmDirs()).username`) — the one filesystem read in
	 * the merge, and it is only ever CALLED when the resolved mode is not `off`
	 * (an off boot runs zero VM code, guest root included).
	 */
	guestUser?: () => string;
}

/** The default {@link ResolveConfigDeps.guestUser} — the real spec-26 loader. */
const defaultGuestUser = (): string => loadGuestConfig(resolveVmDirs({})).username;

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_MAX_RESPONSE_BYTES = 512_000;
const DEFAULT_LOG_LEVEL = "info";

/**
 * Coerce an env string into a number. Falls back to `defaultValue` when the
 * value is absent, empty, or non-numeric (NaN). A genuine `"0"` is preserved —
 * it is a load-bearing value (Fastify port 0 = ephemeral port for tests).
 */
function coerceNumber(value: string | undefined, defaultValue: number): number {
	if (value === undefined || value === "") {
		return defaultValue;
	}
	const n = Number(value);
	return Number.isNaN(n) ? defaultValue : n;
}

/**
 * Parse env into a typed {@link Config}. No external dep — operators load env
 * via Node `--env-file` or the shell. `rootDir` is resolved absolute and is NOT
 * checked for existence here: a missing root is a per-call concern (the `bash`
 * tool reports it at execution time), not a boot failure.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	return {
		port: coerceNumber(env.PORT, DEFAULT_PORT),
		host: env.HOST || DEFAULT_HOST,
		rootDir: resolve(env.MCP_ROOT_DIR || process.cwd()),
		authToken: env.MCP_AUTH_TOKEN || undefined,
		publicUrl: env.MCP_PUBLIC_URL || undefined,
		maxResponseBytes: coerceNumber(env.MCP_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
		logLevel: env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
	};
}

/**
 * Parse a client-name list from a comma/newline-separated string: split on
 * commas/newlines, trim each entry, and drop empties. The single source of the
 * `allowedClients` list format — shared by `MCP_ALLOWED_CLIENTS` (env, here in
 * {@link resolveConfig}) and the `mcp` section's field (the section wizard, 17l).
 * A bare `*` (or `["*"]`) means any client — the default, enforced in the auth
 * middleware (17r).
 */
export function parseClientList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
}

// ---- the VM env surface (spec 27) -------------------------------------------

/**
 * The valid `MCP_VM_MODE` values. settings.ts owns the validated union
 * (`isVmSettings`); this is its env-side copy — exported so the `vm` section's
 * select options (src/config/sections.ts) derive from the same array (the
 * `parseClientList` single-source precedent: env and section can never disagree).
 */
export const VM_MODE_VALUES = ["off", "vm", "agent"] as const satisfies readonly VmSettings["mode"][];

/** The valid `MCP_VM_PERSIST` values — the settings.ts union's env-side copy (see {@link VM_MODE_VALUES}). */
export const VM_PERSIST_VALUES = ["auto", "retain", "discard"] as const satisfies readonly VmSettings["persist"][];

/**
 * `MCP_VM_DISPLAY`'s only valid value — the 22-measured headless winner
 * (qemu/args.ts `DISPLAY_DEFAULT`): the only display config where QMP
 * `screendump` works, for 2 GiB less RAM than GL. Anything else is an
 * actionable boot error, never a silent degradation.
 */
const VM_DISPLAY_VALUES = ["headless"] as const;

/** `MCP_VM_SSH_PORT`'s unset/default value: an ephemeral loopback port (usernet-assigned). */
const VM_SSH_PORT_EPHEMERAL = 0;
/** `MCP_VM_BOOT_TIMEOUT_MS` default: 180 s of boot-readiness budget (spec 27). */
const VM_BOOT_TIMEOUT_MS_DEFAULT = 180_000;
/** `MCP_VM_BOOT_BLOCK_MS` default: 0 — no first-call block; the async booting-err is the posture. */
const VM_BOOT_BLOCK_MS_DEFAULT = 0;
/** `MCP_VM_DISK_CAP_GB` default: 45 GiB overlay cap (spec 27, checked via `qemu-img info`). */
const VM_DISK_CAP_GB_DEFAULT = 45;

/**
 * Read one `MCP_VM_*` string: trimmed, with an absent or blank value treated as
 * unset — the `MCP_ALLOWED_CLIENTS` empty-env posture, so a source that doesn't
 * mention a field leaves the previous layer's value (gap-fill). Also reused for
 * `MCP_ROOT_DIR` on the guest-root path below.
 */
function vmEnvString(raw: string | undefined): string | undefined {
	if (raw === undefined) {
		return undefined;
	}
	const trimmed = raw.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * Read one `MCP_VM_*` enum value. A present-but-unknown value THROWS the
 * actionable error (variable name, allowed set, offending value) — spec 27's
 * fail-fatal boot posture: `main` surfaces it as the one-line exit, and an
 * invalid mode/persist/display is never silently coerced.
 */
function vmEnvEnum<T extends string>(name: string, raw: string | undefined, allowed: readonly T[]): T | undefined {
	const value = vmEnvString(raw);
	if (value === undefined) {
		return undefined;
	}
	for (const candidate of allowed) {
		if (candidate === value) {
			return candidate;
		}
	}
	const expected = allowed.length === 1 ? `"${allowed[0]}"` : `one of ${allowed.join(", ")}`;
	throw new Error(`${name} must be ${expected} (got "${value}")`);
}

/**
 * Read one `MCP_VM_*` integer (`Number` + `Number.isInteger` — the repo's
 * canonized parse, never unary `+`; the blank check upstream dodges the
 * `Number(" ") === 0` gotcha). A present-but-non-integer or below-`min` value
 * throws the actionable error, mirroring {@link vmEnvEnum}; shape only — deeper
 * range policy (a sane memory floor, port bounds) is preflight's (27c).
 */
function vmEnvInt(name: string, raw: string | undefined, min: number): number | undefined {
	const value = vmEnvString(raw);
	if (value === undefined) {
		return undefined;
	}
	const n = Number(value);
	if (!Number.isInteger(n) || n < min) {
		throw new Error(`${name} must be an integer >= ${min} (got "${value}")`);
	}
	return n;
}

/**
 * Resolve the VM surface: mode first (`--vm`/`--vm-agent`, later flag wins >
 * `MCP_VM_MODE` > `settings.vm.mode`), then every other field per the
 * flags > env > settings gap-fill. In `off` mode the rest of the `MCP_VM_*`
 * table is not even read — the zero-VM-code pin (spec 27: "Default off = zero
 * VM code runs; the local path is byte-for-byte today's behavior"): a malformed
 * `MCP_VM_MEMORY` can never fail a local boot, and the inert object simply
 * projects the (already-loaded) settings section plus the env-only defaults.
 */
function resolveVmConfig(args: CliArgs, env: NodeJS.ProcessEnv, settings: Settings): ResolvedVmConfig {
	const mode = args.vmMode ?? vmEnvEnum("MCP_VM_MODE", env.MCP_VM_MODE, VM_MODE_VALUES) ?? settings.vm.mode;
	if (mode === "off") {
		return {
			mode,
			image: null,
			memoryMb: settings.vm.memoryMb,
			cpus: settings.vm.cpus,
			sshPort: VM_SSH_PORT_EPHEMERAL,
			persist: settings.vm.persist,
			sessionId: null,
			display: "headless",
			bootTimeoutMs: VM_BOOT_TIMEOUT_MS_DEFAULT,
			bootBlockMs: VM_BOOT_BLOCK_MS_DEFAULT,
			diskCapGb: VM_DISK_CAP_GB_DEFAULT,
			idleTimeoutMs: settings.vm.idleTimeoutMs,
			agentCmd: settings.vm.agentCmd,
			secretsDir: settings.vm.secretsDir,
		};
	}
	return {
		mode,
		image: vmEnvString(env.MCP_VM_IMAGE) ?? null,
		memoryMb: vmEnvInt("MCP_VM_MEMORY", env.MCP_VM_MEMORY, 1) ?? settings.vm.memoryMb,
		cpus: vmEnvInt("MCP_VM_CPUS", env.MCP_VM_CPUS, 1) ?? settings.vm.cpus,
		sshPort: vmEnvInt("MCP_VM_SSH_PORT", env.MCP_VM_SSH_PORT, 0) ?? VM_SSH_PORT_EPHEMERAL,
		persist: vmEnvEnum("MCP_VM_PERSIST", env.MCP_VM_PERSIST, VM_PERSIST_VALUES) ?? settings.vm.persist,
		sessionId: vmEnvString(env.MCP_VM_SESSION_ID) ?? null,
		display: vmEnvEnum("MCP_VM_DISPLAY", env.MCP_VM_DISPLAY, VM_DISPLAY_VALUES) ?? "headless",
		bootTimeoutMs: vmEnvInt("MCP_VM_BOOT_TIMEOUT_MS", env.MCP_VM_BOOT_TIMEOUT_MS, 1) ?? VM_BOOT_TIMEOUT_MS_DEFAULT,
		bootBlockMs: vmEnvInt("MCP_VM_BOOT_BLOCK_MS", env.MCP_VM_BOOT_BLOCK_MS, 0) ?? VM_BOOT_BLOCK_MS_DEFAULT,
		diskCapGb: vmEnvInt("MCP_VM_DISK_CAP_GB", env.MCP_VM_DISK_CAP_GB, 1) ?? VM_DISK_CAP_GB_DEFAULT,
		idleTimeoutMs: vmEnvInt("MCP_VM_IDLE_TIMEOUT_MS", env.MCP_VM_IDLE_TIMEOUT_MS, 0) ?? settings.vm.idleTimeoutMs,
		agentCmd: vmEnvString(env.MCP_VM_AGENT_CMD) ?? settings.vm.agentCmd,
		secretsDir: vmEnvString(env.MCP_VM_SECRETS_DIR) ?? settings.vm.secretsDir,
	};
}

/**
 * The vm-mode `rootDir` — `MCP_ROOT_DIR` reinterpreted as a GUEST absolute path
 * (spec 27). Semantics:
 *
 * - **Set** (non-blank): the value is USED AS the guest root. That IS the
 *   reinterpretation — a stale HOST value is not translated or rejected; the
 *   value simply names where the guest root is, so `/home/me/work` from a local
 *   deployment boots the VM rooted there (inside the guest). `resolve()`
 *   normalizes it exactly like the off-mode host path (trailing slashes and
 *   `..` collapse; a relative value resolves against the host cwd the same way
 *   `loadConfig`'s does — preflight, 27c, judges guest-absoluteness).
 * - **Unset** (absent or blank): `/home/<guestUser>` via the
 *   {@link ResolveConfigDeps.guestUser} seam (spec 26's guest-config doc).
 */
function guestRootDir(env: NodeJS.ProcessEnv, deps: ResolveConfigDeps): string {
	const raw = vmEnvString(env.MCP_ROOT_DIR);
	if (raw !== undefined) {
		return resolve(raw);
	}
	return `/home/${(deps.guestUser ?? defaultGuestUser)()}`;
}

/**
 * Merge the three configuration layers per Node.js CLI best-practices §3.4 —
 * **CLI flags > env > persisted settings** — into a fully-resolved config.
 *
 * The server shape (port/host/rootDir/authToken/maxResponseBytes/logLevel) still
 * comes from the env layer ({@link loadConfig}) and wins over the file, so an
 * env-driven boot is unchanged (backward compatible — spec-01 behavior preserved).
 * The persisted settings doc fills only the gaps env/flags don't set:
 *
 * - **channel selection** — `args.channel` (`--channel <id>`) overrides
 *   `settings.defaultChannel`; `null` when neither is set (localhost-only boot).
 * - **MCP client allowlist** — `MCP_ALLOWED_CLIENTS` (env) overrides
 *   `settings.mcp.allowedClients`; an empty/whitespace env value is treated as
 *   unset and falls through to the file (matching `loadConfig`'s empty-env posture).
 * - **VM sandbox surface** (spec 27) — the {@link ResolvedVmConfig} family, per
 *   field: `--vm`/`--vm-agent` (mode only; later flag wins) > `MCP_VM_*` >
 *   `settings.vm`, gap-fill (a source silent on a field leaves the prior value).
 *
 * **Guest-root reinterpretation** (spec 27): when the resolved mode is not `off`,
 * `rootDir` is a GUEST absolute path — a set `MCP_ROOT_DIR` is used as that guest
 * root verbatim (see {@link guestRootDir}), an unset one defaults to
 * `/home/<guestUser>` through the {@link ResolveConfigDeps.guestUser} seam. Mode
 * `off` keeps {@link loadConfig}'s host resolution byte-for-byte and invokes no
 * seam, so the local path is today's behavior exactly.
 *
 * **Error posture:** a malformed `MCP_VM_*` value in a VM mode THROWS the
 * actionable error (boot-fatal via `main`'s one-line exit) — spec 27's deliberate
 * deviation from the channel null-safe pattern, and from `loadConfig`'s legacy
 * silent-default `coerceNumber`. In `off` mode the `MCP_VM_*` table is unread
 * (except `MCP_VM_MODE` itself), so a local boot cannot fail on it.
 *
 * Secrets are out of scope here: a channel's secret values live in
 * `credentials.json` (not the settings doc), so an `NGROK_AUTHTOKEN` env override
 * is resolved at provider time (17i/17q). The §3.4 multi-source merge applies only
 * to values present in more than one source — the doc-resident families above.
 */
export function resolveConfig(
	args: CliArgs,
	env: NodeJS.ProcessEnv,
	settings: Settings,
	deps: ResolveConfigDeps = {},
): ResolvedConfig {
	const base = loadConfig(env);
	const channelId = args.channel ?? settings.defaultChannel ?? null;
	const rawClients = env.MCP_ALLOWED_CLIENTS;
	const allowedClients =
		rawClients !== undefined && rawClients.trim() !== "" ? parseClientList(rawClients) : settings.mcp.allowedClients;
	const vm = resolveVmConfig(args, env, settings);
	const rootDir = vm.mode === "off" ? base.rootDir : guestRootDir(env, deps);
	return { ...base, rootDir, channelId, allowedClients, vm };
}
