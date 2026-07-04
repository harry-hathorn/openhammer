/**
 * The shared "add OAuth client" prompt sequence — the multi-step config both the CLI
 * (`auth add-client`) and the dashboard's Clients screen run. Returns the collected
 * config (label + grant type +, for authorization-code clients, redirect URIs + an
 * optional per-client login) or `null` on cancel.
 *
 * Lives in `tui/` (not `cli/`) so both layers import it without a `tui → cli` cycle
 * (`src/tui/` must not import `src/cli/`). The CLI also rebuilds this config from
 * flags on its non-interactive path (spec 20g) via {@link clientConfigFromFlags}.
 */
import {
	GRANT_AUTHORIZATION_CODE,
	GRANT_CLIENT_CREDENTIALS,
	type IssueClientOptions,
	TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST,
	TOKEN_ENDPOINT_AUTH_NONE,
} from "../auth/oauth/clients.ts";
import type { PromptIo } from "./prompts.ts";

/** The collected client config — the plaintext password is hashed by `issueClient`. */
export interface ClientConfig {
	label: string;
	grantTypes: string[];
	/** Registered redirect URIs (authorization-code clients). */
	redirectUris?: string[];
	/** Per-client login identity (authorization-code clients with their own login). */
	username?: string;
	/** Plaintext per-client login password (hashed before store; never persisted). */
	password?: string;
}

/**
 * Convert a {@link ClientConfig} into the {@link IssueClientOptions} `issueClient` reads.
 * The client-type choice decides the token-endpoint auth method: a machine
 * (`client_credentials`) client is **confidential** (no browser redirect/PKCE to stand in
 * for a secret), an authorization-code client is **public** (PKCE + the `/authorize` login
 * authenticate it). This intentionally forecloses a "confidential authorization-code
 * client" (a server-side web app) — not the MCP use case; such a client registers directly
 * via `/register` with `token_endpoint_auth_method: "client_secret_post"`.
 */
export function toIssueOptions(config: ClientConfig): IssueClientOptions {
	const tokenEndpointAuthMethod = config.grantTypes.includes(GRANT_CLIENT_CREDENTIALS)
		? TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST
		: TOKEN_ENDPOINT_AUTH_NONE;
	const opts: IssueClientOptions = { grantTypes: config.grantTypes, tokenEndpointAuthMethod };
	if (config.redirectUris !== undefined) opts.redirectUris = config.redirectUris;
	if (config.username !== undefined) opts.username = config.username;
	if (config.password !== undefined) opts.password = config.password;
	return opts;
}

/** The client-type picker options (value = the grant-type string). */
export const CLIENT_TYPE_OPTIONS = [
	{ value: GRANT_CLIENT_CREDENTIALS, label: "Client credentials (machine)" },
	{ value: GRANT_AUTHORIZATION_CODE, label: "Authorization code (login)" },
] as const;

/** The client-type picker message (a stable key the flag `io` answers on). */
export const CLIENT_TYPE_PROMPT = "Client type";

/** Split a comma/newline-separated URI list into trimmed, non-empty entries. */
export function parseRedirectUris(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map((u) => u.trim())
		.filter((u) => u !== "");
}

/** Flag inputs for the non-interactive add-client path (spec 20g). */
export interface ClientConfigFlags {
	label: string;
	/** `client_credentials` | `authorization_code`; omitted/other → client_credentials. */
	type?: string;
	username?: string;
	password?: string;
	/** Comma/newline-separated redirect URIs. */
	redirectUris?: string;
}

/** Build a {@link ClientConfig} from flags (no prompts) — the non-interactive path. */
export function clientConfigFromFlags(flags: ClientConfigFlags): ClientConfig {
	const isAuthCode = flags.type === GRANT_AUTHORIZATION_CODE;
	const config: ClientConfig = {
		label: flags.label,
		grantTypes: isAuthCode ? [GRANT_AUTHORIZATION_CODE] : [GRANT_CLIENT_CREDENTIALS],
	};
	if (flags.redirectUris !== undefined) {
		const redirectUris = parseRedirectUris(flags.redirectUris);
		if (redirectUris.length > 0) config.redirectUris = redirectUris;
	}
	if (flags.username !== undefined && flags.username.trim() !== "") {
		config.username = flags.username.trim();
		if (flags.password !== undefined && flags.password !== "") config.password = flags.password;
	}
	return config;
}

/**
 * Prompt the client config step by step via `io`. Resolves to the config, or `null` the
 * moment the prompt is cancelled.
 *
 * The interactive wizard issues a **machine** (`client_credentials`) client — the kind with a
 * `client_secret` a script or service presents at `/oauth/token`. Login (`authorization_code`)
 * clients are **not** created manually: an MCP client (Claude, Cursor) registers dynamically
 * via `/register` and the operator authorizes it at `/authorize` with the operator login (set
 * from the dashboard or `auth set-login`). The CLI `--type authorization_code` flag still
 * offers the manual escape hatch for a non-DCR client via {@link clientConfigFromFlags}.
 */
export async function collectClientConfig(io: PromptIo): Promise<ClientConfig | null> {
	const label = await io.text({ message: "Label (optional, press Enter to skip)" });
	if (label === null) return null;
	return { label, grantTypes: [GRANT_CLIENT_CREDENTIALS] };
}
