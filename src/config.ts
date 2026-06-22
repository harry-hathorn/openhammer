import { resolve } from "node:path";

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
