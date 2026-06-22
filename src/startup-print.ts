/**
 * Boot-time human-readable startup banner (spec 14).
 *
 * Prints the local MCP endpoint, an optional tunnel URL, the bearer token (once,
 * on boot), a ready-to-paste `mcpServers` client-config block, the hand-off note,
 * and where the credential file lives (reused on restart unless `MCP_AUTH_TOKEN`
 * overrides). The pure formatting (`mcpServersConfig`, `formatStartup`) is split
 * out so it is unit-testable without spying on the console; `printStartup` is the
 * thin `void` wrapper the `main.ts` entrypoint calls.
 */
import { credentialPath } from "./auth/token.ts";

/** Inputs to {@link printStartup}. */
export interface StartupInfo {
	/** Resolved local origin, e.g. `http://127.0.0.1:3000` (no path). */
	localUrl: string;
	/** Public tunnel origin, e.g. `https://<name>.trycloudflare.com`, or undefined when localhost-only. */
	tunnelUrl?: string;
	/** The bearer token to present as `Authorization: Bearer <token>`. */
	token: string;
}

/**
 * The ready-to-paste MCP client config: an HTTP `mcpServers` entry pointing at
 * `endpointUrl` (the `/mcp` URL) authenticated with `token`. Single source for the
 * {@link printStartup} block and its unit test — the block is exactly this value
 * run through `JSON.stringify(…, null, 2)`.
 */
export function mcpServersConfig(endpointUrl: string, token: string) {
	return {
		mcpServers: {
			openhammer: {
				type: "http",
				url: endpointUrl,
				headers: { Authorization: `Bearer ${token}` },
			},
		},
	};
}

/** A short rule used as a visual separator around the boot banner. */
const SEP = "=".repeat(72);

/**
 * Format the full startup banner as a single string. Pure so a unit test can assert
 * on its contents (local `/mcp` endpoint, token, parseable `mcpServers` JSON, tunnel
 * line presence, credential path) without touching the console. {@link printStartup}
 * is the `void` wrapper that writes it to stdout.
 */
export function formatStartup({ localUrl, tunnelUrl, token }: StartupInfo): string {
	const localEndpoint = `${localUrl}/mcp`;
	const lines: string[] = [
		"",
		SEP,
		"  OpenHammer MCP server is ready.",
		SEP,
		"",
		`Local MCP endpoint: ${localEndpoint}`,
	];
	if (tunnelUrl) {
		lines.push(`Tunnel URL:         ${tunnelUrl}/mcp`);
	}
	lines.push("");
	lines.push("Bearer token (printed once on boot — save it):");
	lines.push(`  ${token}`);
	lines.push("");
	lines.push("Ready-to-paste MCP client config (Claude Code / generic mcpServers):");
	lines.push(JSON.stringify(mcpServersConfig(localEndpoint, token), null, 2));
	lines.push("");
	lines.push("Hand this URL + token to your remote agent (e.g. pi, Claude Code, a cloud LLM).");
	lines.push("");
	lines.push(`Credential file: ${credentialPath()}`);
	lines.push("(the token is reused on restart; set MCP_AUTH_TOKEN to override it)");
	lines.push("");
	return lines.join("\n");
}

/**
 * Write the startup banner to stdout. The `main.ts` entrypoint calls this after
 * Fastify is listening (and the tunnel, if any, is up). Returns `void` per spec 14.
 */
export function printStartup(info: StartupInfo): void {
	console.log(formatStartup(info));
}
