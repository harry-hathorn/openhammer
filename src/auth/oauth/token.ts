/**
 * OAuth 2.0 Authorization Server (spec 20 + the auth-code extension).
 *
 * Mounts a full AS so MCP clients that cannot set a raw `Authorization: Bearer`
 * header connect natively:
 *
 * - **client-credentials** (RFC 6749 §4.4) — machine clients `POST` `client_id` +
 *   `client_secret` to `/oauth/token` for an HS256 `access_token`.
 * - **authorization-code + PKCE** (RFC 6749 §4.1 / RFC 7636) — Claude web/Code
 *   redirect a user to `GET /oauth/authorize` (a username/password login form),
 *   the server mints a one-time code, and the client exchanges it at `/oauth/token`
 *   (verifying the PKCE challenge) for an access token + a rotating refresh token.
 * - **dynamic client registration** (RFC 7591) — `POST /register` mints an
 *   authorization-code client (Claude web self-registers here). Public; the login
 *   still gates access.
 *
 * The login at `/oauth/authorize` resolves the client's own credentials when it has
 * any, else the global operator login (`clients.ts`'s operator-login store) — so a
 * dynamically-registered client (no per-client credentials) still authenticates.
 *
 * This module mounts onto `fastify`:
 *
 * - `@fastify/formbody` — OAuth token + authorize requests are form-encoded
 *   (`application/x-www-form-urlencoded`, RFC 6749 §2.1); Fastify's built-in parser
 *   only handles JSON, so formbody parses them. It only fires for that content-type,
 *   so `/mcp` (JSON-RPC over JSON) is unaffected. `/register` is JSON (RFC 7591).
 * - `GET /.well-known/oauth-authorization-server` (RFC 8414) — public; advertises the
 *   authorization/token/registration endpoints + supported grants/Methods.
 * - `GET`/`POST /oauth/authorize` — the login form + code issuance.
 * - `POST /oauth/token` — the grant dispatcher (client_credentials /
 *   authorization_code / refresh_token).
 * - `POST /register` — RFC 7591 dynamic client registration.
 *
 * None are behind the bearer preHandler — `/oauth/token` **is** the auth (it mints
 * the token), and discovery + authorize must precede auth.
 *
 * **Edge, not `Result`.** Per spec 20's boundary posture (auth is an edge), the
 * grant handlers `reply` (`400 invalid_grant` / `401 invalid_client`) — they do not
 * return a `Result`. The `Result` spine applies to the client-management mutations in
 * `clients.ts` (20b), not to this request edge.
 *
 * **Issuer/audience (single source).** The JWT `iss` is the server's base URL (the AS
 * issuer, matching RFC 8414's `issuer`); `aud` is the protected MCP resource
 * (`${baseUrl}/mcp`). Both are **derived from `baseUrl`** (the public base URL
 * resolved by `main.ts`: tunnel URL → `MCP_PUBLIC_URL` → localhost), and both the sign
 * path here and the verify path in the auth middleware (20d) resolve them from the
 * same `oauthIssuerAudience(baseUrl)` — the single source.
 */
import formbody from "@fastify/formbody";
import type { FastifyInstance, FastifyReply } from "fastify";
import { credentialsPath } from "../../config/credentials.ts";
import {
	buildLoginForm,
	consumeCode,
	escapeHtml,
	generateCode,
	issueRefreshToken,
	redeemRefreshToken,
} from "./auth-code.ts";
import {
	type ClientRecord,
	findClient,
	GRANT_AUTHORIZATION_CODE,
	issueClient,
	resolveJwtSecret,
	verifyClientLogin,
	verifyOperatorLogin,
	verifySecret,
} from "./clients.ts";
import { signAccessToken } from "./jwt.ts";

/** Access-token lifetime in seconds (~1h; revocation is the TTL — spec 20). */
export const ACCESS_TOKEN_TTL_SEC = 3600;

/**
 * The JWT issuer + audience derived from the server's reachable base URL. `iss`
 * is the AS issuer (its base URL — matches RFC 8414's `issuer`); `aud` is the
 * protected MCP resource (`${baseUrl}/mcp`). The single source for both the
 * `/oauth/token` sign (here) and the middleware verify (20d) — derived, not a
 * hardcoded constant, so they track the configured host:port.
 */
export function oauthIssuerAudience(baseUrl: string): { issuer: string; audience: string } {
	return { issuer: baseUrl, audience: `${baseUrl}/mcp` };
}

/**
 * RFC 8414 authorization-server metadata advertised at
 * `/.well-known/oauth-authorization-server`. `issuer` is the server base URL;
 * `grant_types_supported` pins the AS to the client-credentials grant;
 * `token_endpoint_auth_methods_supported` advertises `client_secret_post`
 * (secrets in the body — the only method the grant reads). An OAuth-only client
 * uses this to discover the token endpoint and connect end-to-end.
 */
export function oauthAuthorizationServerMetadata(baseUrl: string): Record<string, unknown> {
	return {
		issuer: baseUrl,
		authorization_endpoint: `${baseUrl}/oauth/authorize`,
		token_endpoint: `${baseUrl}/oauth/token`,
		registration_endpoint: `${baseUrl}/register`,
		response_types_supported: ["code"],
		grant_types_supported: ["client_credentials", "authorization_code", "refresh_token"],
		token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
		code_challenge_methods_supported: ["S256"],
		scopes_supported: [],
		service_documentation: `${baseUrl}/docs`,
	};
}

/** Type guard narrowing an unknown request body to a string-keyed record (no `as`). */
function isRecord(body: unknown): body is Record<string, unknown> {
	return typeof body === "object" && body !== null && !Array.isArray(body);
}

/** Coerce an unknown query/form value to a string (`""` when absent/non-string). */
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/**
 * A redirect_uri is allowed when it exactly matches one the client registered. **Open mode:** when the
 * client registered none, any `https://` (or loopback `http://`) callback is accepted — so a client
 * (Claude web via `/register`, or a pre-registered one) needs no manually-added redirect URI. The
 * `/authorize` login still gates code issuance, and the code is single-use + bound to the redirect_uri
 * at `/token`, so a permissive default is safe for a single-operator server; register explicit URIs
 * to opt back into strict exact-match for a client.
 */
function isRedirectUriAllowed(client: ClientRecord, redirectUri: string): boolean {
	if (client.redirectUris !== undefined && client.redirectUris.length > 0) {
		return client.redirectUris.includes(redirectUri);
	}
	try {
		const url = new URL(redirectUri);
		return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"));
	} catch {
		return false;
	}
}

/**
 * Resolve the `/authorize` login: the client's own credentials when it has any, else
 * the global operator login (the fallback for a dynamically-registered client, which
 * has no per-client login). `false` on any mismatch — the password compare is
 * constant-time inside the clients module.
 */
function loginValid(client: ClientRecord, username: string, password: string, credPath: string): boolean {
	if (client.username !== undefined && client.passwordHash !== undefined) {
		return verifyClientLogin(client, username, password);
	}
	return verifyOperatorLogin(username, password, credPath);
}

/** Options for {@link registerOauthRoutes}. */
export interface OauthRoutesOptions {
	/** Server base URL (`protocol://host[:port]`) — the AS issuer + token-endpoint root. */
	baseUrl: string;
	/** Credentials.json path (test injection; default = real `~/.openhammer/credentials.json`). */
	credentialsPath?: string;
	/** Process env for `OAUTH_JWT_SECRET` (test injection; default = `process.env`). */
	env?: NodeJS.ProcessEnv;
}

/**
 * Register the OAuth AS routes on `fastify`: formbody (so form posts parse),
 * the RFC 8414 metadata (public), and `POST /oauth/token` (the
 * client-credentials grant). None of these are behind the bearer preHandler —
 * `/oauth/token` **is** the auth (it mints the token), and the metadata must
 * precede auth so a client can discover the grant.
 */
export async function registerOauthRoutes(fastify: FastifyInstance, opts: OauthRoutesOptions): Promise<void> {
	const { baseUrl } = opts;
	const credPath = opts.credentialsPath ?? credentialsPath();
	const env = opts.env ?? process.env;
	const { issuer, audience } = oauthIssuerAudience(baseUrl);

	// Form bodies are the OAuth norm (RFC 6749 §2.1). Registered globally — the
	// parser only fires for `application/x-www-form-urlencoded`, which `/mcp`
	// (JSON-RPC over JSON) never sends, so the MCP transport is unaffected.
	await fastify.register(formbody);

	// RFC 8414 metadata — public (discovery precedes auth).
	fastify.get("/.well-known/oauth-authorization-server", async () => oauthAuthorizationServerMetadata(baseUrl));

	// GET /oauth/authorize — render the login form (RFC 6749 §3.1). Validates the
	// client is registered for the authorization_code grant + that the redirect_uri is
	// one it registered, then renders the username/password form with the OAuth params
	// as hidden inputs. Errors that can't be safely redirected (bad client or
	// redirect_uri) return 400 JSON; a PKCE-method error returns 400 too.
	fastify.get("/oauth/authorize", async (req, reply) => {
		const q = isRecord(req.query) ? req.query : {};
		const clientId = str(q.client_id);
		const redirectUri = str(q.redirect_uri);
		const state = str(q.state);
		const codeChallenge = str(q.code_challenge);
		const codeChallengeMethod = str(q.code_challenge_method);
		const errorParam = str(q.error);

		if (clientId === "" || redirectUri === "" || codeChallenge === "") {
			return reply.code(400).send({ error: "invalid_request", error_description: "Missing required parameters" });
		}
		if (codeChallengeMethod !== "" && codeChallengeMethod !== "S256") {
			return reply
				.code(400)
				.send({ error: "invalid_request", error_description: "Only S256 code_challenge_method is supported" });
		}
		const client = findClient(clientId, credPath);
		if (client === undefined) {
			return reply.code(400).send({ error: "invalid_client", error_description: "Unknown client_id" });
		}
		if (!client.grantTypes.includes(GRANT_AUTHORIZATION_CODE)) {
			return reply
				.code(400)
				.send({ error: "unauthorized_client", error_description: "Client not authorized for authorization_code" });
		}
		if (!isRedirectUriAllowed(client, redirectUri)) {
			return reply
				.code(400)
				.send({ error: "invalid_request", error_description: "redirect_uri not registered for this client" });
		}
		const errorHtml = errorParam !== "" ? `<p class="error">${escapeHtml(decodeURIComponent(errorParam))}</p>` : "";
		reply.type("text/html");
		return reply.send(
			buildLoginForm({
				clientId,
				clientName: client.label.trim() !== "" ? client.label : clientId,
				redirectUri,
				state,
				codeChallenge,
				errorHtml,
			}),
		);
	});

	// POST /oauth/authorize — validate the login + mint the code (RFC 6749 §3.1.1).
	// Login resolves per-client credentials first, else the global operator login (so
	// a dynamically-registered client with no per-client login still authenticates). A
	// failed login redirects back to GET with an `error`; success redirects to the
	// client's redirect_uri with the one-time `code` (+ echoed `state`).
	fastify.post("/oauth/authorize", async (req, reply) => {
		const body = isRecord(req.body) ? req.body : {};
		const clientId = str(body.client_id);
		const redirectUri = str(body.redirect_uri);
		const state = str(body.state);
		const codeChallenge = str(body.code_challenge);
		const username = str(body.username);
		const password = str(body.password);

		if (clientId === "" || redirectUri === "" || codeChallenge === "" || username === "" || password === "") {
			return reply.code(400).send({ error: "invalid_request", error_description: "Missing required parameters" });
		}
		const client = findClient(clientId, credPath);
		if (client === undefined || !isRedirectUriAllowed(client, redirectUri)) {
			return reply.code(400).send({ error: "invalid_client", error_description: "Invalid client or redirect_uri" });
		}
		if (!loginValid(client, username, password, credPath)) {
			const params = new URLSearchParams({
				client_id: clientId,
				redirect_uri: redirectUri,
				state,
				code_challenge: codeChallenge,
				code_challenge_method: "S256",
				error: "Invalid username or password",
			});
			return reply.redirect(`/oauth/authorize?${params.toString()}`);
		}
		const code = generateCode({ clientId, redirectUri, codeChallenge, username });
		const redirectParams = new URLSearchParams({ code });
		if (state !== "") redirectParams.set("state", state);
		return reply.redirect(`${redirectUri}?${redirectParams.toString()}`);
	});

	// POST /oauth/token — the grant dispatcher (RFC 6749). `client_credentials` is the
	// original v1 grant; `authorization_code` + `refresh_token` back the auth-code flow.
	fastify.post("/oauth/token", async (req, reply) => {
		const body = isRecord(req.body) ? req.body : {};
		switch (str(body.grant_type)) {
			case "client_credentials":
				return handleClientCredentials(body, reply);
			case "authorization_code":
				return handleAuthorizationCode(body, reply);
			case "refresh_token":
				return handleRefreshToken(body, reply);
			default:
				// RFC 6749 §5.2 — any unrecognized grant.
				return reply.code(400).send({ error: "unsupported_grant_type" });
		}
	});

	// POST /register — RFC 7591 dynamic client registration. Creates an
	// authorization_code client (Claude web registers itself here). Public; the
	// /authorize login still gates access, so a registered client can do nothing
	// without valid operator credentials.
	fastify.post("/register", async (req, reply) => {
		const body = isRecord(req.body) ? req.body : {};
		const clientName =
			typeof body.client_name === "string" && body.client_name.trim() !== ""
				? body.client_name.trim()
				: "Dynamic registration";
		const redirectUris = Array.isArray(body.redirect_uris)
			? body.redirect_uris.filter((u): u is string => typeof u === "string")
			: [];
		const result = issueClient(clientName, { grantTypes: [GRANT_AUTHORIZATION_CODE], redirectUris }, credPath);
		if (!result.ok) {
			return reply.code(500).send({ error: "server_error", error_description: "client registration failed" });
		}
		return reply.code(201).send({
			client_id: result.value.clientId,
			client_secret: result.value.plaintextSecret,
			client_id_issued_at: Math.floor(Date.now() / 1000),
			client_secret_expires_at: 0,
			client_name: clientName,
			grant_types: [GRANT_AUTHORIZATION_CODE],
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
		});
	});

	// Grant handlers — inner functions close over `credPath`/`env`/`issuer`/`audience`.

	/** `client_credentials` (RFC 6749 §4.4) — the original v1 machine grant. */
	async function handleClientCredentials(body: Record<string, unknown>, reply: FastifyReply): Promise<unknown> {
		const clientId = str(body.client_id);
		const clientSecret = str(body.client_secret);
		const client = clientId !== "" ? findClient(clientId, credPath) : undefined;
		// No matching client, or a wrong/missing secret → RFC 6749 `invalid_client` (401).
		if (client === undefined || !verifySecret(clientSecret, client.secretHash)) {
			return reply.code(401).send({ error: "invalid_client" });
		}
		const jwtSecret = resolveJwtSecret(env, credPath);
		// No jwtSecret available (unwritable cred dir + no `OAUTH_JWT_SECRET` env) →
		// cannot sign. RFC 6749 §5.2 `server_error`; not a client fault (500).
		if (jwtSecret === undefined) {
			return reply.code(500).send({ error: "server_error", error_description: "jwt secret unavailable" });
		}
		const accessToken = await signAccessToken(
			{ iss: issuer, aud: audience, sub: clientId, client_id: clientId },
			jwtSecret,
			ACCESS_TOKEN_TTL_SEC,
		);
		return reply.send({ access_token: accessToken, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL_SEC });
	}

	/** `authorization_code` (RFC 6749 §4.1) — consume the code (PKCE) + issue access + refresh. */
	async function handleAuthorizationCode(body: Record<string, unknown>, reply: FastifyReply): Promise<unknown> {
		const code = str(body.code);
		const clientId = str(body.client_id);
		const redirectUri = str(body.redirect_uri);
		const codeVerifier = str(body.code_verifier);
		if (code === "" || clientId === "" || redirectUri === "" || codeVerifier === "") {
			return reply.code(400).send({ error: "invalid_request", error_description: "Missing required parameters" });
		}
		const client = findClient(clientId, credPath);
		if (client === undefined || !client.grantTypes.includes(GRANT_AUTHORIZATION_CODE)) {
			return reply.code(400).send({ error: "invalid_client", error_description: "Client not authorized" });
		}
		const consumed = consumeCode(code, clientId, codeVerifier);
		if (consumed === null) {
			return reply
				.code(400)
				.send({ error: "invalid_grant", error_description: "Invalid, expired, or already used code" });
		}
		if (consumed.redirectUri !== redirectUri) {
			return reply.code(400).send({ error: "invalid_grant", error_description: "redirect_uri mismatch" });
		}
		const jwtSecret = resolveJwtSecret(env, credPath);
		if (jwtSecret === undefined) {
			return reply.code(500).send({ error: "server_error", error_description: "jwt secret unavailable" });
		}
		const accessToken = await signAccessToken(
			{ iss: issuer, aud: audience, sub: consumed.username, client_id: clientId },
			jwtSecret,
			ACCESS_TOKEN_TTL_SEC,
		);
		const refreshToken = issueRefreshToken({ clientId, username: consumed.username });
		return reply.send({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: ACCESS_TOKEN_TTL_SEC,
			refresh_token: refreshToken,
		});
	}

	/** `refresh_token` (RFC 6749 §6) — rotate the refresh + re-issue the access token. */
	async function handleRefreshToken(body: Record<string, unknown>, reply: FastifyReply): Promise<unknown> {
		const token = str(body.refresh_token);
		if (token === "") {
			return reply.code(400).send({ error: "invalid_request", error_description: "refresh_token required" });
		}
		const redeemed = redeemRefreshToken(token);
		if (redeemed === null) {
			return reply
				.code(400)
				.send({ error: "invalid_grant", error_description: "Invalid, expired, or reused refresh token" });
		}
		const jwtSecret = resolveJwtSecret(env, credPath);
		if (jwtSecret === undefined) {
			return reply.code(500).send({ error: "server_error", error_description: "jwt secret unavailable" });
		}
		const accessToken = await signAccessToken(
			{ iss: issuer, aud: audience, sub: redeemed.username, client_id: redeemed.clientId },
			jwtSecret,
			ACCESS_TOKEN_TTL_SEC,
		);
		const refreshToken = issueRefreshToken({ clientId: redeemed.clientId, username: redeemed.username });
		return reply.send({
			access_token: accessToken,
			token_type: "Bearer",
			expires_in: ACCESS_TOKEN_TTL_SEC,
			refresh_token: refreshToken,
		});
	}
}
