import { resolve } from "node:path";
import type { Settings } from "./config/settings.ts";

/**
 * Resolved OpenHammer configuration. All values are final (defaults applied,
 * numbers coerced) before boot — nothing in here is optional at read time.
 */
export interface Config {
	port: number; // PORT, default 3000
	host: string; // HOST, default "127.0.0.1"
	rootDir: string; // MCP_ROOT_DIR resolved absolute; default process.cwd()
	authToken: string | undefined; // MCP_AUTH_TOKEN override; undefined → mint on boot
	maxResponseBytes: number; // MCP_MAX_RESPONSE_BYTES, default 512_000
	logLevel: string; // LOG_LEVEL, default "info"
}

/**
 * The parsed command-line flags that select configuration (see `src/cli/args.ts`,
 * 17n). Only `--channel <id>` participates in the {@link resolveConfig} merge
 * today; the rest of argv is irrelevant here, so this is the minimal flag subset.
 */
export interface CliArgs {
	/** `--channel <id>` selects the active channel, overriding `defaultChannel`. */
	channel?: string;
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
}

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
		maxResponseBytes: coerceNumber(env.MCP_MAX_RESPONSE_BYTES, DEFAULT_MAX_RESPONSE_BYTES),
		logLevel: env.LOG_LEVEL || DEFAULT_LOG_LEVEL,
	};
}

/**
 * Parse an `MCP_ALLOWED_CLIENTS` env value into a client-name list: split on
 * commas/newlines, trim each entry, and drop empties. A bare `*` (or `["*"]`) means
 * any client — the default, enforced in the auth middleware (17r).
 */
function parseClientList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
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
 *
 * Secrets are out of scope here: a channel's secret values live in
 * `credentials.json` (not the settings doc), so an `NGROK_AUTHTOKEN` env override
 * is resolved at provider time (17i/17q). The §3.4 multi-source merge applies only
 * to values present in more than one source — the two doc-resident families above.
 */
export function resolveConfig(args: CliArgs, env: NodeJS.ProcessEnv, settings: Settings): ResolvedConfig {
	const base = loadConfig(env);
	const channelId = args.channel ?? settings.defaultChannel ?? null;
	const rawClients = env.MCP_ALLOWED_CLIENTS;
	const allowedClients =
		rawClients !== undefined && rawClients.trim() !== "" ? parseClientList(rawClients) : settings.mcp.allowedClients;
	return { ...base, channelId, allowedClients };
}
