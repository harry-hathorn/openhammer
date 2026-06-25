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
import { GRANT_AUTHORIZATION_CODE, GRANT_CLIENT_CREDENTIALS, type IssueClientOptions } from "../auth/oauth/clients.ts";
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

/** Convert a {@link ClientConfig} into the {@link IssueClientOptions} `issueClient` reads. */
export function toIssueOptions(config: ClientConfig): IssueClientOptions {
	const opts: IssueClientOptions = { grantTypes: config.grantTypes };
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
 * Prompt the client config step by step via `io`. Resolves to the config, or `null`
 * the moment any prompt is cancelled. For an authorization-code client, collects the
 * redirect URIs + an optional per-client login (username + password); a blank
 * username means the client authenticates against the global operator login instead.
 */
export async function collectClientConfig(io: PromptIo): Promise<ClientConfig | null> {
	const label = await io.text({ message: "Label (optional, press Enter to skip)" });
	if (label === null) return null;

	const typeChoice = await io.select({
		message: CLIENT_TYPE_PROMPT,
		options: [...CLIENT_TYPE_OPTIONS],
		initialValue: GRANT_CLIENT_CREDENTIALS,
	});
	if (typeChoice === null) return null;

	const config: ClientConfig = {
		label,
		grantTypes: typeChoice === GRANT_AUTHORIZATION_CODE ? [GRANT_AUTHORIZATION_CODE] : [GRANT_CLIENT_CREDENTIALS],
	};

	if (typeChoice === GRANT_AUTHORIZATION_CODE) {
		const redirectUrisRaw = await io.text({
			message: "Redirect URIs (comma or newline separated)",
			placeholder: "e.g. https://claude.ai/api/mcp/auth_callback",
		});
		if (redirectUrisRaw === null) return null;
		const redirectUris = parseRedirectUris(redirectUrisRaw);
		if (redirectUris.length > 0) config.redirectUris = redirectUris;

		const username = await io.text({
			message: "Login username (optional — leave blank to use the global operator login)",
		});
		if (username === null) return null;
		if (username.trim() !== "") {
			config.username = username.trim();
			const password = await io.password({ message: "Login password" });
			if (password === null) return null;
			if (password !== "") config.password = password;
		}
	}

	return config;
}
