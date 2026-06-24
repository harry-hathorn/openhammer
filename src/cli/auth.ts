/**
 * The `openhammer auth` command (spec 20e) — issue/list/remove OAuth clients.
 *
 * `add-client` interactively prompts for a label, issues a `client_id` +
 * `client_secret` (storing only the SHA-256 hash in `credentials.json`), and
 * reveals the plaintext secret **once**. `list` prints registered clients; `remove
 * <id>` deletes one. This is the operator-facing half of the spec-20 AS: the
 * `/oauth/token` grant (20c) consumes these clients; the auth middleware (20d)
 * accepts the issued JWTs.
 *
 * **Interactive (TUI) only.** The label prompt runs through the injectable
 * {@link PromptIo} seam (real clack in production; a fake in tests), so the
 * hermetic trio never touches a TTY. A non-interactive flag mode (`--label`,
 * `--print-secret`) is a separate checkbox (20g) — the scriptable/CI path.
 *
 * **Hermeticity — injection-arg precedent.** {@link AuthDeps.credPath} threads a
 * temp `credentials.json` into the real registry functions (issue/list/find/
 * remove) so the unit tests exercise the real persistence without touching
 * `~/.openhammer` (the `11a`/`13`/`17b`–`17p` precedent). `io`/`stream` let the
 * add-client prompt + banner framing be faked.
 *
 * **Exit codes** (the CLI contract): `0` success or cancel; `1` a handled domain
 * failure (an unknown client id, an unwritable cred dir); `2` a usage error
 * (unknown/missing subcommand).
 */
import {
	type ClientInfo,
	findClient,
	type IssuedClient,
	issueClient,
	listClients,
	removeClient,
} from "../auth/oauth/clients.ts";
import { credentialsPath } from "../config/credentials.ts";
import type { BannerStream } from "../tui/banner.ts";
import { defaultIo, type PromptIo, withSession } from "../tui/prompts.ts";

/**
 * Where {@link authCommand} writes — a structural slice of the CLI's `CommandIo`
 * (avoids a `cli.ts` import cycle, mirroring `DoctorIo`/`MonitorIo`).
 */
export interface AuthIo {
	stdout: BannerStream;
	stderr: BannerStream;
}

/**
 * Injectable seams for {@link authCommand} — the `11a`/`13`/`17b`–`17p`
 * injection-arg precedent, so the unit tests stay hermetic.
 */
export interface AuthDeps {
	/** Path to `credentials.json` (defaults to {@link credentialsPath}). */
	credPath?: string;
	/** The io driving the `add-client` label prompt (defaults to {@link defaultIo} = real clack). */
	io?: PromptIo;
	/** Banner destination for the `add-client` session framing (defaults to a silent stream —
	 * `runCli` already printed the banner on an interactive launch, so re-printing would double it). */
	stream?: BannerStream;
}

/** A write-discarding stream — the add-client session frames with `intro`/`outro` only (no banner). */
const silentStream: BannerStream = { write: () => false };

/**
 * Format the plaintext-secret reveal for a freshly issued client — shown ONCE.
 * The secret is never stored (only its SHA-256 hash), so this block is the only
 * chance to capture it. An empty/blank label renders without the quoted suffix.
 * Pure — unit-tested directly.
 */
export function formatSecretReveal(client: IssuedClient, label: string): string {
	const trimmed = label.trim();
	const labelLine = trimmed ? ` "${trimmed}"` : "";
	return [
		`Issued OAuth client${labelLine}.`,
		"",
		`  client_id:     ${client.clientId}`,
		`  client_secret: ${client.plaintextSecret}`,
		"",
		"Store the secret now — it will NOT be shown again.",
		"(Only a SHA-256 hash is kept in ~/.openhammer/credentials.json.)",
	].join("\n");
}

/**
 * Format the registered-clients list (id + label + createdAt, oldest first). Empty
 * → a "no clients" hint pointing at `auth add-client`; a blank label renders as
 * `(no label)`. Pure — unit-tested directly.
 */
export function formatClientList(clients: ClientInfo[]): string {
	if (clients.length === 0) {
		return "No OAuth clients registered. Run `openhammer auth add-client` to issue one.";
	}
	const lines = ["OAuth clients:"];
	for (const c of clients) {
		const label = c.label.trim() ? c.label : "(no label)";
		lines.push(`  ${c.clientId}  ${label}  ${c.createdAt}`);
	}
	return lines.join("\n");
}

/** `Usage: openhammer auth { add-client | list | remove <client_id> }` */
const AUTH_USAGE = "Usage: openhammer auth { add-client | list | remove <client_id> }";

/** `auth add-client` — prompt for a label, issue a client, reveal the plaintext secret once. */
async function addClientCmd(io: AuthIo, deps: AuthDeps): Promise<number> {
	const promptIo = deps.io ?? defaultIo;
	const stream = deps.stream ?? silentStream;
	const credPath = deps.credPath ?? credentialsPath();

	const label = await withSession(
		"Add OAuth client",
		async () => promptIo.text({ message: "Label (optional, press Enter to skip)" }),
		{ io: promptIo, stream },
	);
	if (label === null) return 0; // cancelled — no write, silent

	const result = issueClient(label, credPath);
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	io.stdout.write(`${formatSecretReveal(result.value, label)}\n`);
	return 0;
}

/** `auth list` — print registered clients (or the empty hint). */
function listClientsCmd(io: AuthIo, deps: AuthDeps): number {
	const credPath = deps.credPath ?? credentialsPath();
	io.stdout.write(`${formatClientList(listClients(credPath))}\n`);
	return 0;
}

/** `auth remove <id>` — delete a client by id (a clear message for an unknown id). */
function removeClientCmd(id: string | undefined, io: AuthIo, deps: AuthDeps): number {
	if (!id) {
		io.stderr.write("Usage: openhammer auth remove <client_id>\n");
		return 2;
	}
	const credPath = deps.credPath ?? credentialsPath();
	if (!findClient(id, credPath)) {
		io.stderr.write(`No OAuth client with id ${id}.\n`);
		return 1;
	}
	const result = removeClient(id, credPath);
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}
	io.stdout.write(`Removed client ${id}.\n`);
	return 0;
}

/**
 * The `openhammer auth` command: route to the subcommand and return the exit code.
 * `add-client` issues a client (interactive label prompt) + reveals the plaintext
 * secret once; `list` prints registered clients; `remove <client_id>` deletes one.
 * An unknown/missing subcommand is a usage error (`2`).
 */
export async function authCommand(
	sub: string | undefined,
	rest: string[],
	io: AuthIo,
	deps: AuthDeps = {},
): Promise<number> {
	switch (sub) {
		case "add-client":
			return await addClientCmd(io, deps);
		case "list":
			return listClientsCmd(io, deps);
		case "remove":
			return removeClientCmd(rest[0], io, deps);
		default:
			io.stderr.write(`${AUTH_USAGE}\n`);
			return 2;
	}
}
