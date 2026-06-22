import {
	existsSync,
	writeFileSync as fsWriteFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../config.ts";
import { type Credential, credentialPath, ensureToken } from "./token.ts";

/** Minimal `Config` with just the `authToken` field `ensureToken` reads. */
function configWith(authToken?: string): Config {
	return {
		port: 3000,
		host: "127.0.0.1",
		rootDir: "/tmp",
		authToken,
		maxResponseBytes: 512_000,
		logLevel: "info",
	};
}

/** Pre-seed a credential file (creating its parent dir) at 0600 for the reuse paths. */
function seedCred(credPath: string, contents: string): void {
	mkdirSync(dirname(credPath), { recursive: true });
	fsWriteFileSync(credPath, contents, { mode: 0o600 });
}

describe("ensureToken", () => {
	let dir: string;
	let credPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-cred-"));
		credPath = join(dir, ".openhammer", "credential.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("mints a 43-char base64url token and persists it at mode 0600 when no file exists", async () => {
		const cred = await ensureToken(configWith(), credPath);
		expect(cred.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(Date.parse(cred.createdAt)).not.toBeNaN();

		expect(existsSync(credPath)).toBe(true);
		expect(statSync(credPath).mode & 0o777).toBe(0o600);

		// The persisted JSON round-trips to exactly what was returned.
		expect(JSON.parse(readFileSync(credPath, "utf-8"))).toEqual(cred);
	});

	it("reuses an existing valid credential without overwriting it", async () => {
		const known: Credential = { token: "preexisting-token-value", createdAt: "2024-01-01T00:00:00.000Z" };
		seedCred(credPath, JSON.stringify(known));
		const before = readFileSync(credPath, "utf-8");

		const cred = await ensureToken(configWith(), credPath);

		expect(cred).toEqual(known);
		expect(readFileSync(credPath, "utf-8")).toBe(before);
	});

	it("returns MCP_AUTH_TOKEN verbatim (createdAt='') and never touches the credential file", async () => {
		expect(existsSync(credPath)).toBe(false);

		const cred = await ensureToken(configWith("override-token"), credPath);

		expect(cred).toEqual({ token: "override-token", createdAt: "" });
		expect(existsSync(credPath)).toBe(false);
	});

	it("mints fresh when the persisted file is corrupt JSON", async () => {
		seedCred(credPath, "not valid json {{{");

		const cred = await ensureToken(configWith(), credPath);

		expect(cred.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
	});

	it("mints fresh when the persisted token is empty", async () => {
		seedCred(credPath, JSON.stringify({ token: "", createdAt: "2024-01-01T00:00:00.000Z" }));

		const cred = await ensureToken(configWith(), credPath);

		expect(cred.token).toHaveLength(43);
	});

	it("throws a clear error when the credential directory cannot be created", async () => {
		// A regular file as a path component → `mkdir` fails with ENOTDIR regardless of
		// uid (root would bypass a perms-based block, but not ENOTDIR) → deterministic.
		const blocker = join(dir, "blocker");
		fsWriteFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "credential.json");

		await expect(ensureToken(configWith(), blockedPath)).rejects.toThrow(/Cannot create credential directory/);
	});
});

describe("credentialPath", () => {
	it("resolves <homeDir>/.openhammer/credential.json", () => {
		expect(credentialPath("/home/foo")).toBe("/home/foo/.openhammer/credential.json");
	});
});
