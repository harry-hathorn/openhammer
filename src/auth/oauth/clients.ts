/**
 * OAuth client registry + jwtSecret mint (spec 20b).
 *
 * The client-credentials AS (spec 20) needs two persisted secrets: the OAuth
 * **client registry** (`id → { secretHash, label, createdAt }`) and one symmetric
 * **jwtSecret** that signs + verifies the HS256 access tokens (spec 20a). Both
 * persist to `~/.openhammer/credentials.json` (`0600`) — the spec-17e secrets store.
 *
 * **Coexistence with channel secrets (the load-bearing constraint).**
 * `credentials.json` is a flat `Record<credId, Record<string,string>>` (channel
 * secrets), whole-file validated by `isCredentialsMap`: a single non-string-bag
 * value rejects the WHOLE file as corrupt, so the next channel write (a
 * read-merge-write starting from `{}`) would erase every secret. Spec 20's prose
 * sketches a top-level `{ jwtSecret, clients: {…} }`, but `clients` is a nested
 * object (not a string bag) — putting it at the top level would therefore CLOBBER
 * every channel's secrets. The OAuth state is stored instead under a **reserved
 * credId** (`__openhammer_oauth__`) as a valid string bag `{ jwtSecret, clients }`,
 * where `clients` is JSON-stringified so the bag stays `Record<string,string>` and
 * passes `isCredentialsMap` unchanged: channel secrets survive every OAuth
 * read/write and vice versa. The serialization is fully encapsulated here —
 * consumers (the `/oauth/token` grant (20c), the auth middleware (20d), `doctor`
 * (20f)) call the domain functions below and never touch the bag shape.
 *
 * **Result spine.** Per spec 20's boundary posture, auth is an edge: `verifySecret`
 * → `boolean`, `findClient` → `ClientRecord | undefined`, `ensureJwtSecret` →
 * `string | undefined` (the presence/null posture, like `verifyAccessToken`). The
 * `Result` spine applies to the **mutating** client-management ops (`issueClient`/
 * `removeClient`), which wrap the throwing persistence boundary (`setCredentials`)
 * so a write failure is a surfaced `err`, not a throw — the spec-17 `manage.ts`
 * precedent. `listClients`/`findClient` are pure reads with no failure mode, so
 * they carry no `Result` (the `listChannels` precedent).
 *
 * **No `bcrypt`.** Secrets are high-entropy (32 random bytes), so SHA-256 +
 * `timingSafeEqual` is adequate (the spec 20 decision). The plaintext secret is
 * returned ONCE at issue; only the hash is stored.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type CredentialValues, credentialsPath, getCredentials, setCredentials } from "../../config/credentials.ts";
import { err, ok, type Result } from "../../tools/result.ts";

/** Reserved credId under which the OAuth state lives in `credentials.json`. */
const OAUTH_CRED_ID = "__openhammer_oauth__";
/** Bag key for the symmetric JWT signing secret. */
const KEY_JWT_SECRET = "jwtSecret";
/** Bag key for the JSON-stringified client registry. */
const KEY_CLIENTS = "clients";

/** Prefix on every OAuth client id (so a client id is never a channel UUID). */
const CLIENT_ID_PREFIX = "oh_";

/** One registered client — only the **hash** is stored (the plaintext is shown once). */
export interface ClientRecord {
	secretHash: string;
	label: string;
	createdAt: string;
}

/** A client as {@link listClients} exposes it: id + the non-secret metadata. */
export interface ClientInfo {
	clientId: string;
	label: string;
	createdAt: string;
}

/** A freshly issued client — the plaintext secret is returned ONCE. */
export interface IssuedClient {
	clientId: string;
	/** Plaintext secret — shown once at issue; only the hash is persisted. */
	plaintextSecret: string;
}

/** The persisted registry shape (id → record), serialized into the `clients` bag key. */
type ClientRegistry = Record<string, ClientRecord>;

/** Mint a client id: `oh_` + 16 random bytes hex (32 chars). */
export const newClientId = (): string => `${CLIENT_ID_PREFIX}${randomBytes(16).toString("hex")}`;

/** Mint a high-entropy client secret (32 random bytes, base64url). Shown once. */
export const newClientSecret = (): string => randomBytes(32).toString("base64url");

/** SHA-256 hex of a secret — the stored form. Deterministic; no salt (secrets are high-entropy). */
export const hashSecret = (secret: string): string => createHash("sha256").update(secret).digest("hex");

/**
 * Verify a secret against its stored hash in constant time. Both sides are SHA-256
 * hex (so the lengths always match for a real hash); `timingSafeEqual` compares
 * without short-circuiting. The length guard also keeps a malformed `hash` from
 * making `timingSafeEqual` throw on a length mismatch. A wrong secret → `false`.
 */
export function verifySecret(provided: string, hash: string): boolean {
	const a = Buffer.from(hashSecret(provided));
	const b = Buffer.from(hash);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** Type guard for one persisted client record (hand-narrowed; no `as`). */
function isClientRecord(v: unknown): v is ClientRecord {
	if (typeof v !== "object" || v === null) return false;
	return (
		"secretHash" in v &&
		typeof v.secretHash === "string" &&
		"label" in v &&
		typeof v.label === "string" &&
		"createdAt" in v &&
		typeof v.createdAt === "string"
	);
}

/** Type guard for the registry (a plain object whose every value is a client record). */
function isRegistry(v: unknown): v is ClientRegistry {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	return Object.values(v).every(isClientRecord);
}

/** Parse the JSON-stringified registry; a missing/corrupt value → `{}`. */
function parseRegistry(raw: string | undefined): ClientRegistry {
	if (raw === undefined) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Corrupt clients blob → treat as no clients (a doctor-flaggable soft failure).
		return {};
	}
	return isRegistry(parsed) ? parsed : {};
}

interface OauthState {
	jwtSecret: string | undefined;
	clients: ClientRegistry;
}

/** Read the OAuth state from its reserved credId bag (never throws; absent → empty state). */
function readState(path: string): OauthState {
	const bag = getCredentials(OAUTH_CRED_ID, path);
	const jwtSecretRaw = Object.hasOwn(bag, KEY_JWT_SECRET) ? bag[KEY_JWT_SECRET] : undefined;
	const clientsRaw = Object.hasOwn(bag, KEY_CLIENTS) ? bag[KEY_CLIENTS] : undefined;
	return {
		jwtSecret: jwtSecretRaw && jwtSecretRaw !== "" ? jwtSecretRaw : undefined,
		clients: parseRegistry(clientsRaw),
	};
}

/**
 * Persist the OAuth state into its reserved credId bag (throws on write failure).
 * `clients` is always written (even as `"{}"`) so a fully-removed registry clears
 * the key under `setCredentials`'s merge semantics; `jwtSecret` is written when set.
 */
function writeState(state: OauthState, path: string): void {
	const values: CredentialValues = { [KEY_CLIENTS]: JSON.stringify(state.clients) };
	if (state.jwtSecret) values[KEY_JWT_SECRET] = state.jwtSecret;
	setCredentials(OAUTH_CRED_ID, values, path);
}

/** Narrow an unknown catch value to an `Error` (AGENTS.md: `catch` is `unknown`). */
function toError(e: unknown): Error {
	return e instanceof Error ? e : new Error(String(e));
}

/** Look up a client by id. `undefined` when absent — used by `/oauth/token`. */
export function findClient(clientId: string, path: string = credentialsPath()): ClientRecord | undefined {
	const clients = readState(path).clients;
	return Object.hasOwn(clients, clientId) ? clients[clientId] : undefined;
}

/** List registered clients (id + non-secret metadata), oldest first. */
export function listClients(path: string = credentialsPath()): ClientInfo[] {
	const clients = readState(path).clients;
	return Object.entries(clients)
		.map(([clientId, r]) => ({ clientId, label: r.label, createdAt: r.createdAt }))
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Issue a new client: mint id + plaintext secret, persist the hash, and return the
 * plaintext **once** (it is never stored). `err` only on a write failure (the
 * throwing persistence boundary wrapped into the Result spine).
 */
export function issueClient(label: string, path: string = credentialsPath()): Result<IssuedClient, Error> {
	const state = readState(path);
	const clientId = newClientId();
	const plaintextSecret = newClientSecret();
	state.clients[clientId] = {
		secretHash: hashSecret(plaintextSecret),
		label,
		createdAt: new Date().toISOString(),
	};
	try {
		writeState(state, path);
	} catch (e) {
		return err(toError(e));
	}
	return ok({ clientId, plaintextSecret });
}

/** Remove a client by id. Idempotent — `ok` when the id was already absent. `err` on write failure. */
export function removeClient(clientId: string, path: string = credentialsPath()): Result<void, Error> {
	const state = readState(path);
	if (!Object.hasOwn(state.clients, clientId)) return ok(undefined);
	delete state.clients[clientId];
	try {
		writeState(state, path);
	} catch (e) {
		return err(toError(e));
	}
	return ok(undefined);
}

/** The symmetric JWT signing secret — the persisted one, or minted + persisted on first use. */
export function ensureJwtSecret(path: string = credentialsPath()): string | undefined {
	const state = readState(path);
	if (state.jwtSecret) return state.jwtSecret;
	const secret = randomBytes(48).toString("base64url");
	try {
		writeState({ ...state, jwtSecret: secret }, path);
	} catch {
		// Unwritable cred dir → the token grant surfaces a clean error (undefined, never throws).
		return undefined;
	}
	return secret;
}

/**
 * Resolve the jwtSecret for signing/verifying: `OAUTH_JWT_SECRET` (env) wins; else
 * the persisted/minted one. The single source of the secret for the `/oauth/token`
 * grant (20c) + the auth middleware (20d). `undefined` when neither is available.
 */
export function resolveJwtSecret(
	env: NodeJS.ProcessEnv = process.env,
	path: string = credentialsPath(),
): string | undefined {
	const envSecret = env.OAUTH_JWT_SECRET;
	return envSecret && envSecret.trim() !== "" ? envSecret : ensureJwtSecret(path);
}
