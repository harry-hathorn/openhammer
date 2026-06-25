import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, getCredentials, setCredentials } from "../../config/credentials.ts";
import { err, ok } from "../../tools/result.ts";
import {
	type ClientInfo,
	ensureJwtSecret,
	findClient,
	GRANT_AUTHORIZATION_CODE,
	GRANT_CLIENT_CREDENTIALS,
	hashSecret,
	hasOperatorLogin,
	issueClient,
	listClients,
	newClientId,
	newClientSecret,
	peekJwtSecret,
	removeClient,
	resolveJwtSecret,
	setOperatorLogin,
	verifyClientLogin,
	verifyOperatorLogin,
	verifySecret,
} from "./clients.ts";

/** Make a fresh temp `~/.openhammer` and return its credentials path. */
function tempCredPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "openhammer-oauth-"));
	return credentialsPath(dir);
}

/** Recurse-clean a temp dir created for a path under it. */
function rmUnder(path: string): void {
	// The temp dir is the parent of `.openhammer` — remove the whole temp root.
	rmSync(join(path, "..", ".."), { recursive: true, force: true });
}

describe("newClientId", () => {
	it("produces an `oh_`-prefixed 32-hex-char id", () => {
		const id = newClientId();
		expect(id.startsWith("oh_")).toBe(true);
		expect(id.slice(3)).toMatch(/^[0-9a-f]{32}$/);
	});

	it("produces unique ids", () => {
		const ids = new Set(Array.from({ length: 50 }, () => newClientId()));
		expect(ids.size).toBe(50);
	});
});

describe("newClientSecret", () => {
	it("produces a base64url secret of the expected length", () => {
		const secret = newClientSecret();
		// 32 random bytes → 43 base64url chars (no padding).
		expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("produces unique secrets", () => {
		const secrets = new Set(Array.from({ length: 50 }, () => newClientSecret()));
		expect(secrets.size).toBe(50);
	});
});

describe("hashSecret", () => {
	it("is deterministic (same input → same hash)", () => {
		expect(hashSecret("hunter2")).toBe(hashSecret("hunter2"));
	});

	it("produces a 64-char hex SHA-256 digest", () => {
		expect(hashSecret("hunter2")).toMatch(/^[0-9a-f]{64}$/);
	});

	it("differs across inputs", () => {
		expect(hashSecret("a")).not.toBe(hashSecret("b"));
	});
});

describe("verifySecret", () => {
	it("returns true for the matching secret", () => {
		expect(verifySecret("correct horse", hashSecret("correct horse"))).toBe(true);
	});

	it("returns false for a wrong secret", () => {
		expect(verifySecret("wrong", hashSecret("correct horse"))).toBe(false);
	});

	it("returns false (never throws) for a malformed hash of the wrong length", () => {
		// A length mismatch would make `timingSafeEqual` throw — the guard keeps it `false`.
		expect(verifySecret("anything", "tooshort")).toBe(false);
	});
});

describe("issueClient", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("issues a client with a plaintext secret + `oh_` id", () => {
		const result = issueClient("ci", {}, path);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.clientId.startsWith("oh_")).toBe(true);
		expect(result.value.plaintextSecret.length).toBeGreaterThan(0);
	});

	it("persists the hash (findable) but never the plaintext", () => {
		const result = issueClient("ci", {}, path);
		if (!result.ok) throw new Error("expected ok");

		const record = findClient(result.value.clientId, path);
		expect(record).toBeDefined();
		if (!record) return;
		expect(record.label).toBe("ci");
		expect(record.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		// The stored hash verifies the plaintext…
		expect(verifySecret(result.value.plaintextSecret, record.secretHash)).toBe(true);
		// …but the plaintext never appears in the file.
		expect(readFileSync(path, "utf-8")).not.toContain(result.value.plaintextSecret);
	});

	it("returns err when the cred dir is unwritable", () => {
		// A regular file as a path component → `mkdir` ENOTDIR regardless of uid
		// (root bypasses a perms-based block, but not ENOTDIR). `blocker` sits in the
		// existing temp root so its parent already exists.
		const blocker = join(path, "..", "..", "blocker");
		writeFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "credentials.json");

		const result = issueClient("ci", {}, blockedPath);
		expect(result).toEqual(err(expect.any(Error)));
		expect(existsSync(blockedPath)).toBe(false);
	});
});

describe("findClient", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("returns undefined for an absent id", () => {
		expect(findClient("oh_missing", path)).toBeUndefined();
	});

	it("verifies the issued secret round-trip", () => {
		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");
		const record = findClient(issued.value.clientId, path);
		expect(record && verifySecret(issued.value.plaintextSecret, record.secretHash)).toBe(true);
	});
});

describe("listClients", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("returns an empty list when none are registered", () => {
		expect(listClients(path)).toEqual([]);
	});

	it("lists registered clients (id + label + createdAt), never the secret hash", () => {
		const a = issueClient("ci-a", {}, path);
		const b = issueClient("ci-b", {}, path);
		if (!a.ok || !b.ok) throw new Error("expected ok");

		const list: ClientInfo[] = listClients(path);
		expect(list.map((c) => c.clientId).sort()).toEqual([a.value.clientId, b.value.clientId].sort());
		const labels = list.map((c) => c.label).sort();
		expect(labels).toEqual(["ci-a", "ci-b"]);
		expect(list.every((c) => !("secretHash" in c))).toBe(true);
	});
});

describe("removeClient", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("removes a registered client", () => {
		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");

		expect(removeClient(issued.value.clientId, path)).toEqual(ok(undefined));
		expect(findClient(issued.value.clientId, path)).toBeUndefined();
	});

	it("is idempotent — ok when the id was already absent", () => {
		expect(removeClient("oh_never", path)).toEqual(ok(undefined));
	});

	it("short-circuits to ok (no write, no throw) for an absent id even on an unwritable path", () => {
		// removeClient's `err` wraps the SAME writeState as issueClient (tested above),
		// so it can't be isolated hermetically: hitting the write-failure path needs the
		// client present (read succeeds) yet the dir unwritable — root bypasses the only
		// write-block, and ENOTDIR fails the read first. This instead pins the
		// idempotent short-circuit (absent id → `ok`, no write attempted) against an
		// unwritable location, proving it never throws.
		const blocker = join(path, "..", "..", "blocker");
		writeFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "credentials.json");

		expect(removeClient("oh_absent", blockedPath)).toEqual(ok(undefined));
		expect(existsSync(blockedPath)).toBe(false);
	});
});

describe("ensureJwtSecret", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("mints a secret on first use and reuses it thereafter", () => {
		const first = ensureJwtSecret(path);
		const second = ensureJwtSecret(path);
		expect(first).toMatch(/^[A-Za-z0-9_-]+$/);
		expect(first).toBeDefined();
		expect(second).toBe(first);
	});

	it("returns undefined when the cred dir is unwritable", () => {
		const blocker = join(path, "..", "..", "blocker");
		writeFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "credentials.json");
		expect(ensureJwtSecret(blockedPath)).toBeUndefined();
	});
});

describe("peekJwtSecret", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("prefers OAUTH_JWT_SECRET from the env", () => {
		expect(peekJwtSecret({ OAUTH_JWT_SECRET: "env-secret" }, path)).toBe("env-secret");
	});

	it("reads a persisted secret when the env is unset — and never mints", () => {
		const persisted = ensureJwtSecret(path); // mint + persist a real secret
		expect(peekJwtSecret({}, path)).toBe(persisted);
	});

	it("returns undefined when neither env nor a persisted secret is present (no mint)", () => {
		expect(peekJwtSecret({}, path)).toBeUndefined();
		// Read-only: no file was created.
		expect(existsSync(path)).toBe(false);
	});

	it("treats a whitespace-only env value as unset (falls back to the persisted secret)", () => {
		const persisted = ensureJwtSecret(path);
		expect(peekJwtSecret({ OAUTH_JWT_SECRET: "   " }, path)).toBe(persisted);
	});
});

describe("resolveJwtSecret", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("prefers OAUTH_JWT_SECRET from the env (and does not mint into the file)", () => {
		expect(resolveJwtSecret({ OAUTH_JWT_SECRET: "env-secret" }, path)).toBe("env-secret");
		// The env override short-circuits before any persistence.
		expect(existsSync(path)).toBe(false);
	});

	it("treats an empty/whitespace env value as unset and mints instead", () => {
		expect(resolveJwtSecret({ OAUTH_JWT_SECRET: "   " }, path)).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("mints + persists when the env is absent", () => {
		const resolved = resolveJwtSecret({}, path);
		expect(resolved).toBe(ensureJwtSecret(path));
	});
});

describe("coexistence with channel secrets (no clobber)", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("stores OAuth state without disturbing channel secret bags", () => {
		const channel = randomUUID();
		setCredentials(channel, { authtoken: "ngrok-token" }, path);

		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");

		// The channel secret survives the OAuth write.
		expect(getCredentials(channel, path)).toEqual({ authtoken: "ngrok-token" });
		// And the OAuth client is findable.
		expect(findClient(issued.value.clientId, path)).toBeDefined();
	});

	it("survives a subsequent channel write (the read-merge-write that could clobber)", () => {
		const channel = randomUUID();
		setCredentials(channel, { authtoken: "ngrok-token" }, path);
		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");

		// A later channel merge — the whole-file validator must not reject the OAuth bag.
		setCredentials(channel, { region: "us" }, path);

		expect(getCredentials(channel, path)).toEqual({ authtoken: "ngrok-token", region: "us" });
		// The OAuth client survives the channel write.
		expect(listClients(path).map((c) => c.clientId)).toEqual([issued.value.clientId]);
	});

	it("does not read the reserved OAuth credId as a channel bag", () => {
		issueClient("ci", {}, path);
		// A channel lookup never returns the OAuth bag.
		expect(getCredentials("__openhammer_oauth__", path).authtoken).toBeUndefined();
	});
});

describe("resilience", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("treats a corrupt clients blob as an empty registry (never throws)", () => {
		// Seed a valid jwtSecret + a corrupt clients string directly in the bag.
		setCredentials("__openhammer_oauth__", { jwtSecret: "s", clients: "not-json{{" }, path);
		expect(listClients(path)).toEqual([]);
		expect(findClient("oh_anything", path)).toBeUndefined();
		// The jwtSecret is independent of the clients blob.
		expect(ensureJwtSecret(path)).toBe("s");
	});

	it("normalizes a legacy v1 record (no grantTypes) to client_credentials on read", () => {
		// Seed a pre-auth-code record directly: core fields, no grantTypes.
		const legacy = { secretHash: hashSecret("x"), label: "legacy", createdAt: "2024-01-01T00:00:00.000Z" };
		setCredentials("__openhammer_oauth__", { clients: JSON.stringify({ oh_legacy: legacy }) }, path);
		const record = findClient("oh_legacy", path);
		expect(record?.grantTypes).toEqual([GRANT_CLIENT_CREDENTIALS]);
	});
});

describe("authorization-code clients + login", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("defaults grantTypes to [client_credentials] when no opts are given", () => {
		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");
		const record = findClient(issued.value.clientId, path);
		expect(record?.grantTypes).toEqual([GRANT_CLIENT_CREDENTIALS]);
	});

	it("stores grantTypes + redirect URIs + a per-client login for an auth-code client", () => {
		const issued = issueClient(
			"web",
			{
				grantTypes: [GRANT_AUTHORIZATION_CODE],
				redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
				username: "operator",
				password: "s3cret",
			},
			path,
		);
		if (!issued.ok) throw new Error("expected ok");
		const record = findClient(issued.value.clientId, path);
		expect(record?.grantTypes).toEqual([GRANT_AUTHORIZATION_CODE]);
		expect(record?.redirectUris).toEqual(["https://claude.ai/api/mcp/auth_callback"]);
		expect(record?.username).toBe("operator");
		expect(record?.passwordHash).toBe(hashSecret("s3cret"));
		// The plaintext password is never persisted.
		expect(readFileSync(path, "utf-8")).not.toContain("s3cret");
	});

	it("verifyClientLogin accepts the right credentials and rejects wrong ones", () => {
		const issued = issueClient(
			"web",
			{ grantTypes: [GRANT_AUTHORIZATION_CODE], username: "op", password: "right" },
			path,
		);
		if (!issued.ok) throw new Error("expected ok");
		const record = findClient(issued.value.clientId, path);
		if (!record) throw new Error("expected record");
		expect(verifyClientLogin(record, "op", "right")).toBe(true);
		expect(verifyClientLogin(record, "op", "wrong")).toBe(false);
		expect(verifyClientLogin(record, "other", "right")).toBe(false);
	});

	it("verifyClientLogin is false for a client with no login configured", () => {
		const issued = issueClient("ci", {}, path);
		if (!issued.ok) throw new Error("expected ok");
		const record = findClient(issued.value.clientId, path);
		if (!record) throw new Error("expected record");
		expect(verifyClientLogin(record, "anyone", "anything")).toBe(false);
	});

	it("listClients surfaces grantTypes + username (never any hash)", () => {
		issueClient("web", { grantTypes: [GRANT_AUTHORIZATION_CODE], username: "op", password: "pw" }, path);
		const list = listClients(path);
		expect(list.length).toBe(1);
		expect(list[0].grantTypes).toEqual([GRANT_AUTHORIZATION_CODE]);
		expect(list[0].username).toBe("op");
		expect("passwordHash" in list[0]).toBe(false);
	});
});

describe("global operator login", () => {
	let path: string;

	beforeEach(() => {
		path = tempCredPath();
	});
	afterEach(() => rmUnder(path));

	it("is absent until set (verify returns false, never throws)", () => {
		expect(hasOperatorLogin(path)).toBe(false);
		expect(verifyOperatorLogin("op", "pw", path)).toBe(false);
	});

	it("verifies the set username + password and rejects wrong ones", () => {
		setOperatorLogin("operator", "hunter2", path);
		expect(hasOperatorLogin(path)).toBe(true);
		expect(verifyOperatorLogin("operator", "hunter2", path)).toBe(true);
		expect(verifyOperatorLogin("operator", "wrong", path)).toBe(false);
		expect(verifyOperatorLogin("other", "hunter2", path)).toBe(false);
		// Only the hash is persisted.
		expect(readFileSync(path, "utf-8")).not.toContain("hunter2");
	});

	it("overwrites the previous login on a re-set", () => {
		setOperatorLogin("op", "old", path);
		setOperatorLogin("op", "new", path);
		expect(verifyOperatorLogin("op", "new", path)).toBe(true);
		expect(verifyOperatorLogin("op", "old", path)).toBe(false);
	});
});
