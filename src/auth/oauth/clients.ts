/**
 * OAuth client registry + jwtSecret mint (spec 20b).
 *
 * The client-credentials AS (spec 20) needs two persisted secrets: the OAuth
 * **client registry** (`id → { label, createdAt, grantTypes, tokenEndpointAuthMethod,
 * secretHash? }`) and one symmetric **jwtSecret** that signs + verifies the HS256
 * access tokens (spec 20a). Both persist to `~/.openhammer/credentials.json`
 * (`0600`) — the spec-17e secrets store.
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

/** Reserved credId for the global operator login (the `/authorize` fallback). */
const LOGIN_CRED_ID = "__openhammer_login__";
/** Bag key for the operator login username. */
const KEY_LOGIN_USERNAME = "username";
/** Bag key for the SHA-256 hash of the operator login password. */
const KEY_LOGIN_PASSWORD_HASH = "passwordHash";

/** OAuth grant type: machine-to-machine (`client_id`+`secret` → token, no user). */
export const GRANT_CLIENT_CREDENTIALS = "client_credentials";
/** OAuth grant type: authorization code + PKCE (browser login → code → token). */
export const GRANT_AUTHORIZATION_CODE = "authorization_code";

/**
 * Token-endpoint auth method (RFC 9700) — how a client authenticates at `/oauth/token`.
 * Combined with the grant type this decides whether a client is **public** (no secret —
 * PKCE + the `/authorize` login are the authentication) or **confidential** (a minted
 * `client_secret`, validated when sent). Dynamic registration (`/register`) reads the
 * client's choice; the client-type picker infers it.
 */
export const TOKEN_ENDPOINT_AUTH_NONE = "none";
export const TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST = "client_secret_post";

/** Prefix on every OAuth client id (so a client id is never a channel UUID). */
const CLIENT_ID_PREFIX = "oh_";

/**
 * One registered client — only the **hashes** are stored (plaintexts are shown once).
 *
 * A client is **confidential** when {@link tokenEndpointAuthMethod} is `client_secret_post`
 * (it then carries a {@link secretHash}); **public** when `"none"` (no secret — PKCE + the
 * `/authorize` login authenticate it, RFC 9700). Dynamic registration + the client-type
 * picker set the method; the field is always populated in memory ({@link normalizeRecord}
 * infers it for legacy records), so callers can branch on it without a separate lookup.
 */
export interface ClientRecord {
	label: string;
	createdAt: string;
	/** OAuth grants this client may use — `client_credentials` and/or `authorization_code`. */
	grantTypes: string[];
	/** Token-endpoint auth method — `none` (public) or `client_secret_post` (confidential). */
	tokenEndpointAuthMethod: string;
	/** Present only for confidential clients (`client_secret_post`). Absent for public clients. */
	secretHash?: string;
	/** Registered redirect URIs (authorization-code clients). */
	redirectUris?: string[];
	/** Per-client login identity (authorization-code clients with their own login). */
	username?: string;
	/** SHA-256 hash of the per-client login password (never the plaintext). */
	passwordHash?: string;
}

/** A client as {@link listClients} exposes it: id + the non-secret metadata. */
export interface ClientInfo {
	clientId: string;
	label: string;
	createdAt: string;
	/** OAuth grants this client may use. */
	grantTypes: string[];
	/** Token-endpoint auth method — `none` (public) or `client_secret_post` (confidential). */
	tokenEndpointAuthMethod?: string;
	/** Per-client login identity when set (never any hash). */
	username?: string;
	/** Registered redirect URIs (authorization-code clients). */
	redirectUris?: string[];
}

/** A freshly issued client — the plaintext secret is returned ONCE (absent for public clients). */
export interface IssuedClient {
	clientId: string;
	/** Plaintext secret — shown once at issue; only the hash is persisted. `undefined` for public clients. */
	plaintextSecret?: string;
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

/**
 * Verify a per-client login (username + password) for an authorization-code client.
 * `false` when the client has no login configured, the username mismatches, or the
 * password is wrong. The password reuses {@link verifySecret}'s constant-time SHA-256
 * compare; the username is a plain compare (it is an identity, not a secret).
 */
export function verifyClientLogin(client: ClientRecord, username: string, password: string): boolean {
	if (client.username === undefined || client.passwordHash === undefined) return false;
	if (client.username !== username) return false;
	return verifySecret(password, client.passwordHash);
}

/** A value is an array of strings. */
function isStringArray(v: unknown): v is string[] {
	return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/**
 * The on-disk shape of one client: `grantTypes` may be absent on legacy records
 * (issued before the authorization-code grant existed) — {@link normalizeRecord}
 * fills the `client_credentials` default so a v1 client keeps working unchanged.
 * `secretHash`/`tokenEndpointAuthMethod` may both be absent on legacy records issued
 * before public clients existed; {@link normalizeRecord} infers the method so every
 * in-memory {@link ClientRecord} carries one.
 */
interface StoredClientRecord {
	label: string;
	createdAt: string;
	grantTypes?: string[];
	tokenEndpointAuthMethod?: string;
	secretHash?: string;
	redirectUris?: string[];
	username?: string;
	passwordHash?: string;
}

/** The on-disk registry shape (`grantTypes` optional per record for legacy compat). */
type StoredRegistry = Record<string, StoredClientRecord>;

/** Type guard for one stored client record (hand-narrowed; no `as`). */
function isStoredClientRecord(v: unknown): v is StoredClientRecord {
	if (typeof v !== "object" || v === null) return false;
	if (!("label" in v) || typeof v.label !== "string") return false;
	if (!("createdAt" in v) || typeof v.createdAt !== "string") return false;
	if ("grantTypes" in v && !isStringArray(v.grantTypes)) return false;
	if ("tokenEndpointAuthMethod" in v && typeof v.tokenEndpointAuthMethod !== "string") return false;
	if ("secretHash" in v && typeof v.secretHash !== "string") return false;
	if ("redirectUris" in v && !isStringArray(v.redirectUris)) return false;
	if ("username" in v && typeof v.username !== "string") return false;
	if ("passwordHash" in v && typeof v.passwordHash !== "string") return false;
	return true;
}

/** Type guard for the stored registry (a plain object whose every value is a stored record). */
function isStoredRegistry(v: unknown): v is StoredRegistry {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	return Object.values(v).every(isStoredClientRecord);
}

/**
 * Normalize a stored record into a {@link ClientRecord}: legacy records with no
 * `grantTypes` default to `["client_credentials"]` (the v1 behavior), so an existing
 * client keeps working after the upgrade. The token-endpoint auth method is inferred
 * for legacy records (a stored `secretHash` ⇒ confidential `client_secret_post`;
 * none ⇒ public `none`) so every in-memory record carries one. Optional fields are
 * dropped when empty so the re-written registry stays minimal.
 */
function normalizeRecord(rec: StoredClientRecord): ClientRecord {
	const grantTypes = rec.grantTypes && rec.grantTypes.length > 0 ? [...rec.grantTypes] : [GRANT_CLIENT_CREDENTIALS];
	const record: ClientRecord = {
		label: rec.label,
		createdAt: rec.createdAt,
		grantTypes,
		tokenEndpointAuthMethod:
			rec.tokenEndpointAuthMethod ??
			(rec.secretHash !== undefined ? TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST : TOKEN_ENDPOINT_AUTH_NONE),
	};
	if (rec.secretHash !== undefined) record.secretHash = rec.secretHash;
	if (rec.redirectUris && rec.redirectUris.length > 0) record.redirectUris = [...rec.redirectUris];
	if (typeof rec.username === "string" && rec.username !== "") record.username = rec.username;
	if (typeof rec.passwordHash === "string" && rec.passwordHash !== "") record.passwordHash = rec.passwordHash;
	return record;
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
	if (!isStoredRegistry(parsed)) return {};
	const out: ClientRegistry = {};
	for (const [id, rec] of Object.entries(parsed)) out[id] = normalizeRecord(rec);
	return out;
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

// ── Pending (dynamically-registered, not-yet-authorized) clients ───────────────

/**
 * How long a dynamically-registered client stays "pending" (registered but not yet
 * authorized by a login). Mirrors the auth-code lifetime — a client whose registration is
 * never followed by a login evaporates, so the client re-registers cleanly on next connect
 * (no accumulating ghost records).
 */
const PENDING_CLIENT_TTL_MS = 10 * 60 * 1000;

interface PendingClient {
	record: ClientRecord;
	expiresAt: number;
}

/**
 * In-memory pending clients: registered via `/register` ({@link issueClient} `stage:true`)
 * but not yet authorized by an `/authorize` login. Single-instance, like the auth-code stores
 * in `auth-code.ts`. **Not persisted** — never surfaced by {@link listClients} (so the
 * dashboard shows no "ghost" clients from abandoned registrations); {@link findClient}
 * resolves them so the OAuth dance completes; {@link commitClient} promotes a pending client
 * to the persisted registry on a successful login.
 */
const pendingClients = new Map<string, PendingClient>();

/** Drop expired pending clients (best-effort hygiene; returns the count removed). */
export function prunePendingClients(now: number = Date.now()): number {
	let removed = 0;
	for (const [id, pending] of pendingClients) {
		if (pending.expiresAt < now) {
			pendingClients.delete(id);
			removed++;
		}
	}
	return removed;
}

/** Reset the pending store (test/operational hygiene — mirrors `resetAuthCodeStores`). */
export function resetPendingClients(): void {
	pendingClients.clear();
}

/**
 * Promote a pending (dynamically-registered, not-yet-authorized) client to the persisted
 * registry. Called when the `/authorize` login succeeds, so a client record is created ONLY
 * when the operator has authenticated the registration — abandoned registrations never reach
 * disk. Best-effort: a write failure leaves the client pending ({@link findClient} still
 * resolves it for the in-flight exchange) and returns `false`. Returns `false` when the id is
 * not pending (already committed, or never staged).
 */
export function commitClient(clientId: string, path: string = credentialsPath()): boolean {
	const pending = pendingClients.get(clientId);
	if (pending === undefined) return false;
	const state = readState(path);
	state.clients[clientId] = pending.record;
	try {
		writeState(state, path);
	} catch {
		return false; // leave pending — findClient still resolves it for the in-flight exchange
	}
	pendingClients.delete(clientId);
	return true;
}

/** Look up a client by id. `undefined` when absent — used by `/oauth/token`. */
export function findClient(clientId: string, path: string = credentialsPath()): ClientRecord | undefined {
	prunePendingClients();
	const pending = pendingClients.get(clientId);
	if (pending !== undefined) return pending.record;
	const clients = readState(path).clients;
	return Object.hasOwn(clients, clientId) ? clients[clientId] : undefined;
}

/** List registered clients (id + non-secret metadata), oldest first. */
export function listClients(path: string = credentialsPath()): ClientInfo[] {
	const clients = readState(path).clients;
	return Object.entries(clients)
		.map(([clientId, r]) => {
			const info: ClientInfo = {
				clientId,
				label: r.label,
				createdAt: r.createdAt,
				grantTypes: r.grantTypes,
				tokenEndpointAuthMethod: r.tokenEndpointAuthMethod,
			};
			if (r.username !== undefined) info.username = r.username;
			if (r.redirectUris !== undefined) info.redirectUris = r.redirectUris;
			return info;
		})
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Options for {@link issueClient}. */
export interface IssueClientOptions {
	/** Grants the client may use; default `["client_credentials"]`. */
	grantTypes?: string[];
	/** Registered redirect URIs (authorization-code clients). */
	redirectUris?: string[];
	/** Per-client login identity (authorization-code clients with their own login). */
	username?: string;
	/** Plaintext per-client login password — hashed before store; never persisted. */
	password?: string;
	/**
	 * Token-endpoint auth method: `"none"` (public — no secret; PKCE + the `/authorize`
	 * login authenticate) or `"client_secret_post"` (confidential — mints a `client_secret`
	 * whose hash is stored). `undefined` → inferred from {@link grantTypes}
	 * (`client_credentials` ⇒ confidential, else public) so legacy callers keep working.
	 * Defaulting to public (not the RFC's `client_secret_basic`) is deliberate: this server
	 * only advertises `none`/`client_secret_post` and MCP clients are public-by-default.
	 */
	tokenEndpointAuthMethod?: string;
	/**
	 * Hold the new client in the in-memory **pending** store instead of persisting it — for
	 * Dynamic Client Registration (`/register`), so a dynamically-registered client is only
	 * persisted once the operator authorizes it at `/authorize` ({@link commitClient}). Manual
	 * `add-client` omits this (persists immediately — operator-intentional). Default `false`.
	 */
	stage?: boolean;
}

/**
 * Issue a new client: mint id, persist only the hashes, and return the plaintext secret
 * **once** (it is never stored). A **confidential** client (`client_secret_post`) gets a
 * minted `client_secret`; a **public** client (`none`) gets none — PKCE + the `/authorize`
 * login authenticate it. `opts` selects the grant type(s) + auth method, and for
 * authorization-code clients the redirect URIs + optional per-client login. A username
 * without a password is stored without a `passwordHash` (so it cannot log in); the wizard
 * enforces both together. `err` only on a write failure (the throwing persistence boundary
 * wrapped into the Result spine).
 */
export function issueClient(
	label: string,
	opts: IssueClientOptions = {},
	path: string = credentialsPath(),
): Result<IssuedClient, Error> {
	const clientId = newClientId();
	const grantTypes = opts.grantTypes && opts.grantTypes.length > 0 ? [...opts.grantTypes] : [GRANT_CLIENT_CREDENTIALS];
	const tokenEndpointAuthMethod =
		opts.tokenEndpointAuthMethod ??
		// Infer for callers that don't say: client_credentials has no PKCE/redirect step to
		// substitute for a secret, so it is confidential; authorization_code is public.
		(grantTypes.includes(GRANT_CLIENT_CREDENTIALS)
			? TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST
			: TOKEN_ENDPOINT_AUTH_NONE);
	const confidential = tokenEndpointAuthMethod === TOKEN_ENDPOINT_AUTH_CLIENT_SECRET_POST;
	const plaintextSecret = confidential ? newClientSecret() : undefined;
	const record: ClientRecord = {
		label,
		createdAt: new Date().toISOString(),
		grantTypes,
		tokenEndpointAuthMethod,
	};
	if (confidential && plaintextSecret !== undefined) record.secretHash = hashSecret(plaintextSecret);
	if (opts.redirectUris && opts.redirectUris.length > 0) record.redirectUris = [...opts.redirectUris];
	if (typeof opts.username === "string" && opts.username.trim() !== "") {
		record.username = opts.username.trim();
		if (typeof opts.password === "string" && opts.password !== "") record.passwordHash = hashSecret(opts.password);
	}
	if (opts.stage === true) {
		// Dynamic registration: hold the record in memory, NOT persisted. It is invisible to
		// listClients (no ghost client in the dashboard) but findClient resolves it so the OAuth
		// dance completes; commitClient promotes it to disk on a successful /authorize login.
		pendingClients.set(clientId, { record, expiresAt: Date.now() + PENDING_CLIENT_TTL_MS });
		return ok({ clientId, plaintextSecret });
	}
	const state = readState(path);
	state.clients[clientId] = record;
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
 * Read-only resolve of the jwtSecret for diagnostics: `OAUTH_JWT_SECRET` (env) wins;
 * else the persisted one. Unlike {@link resolveJwtSecret}, this does **not** mint —
 * `doctor` (20f) must not mutate state. `undefined` when neither is set.
 */
export function peekJwtSecret(
	env: NodeJS.ProcessEnv = process.env,
	path: string = credentialsPath(),
): string | undefined {
	const envSecret = env.OAUTH_JWT_SECRET;
	if (envSecret && envSecret.trim() !== "") return envSecret;
	return readState(path).jwtSecret;
}

/**
 * Resolve the jwtSecret for signing/verifying: `OAUTH_JWT_SECRET` (env) wins; else
 * the persisted/minted one. The single source of the secret for the `/oauth/token`
 * grant (20c) + the auth middleware (20d). `undefined` when neither is available
 * (an unwritable cred dir + no env — the grant surfaces its own `server_error`).
 * Delegates the read to {@link peekJwtSecret} (single source for the env/whitespace
 * check), then mints on first use if still absent.
 */
export function resolveJwtSecret(
	env: NodeJS.ProcessEnv = process.env,
	path: string = credentialsPath(),
): string | undefined {
	return peekJwtSecret(env, path) ?? ensureJwtSecret(path);
}

// ── Global operator login (the `/authorize` fallback) ──────────────────────────

/**
 * Set the global operator login (username + password). This is the credential a
 * client without its own per-client login — e.g. one created dynamically by
 * `/register` — must present at `/authorize`. The password is stored only as a
 * SHA-256 hash; the plaintext is discarded. Throws on a write failure (the
 * persistence boundary — wrap at the edge).
 */
export function setOperatorLogin(username: string, password: string, path: string = credentialsPath()): void {
	setCredentials(
		LOGIN_CRED_ID,
		{ [KEY_LOGIN_USERNAME]: username, [KEY_LOGIN_PASSWORD_HASH]: hashSecret(password) },
		path,
	);
}

/** Whether a global operator login is configured (both username + hash present). */
export function hasOperatorLogin(path: string = credentialsPath()): boolean {
	const bag = getCredentials(LOGIN_CRED_ID, path);
	const username = Object.hasOwn(bag, KEY_LOGIN_USERNAME) ? bag[KEY_LOGIN_USERNAME] : "";
	const hash = Object.hasOwn(bag, KEY_LOGIN_PASSWORD_HASH) ? bag[KEY_LOGIN_PASSWORD_HASH] : "";
	return username !== "" && hash !== "";
}

/**
 * Verify the global operator login. `false` when no login is configured, the
 * username mismatches, or the password is wrong (constant-time SHA-256 compare via
 * {@link verifySecret}).
 */
export function verifyOperatorLogin(username: string, password: string, path: string = credentialsPath()): boolean {
	const bag = getCredentials(LOGIN_CRED_ID, path);
	const storedUsername = Object.hasOwn(bag, KEY_LOGIN_USERNAME) ? bag[KEY_LOGIN_USERNAME] : "";
	const hash = Object.hasOwn(bag, KEY_LOGIN_PASSWORD_HASH) ? bag[KEY_LOGIN_PASSWORD_HASH] : "";
	if (storedUsername === "" || hash === "") return false;
	if (storedUsername !== username) return false;
	return verifySecret(password, hash);
}
