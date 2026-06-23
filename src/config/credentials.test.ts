import {
	existsSync,
	writeFileSync as fsWriteFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, deleteCredentials, getCredentials, setCredentials } from "./credentials.ts";
import { loadSettings, type Settings, saveSettings } from "./settings.ts";

describe("credentialsPath", () => {
	it("resolves <homeDir>/.openhammer/credentials.json", () => {
		expect(credentialsPath("/home/foo")).toBe("/home/foo/.openhammer/credentials.json");
	});
});

describe("getCredentials", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-creds-"));
		path = credentialsPath(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns {} when the file is absent", () => {
		expect(getCredentials("abc", path)).toEqual({});
	});

	it("returns {} when the id is absent but others exist", () => {
		setCredentials("abc", { authtoken: "t0p" }, path);
		expect(getCredentials("missing", path)).toEqual({});
	});

	it("returns the stored bag for an id", () => {
		setCredentials("abc", { authtoken: "t0p", region: "us" }, path);
		expect(getCredentials("abc", path)).toEqual({ authtoken: "t0p", region: "us" });
	});

	it("returns {} (never throws) when the file is corrupt", () => {
		mkdirSync(dirname(path), { recursive: true });
		fsWriteFileSync(path, "not valid json {{{", { mode: 0o600 });
		expect(getCredentials("abc", path)).toEqual({});
	});

	it("returns {} when an entry is not a string bag (whole-file corrupt)", () => {
		mkdirSync(dirname(path), { recursive: true });
		fsWriteFileSync(path, JSON.stringify({ abc: "not-a-bag" }), { mode: 0o600 });
		expect(getCredentials("abc", path)).toEqual({});
	});

	it("does not return an inherited Object.prototype value for a prototype key name", () => {
		// A real credId is a UUID and never collides, but `Object.hasOwn` keeps this honest.
		setCredentials("abc", { authtoken: "t0p" }, path);
		expect(getCredentials("toString", path)).toEqual({});
	});
});

describe("setCredentials", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-creds-"));
		path = credentialsPath(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips a bag through getCredentials", () => {
		setCredentials("abc", { authtoken: "t0p" }, path);
		expect(getCredentials("abc", path)).toEqual({ authtoken: "t0p" });
	});

	it("merges new keys without dropping existing ones", () => {
		setCredentials("abc", { authtoken: "t0p" }, path);
		setCredentials("abc", { region: "us" }, path);
		expect(getCredentials("abc", path)).toEqual({ authtoken: "t0p", region: "us" });
	});

	it("overwrites a key when set again", () => {
		setCredentials("abc", { authtoken: "old" }, path);
		setCredentials("abc", { authtoken: "new" }, path);
		expect(getCredentials("abc", path)).toEqual({ authtoken: "new" });
	});

	it("keeps separate ids isolated", () => {
		setCredentials("a", { authtoken: "t1" }, path);
		setCredentials("b", { authtoken: "t2" }, path);
		expect(getCredentials("a", path)).toEqual({ authtoken: "t1" });
		expect(getCredentials("b", path)).toEqual({ authtoken: "t2" });
	});

	it("overwrites a corrupt file with a valid map", () => {
		mkdirSync(dirname(path), { recursive: true });
		fsWriteFileSync(path, "garbage", { mode: 0o600 });

		setCredentials("abc", { authtoken: "t0p" }, path);

		expect(getCredentials("abc", path)).toEqual({ authtoken: "t0p" });
		expect(readFileSync(path, "utf-8")).toContain("t0p");
	});

	it("writes the file at mode 0600 and creates the dir at 0700", () => {
		setCredentials("abc", { authtoken: "t0p" }, path);

		expect(existsSync(path)).toBe(true);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
	});

	it("leaves no temp file behind after a successful write", () => {
		setCredentials("abc", { authtoken: "t0p" }, path);

		expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
		expect(readdirSync(dirname(path))).toEqual(["credentials.json"]);
	});

	it("overwrites a previous map atomically with no leftover temps", () => {
		setCredentials("abc", { authtoken: "old" }, path);
		const before = readFileSync(path, "utf-8");

		setCredentials("abc", { authtoken: "new" }, path);

		expect(getCredentials("abc", path)).toEqual({ authtoken: "new" });
		expect(readFileSync(path, "utf-8")).not.toBe(before);
		expect(readdirSync(dirname(path)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
	});

	it("throws a clear error when the directory cannot be created", () => {
		// A regular file as a path component → `mkdir` ENOTDIR regardless of uid
		// (root bypasses a perms-based block, but not ENOTDIR) → deterministic, root-safe.
		const blocker = join(dir, "blocker");
		fsWriteFileSync(blocker, "", { mode: 0o600 });
		const blockedPath = join(blocker, ".openhammer", "credentials.json");

		expect(() => setCredentials("abc", { authtoken: "t0p" }, blockedPath)).toThrow(
			/Cannot create credentials directory/,
		);
		expect(existsSync(blockedPath)).toBe(false);
	});
});

describe("deleteCredentials", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-creds-"));
		path = credentialsPath(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes only the targeted id, leaving siblings", () => {
		setCredentials("a", { authtoken: "t1" }, path);
		setCredentials("b", { authtoken: "t2" }, path);

		deleteCredentials("a", path);

		expect(getCredentials("a", path)).toEqual({});
		expect(getCredentials("b", path)).toEqual({ authtoken: "t2" });
	});

	it("is a no-op (no file created) when the id is absent and the file is missing", () => {
		deleteCredentials("never", path);

		expect(existsSync(path)).toBe(false);
	});

	it("is a no-op when the id is absent but the file exists", () => {
		setCredentials("a", { authtoken: "t1" }, path);
		const before = readFileSync(path, "utf-8");

		deleteCredentials("missing", path);

		// No rewrite for a missing id → file content unchanged.
		expect(readFileSync(path, "utf-8")).toBe(before);
		expect(getCredentials("a", path)).toEqual({ authtoken: "t1" });
	});

	it("leaves an empty {} map when the last entry is deleted", () => {
		setCredentials("a", { authtoken: "t1" }, path);

		deleteCredentials("a", path);

		expect(existsSync(path)).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf-8"))).toEqual({});
		expect(getCredentials("a", path)).toEqual({});
	});
});

describe("isolation from config.json", () => {
	let dir: string;
	let credPath: string;
	let cfgPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-creds-"));
		credPath = credentialsPath(dir);
		cfgPath = join(dir, ".openhammer", "config.json");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("lives in credentials.json, not config.json", () => {
		setCredentials("abc", { authtoken: "t0p" }, credPath);

		expect(existsSync(credPath)).toBe(true);
		expect(existsSync(cfgPath)).toBe(false);
		expect(getCredentials("abc", credPath)).toEqual({ authtoken: "t0p" });
	});

	it("does not read a decoy id-keyed value from config.json", () => {
		// A settings doc and a credentials map can both be keyed by id; only the
		// credentials file answers getCredentials.
		mkdirSync(dirname(cfgPath), { recursive: true });
		fsWriteFileSync(cfgPath, JSON.stringify({ abc: { authtoken: "from-config-decoy" } }), { mode: 0o600 });
		fsWriteFileSync(credPath, JSON.stringify({ abc: { authtoken: "real-secret" } }), { mode: 0o600 });

		expect(getCredentials("abc", credPath)).toEqual({ authtoken: "real-secret" });
	});

	it("does not touch config.json when writing credentials", () => {
		const settings: Settings = {
			version: 1,
			channels: [{ id: "abc", kind: "ngrok", mode: "live", options: { region: "us" } }],
			defaultChannel: "abc",
			mcp: { allowedClients: [] },
		};
		saveSettings(cfgPath, settings);
		const cfgBefore = readFileSync(cfgPath, "utf-8");

		setCredentials("abc", { authtoken: "t0p" }, credPath);

		// config.json is byte-identical; the secret lives only in credentials.json.
		expect(readFileSync(cfgPath, "utf-8")).toBe(cfgBefore);
		expect(loadSettings(cfgPath)).toEqual(settings);
		expect(getCredentials("abc", credPath)).toEqual({ authtoken: "t0p" });
		expect(readdirSync(dirname(cfgPath)).sort()).toEqual(["config.json", "credentials.json"]);
	});
});
