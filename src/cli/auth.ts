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
 * **Interactive + non-interactive.** The label prompt runs through the injectable
 * {@link PromptIo} seam (real pi-tui in production; a fake in tests), so the
 * hermetic trio never touches a TTY. The non-interactive flag mode (spec 20g) —
 * `auth add-client --label <name> [--print-secret]` — feeds the label straight to
 * {@link issueClient} (no prompt) and gates the secret reveal on `--print-secret`
 * (stdout may be logged in CI); both paths persist an identical client.
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
	setOperatorLogin,
} from "../auth/oauth/clients.ts";
import { credentialsPath } from "../config/credentials.ts";
import type { BannerStream } from "../tui/banner.ts";
import { clientConfigFromFlags, collectClientConfig, toIssueOptions } from "../tui/client-wizard.ts";
import { defaultIo, type PromptIo, withSession } from "../tui/prompts.ts";
import { parseSubFlags } from "./flags.ts";

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
	/** The io driving the `add-client` label prompt (defaults to {@link defaultIo} = real pi-tui). */
	io?: PromptIo;
	/** Banner destination for the `add-client` session framing (defaults to a silent stream —
	 * `runCli` already printed the banner on an interactive launch, so re-printing would double it). */
	stream?: BannerStream;
	/**
	 * Non-interactive label (spec 20g): when set (`auth add-client --label <name>`), the label
	 * prompt is skipped — {@link addClientCmd} issues straight from it. `undefined` → prompt.
	 */
	label?: string;
	/**
	 * Non-interactive secret reveal (spec 20g): `--print-secret` prints the plaintext secret to
	 * stdout (capturable in CI). Without it, flag mode prints only the `client_id` (stdout may be
	 * logged, so the secret is withheld unless explicitly requested). Ignored on the interactive
	 * path, which always reveals the secret once.
	 */
	printSecret?: boolean;
	/**
	 * Non-interactive client type (spec 20g): `--type client_credentials|authorization_code`.
	 * Also reused by `set-login` is N/A. Omitted/other → `client_credentials`.
	 */
	type?: string;
	/**
	 * Non-interactive per-client login username (`--username`) for `add-client`, OR the
	 * operator-login username for `set-login`.
	 */
	username?: string;
	/**
	 * Non-interactive password (`--password`) — the per-client login password for `add-client`,
	 * OR the operator-login password for `set-login`.
	 */
	password?: string;
	/** Non-interactive redirect URIs (`--redirect-uris`, comma/newline-separated) for `add-client`. */
	redirectUris?: string;
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

/** `Usage: openhammer auth { add-client | set-login | list | remove <client_id> }` */
const AUTH_USAGE = "Usage: openhammer auth { add-client | set-login | list | remove <client_id> }";

/**
 * `auth add-client` — issue a client and (interactively) reveal the plaintext secret once.
 * Non-interactive (spec 20g): when {@link AuthDeps.label} is set (`--label`), the prompt is
 * skipped and the secret is revealed only with {@link AuthDeps.printSecret} (`--print-secret`).
 * Both paths reuse {@link issueClient} — the domain function — so the persisted client is
 * identical to the interactive issue.
 */
async function addClientCmd(io: AuthIo, deps: AuthDeps): Promise<number> {
	const credPath = deps.credPath ?? credentialsPath();
	const promptIo = deps.io ?? defaultIo;
	const stream = deps.stream ?? silentStream;
	const interactive = deps.label === undefined;

	// Non-interactive: build the config from flags (no prompts). Interactive: prompt
	// the full sequence (label → type →, for auth-code, redirect URIs + optional login).
	const config = interactive
		? await withSession("Add OAuth client", async () => collectClientConfig(promptIo), { io: promptIo, stream })
		: clientConfigFromFlags({
				label: deps.label ?? "",
				type: deps.type,
				username: deps.username,
				password: deps.password,
				redirectUris: deps.redirectUris,
			});
	if (config === null) return 0; // cancelled — no write, silent

	const result = issueClient(config.label, toIssueOptions(config), credPath);
	if (!result.ok) {
		io.stderr.write(`${result.error.message}\n`);
		return 1;
	}

	// Interactive always reveals the secret (shown once). Flag mode reveals only with
	// `--print-secret` (stdout may be logged in CI); the id prints either way.
	if (interactive || deps.printSecret === true) {
		io.stdout.write(`${formatSecretReveal(result.value, config.label)}\n`);
	} else {
		io.stdout.write(`Added OAuth client ${result.value.clientId}.\n`);
		io.stdout.write("(Pass --print-secret to display the plaintext secret.)\n");
	}
	return 0;
}

/**
 * `auth set-login` — set the global operator login (username + password) that
 * `/authorize` falls back to for clients without their own login (e.g. one created
 * dynamically by `/register`). Non-interactive (spec 20g): `--username <u> --password
 * <p>` skips the prompts.
 */
async function setLoginCmd(io: AuthIo, deps: AuthDeps): Promise<number> {
	const credPath = deps.credPath ?? credentialsPath();
	const promptIo = deps.io ?? defaultIo;
	const stream = deps.stream ?? silentStream;

	let creds: { username: string; password: string } | null;
	if (deps.username !== undefined && deps.password !== undefined) {
		creds = { username: deps.username, password: deps.password };
	} else {
		creds = await withSession(
			"Set operator login",
			async () => {
				const username = await promptIo.text({ message: "Operator username" });
				if (username === null) return null;
				const password = await promptIo.password({ message: "Operator password" });
				if (password === null) return null;
				return { username, password };
			},
			{ io: promptIo, stream },
		);
	}
	if (creds === null) return 0; // cancelled — no write, silent

	if (creds.username.trim() === "" || creds.password === "") {
		io.stderr.write("Username and password are required.\n");
		return 1;
	}
	try {
		setOperatorLogin(creds.username.trim(), creds.password, credPath);
	} catch (e) {
		io.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
		return 1;
	}
	io.stdout.write("Operator login set. Clients without their own login authenticate with it.\n");
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
 * `add-client` issues a client (interactive label prompt, or `--label` for the
 * non-interactive path) + reveals the plaintext secret once (or with
 * `--print-secret`); `list` prints registered clients; `remove <client_id>` deletes
 * one. An unknown/missing subcommand is a usage error (`2`).
 */
export async function authCommand(
	sub: string | undefined,
	rest: string[],
	io: AuthIo,
	deps: AuthDeps = {},
): Promise<number> {
	switch (sub) {
		case "add-client": {
			// Non-interactive (spec 20g): `--label` skips the prompts; `--type`/
			// `--username`/`--password`/`--redirect-uris` build an auth-code client;`
			// `--print-secret` gates the secret reveal. No `--label` → interactive wizard.
			const flags = parseSubFlags(rest);
			const label = flags.values.label;
			if (label !== undefined) {
				return addClientCmd(io, {
					...deps,
					label,
					printSecret: flags.bools.has("print-secret"),
					type: flags.values.type,
					username: flags.values.username,
					password: flags.values.password,
					redirectUris: flags.values["redirect-uris"],
				});
			}
			return addClientCmd(io, deps);
		}
		case "set-login": {
			// Non-interactive (spec 20g): `--username` + `--password` skip the prompts.
			const flags = parseSubFlags(rest);
			if (flags.values.username !== undefined && flags.values.password !== undefined) {
				return setLoginCmd(io, { ...deps, username: flags.values.username, password: flags.values.password });
			}
			return setLoginCmd(io, deps);
		}
		case "list":
			return listClientsCmd(io, deps);
		case "remove":
			return removeClientCmd(rest[0], io, deps);
		default:
			io.stderr.write(`${AUTH_USAGE}\n`);
			return 2;
	}
}
