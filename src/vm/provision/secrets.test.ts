import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveVmDirs, type VmDirs } from "../session.ts";
import { emptySecrets, loadSecrets, normalizeSecrets, type SecretsStore, saveSecrets } from "./secrets.ts";

/** A fresh HOME per test — resolveVmDirs({homeDir}) roots the whole vm tree inside it; nothing real is touched. */
async function withTempDirs(fn: (dirs: VmDirs) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "openhammer-secrets-"));
	try {
		await fn(resolveVmDirs({ homeDir: home }));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** The three store paths under the temp HOME (kept in lockstep with secrets.ts's layout). */
function paths(dirs: VmDirs): { dir: string; envPath: string; filesPath: string } {
	return { dir: dirs.secrets, envPath: join(dirs.secrets, "env"), filesPath: join(dirs.secrets, "files.json") };
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

/** A fully-populated valid store — both halves non-trivial. */
const fullStore: SecretsStore = {
	env: {
		ANTHROPIC_API_KEY: "sk-ant-sandbox",
		ZED: "1",
		EMPTY_VALUE: "",
		WITH_EQUALS: "a=b=c", // split on the FIRST "=" only
	},
	files: [
		{ hostPath: "/home/me/.claude/.credentials.json", guestPath: "/home/sandbox/.claude/.credentials.json" },
		{ hostPath: "/home/me/.netrc", guestPath: "/home/sandbox/.netrc" },
	],
};

/** `fullStore` as a mutable plain object — the base every invalid-table entry mutates. */
const validDoc: Record<string, unknown> = {
	env: { ...fullStore.env },
	files: fullStore.files.map((entry) => ({ ...entry })),
};

describe("emptySecrets", () => {
	it("is the empty store", () => {
		expect(emptySecrets()).toEqual({ env: {}, files: [] });
	});
});

describe("normalizeSecrets", () => {
	it("accepts a fully-populated store and returns it canonically", () => {
		expect(normalizeSecrets(validDoc)).toEqual(fullStore);
	});

	it("ignores unknown extra keys (the settings/credentials posture — extras are not corruption)", () => {
		expect(normalizeSecrets({ ...validDoc, surprise: "ignored" })).toEqual(fullStore);
	});

	it("does NOT check host-file existence (spec 29 checks at consumption)", () => {
		const doc = {
			env: {},
			files: [{ hostPath: "/nonexistent/credential.json", guestPath: "/home/sandbox/cred.json" }],
		};
		expect(normalizeSecrets(doc)?.files).toEqual(doc.files);
	});

	const badDocs: Array<{ name: string; doc: unknown }> = [
		{ name: "not an object (string)", doc: "nope" },
		{ name: "not an object (null)", doc: null },
		{ name: "not an object (array)", doc: [] },
		{ name: "env missing", doc: { files: [] } },
		{ name: "files missing", doc: { env: {} } },
		{ name: "env not an object (array)", doc: { env: ["A=1"], files: [] } },
		{ name: "env not an object (null)", doc: { env: null, files: [] } },
		{ name: "env value not a string", doc: { env: { A: 1 }, files: [] } },
		{ name: "env key lowercase", doc: { env: { key: "v" }, files: [] } },
		{ name: "env key starting with a digit", doc: { env: { "1KEY": "v" }, files: [] } },
		{ name: "env key with hyphen", doc: { env: { "MY-KEY": "v" }, files: [] } },
		{ name: "env key empty", doc: { env: { "": "v" }, files: [] } },
		{ name: "env value with newline", doc: { env: { A: "a\nb" }, files: [] } },
		{ name: "env value with carriage return", doc: { env: { A: "a\rb" }, files: [] } },
		{ name: "env value with NUL", doc: { env: { A: "a\0b" }, files: [] } },
		{ name: "files not an array", doc: { env: {}, files: {} } },
		{ name: "files entry not an object", doc: { env: {}, files: ["/home/me/cred"] } },
		{ name: "files entry missing guestPath", doc: { env: {}, files: [{ hostPath: "/home/me/cred" }] } },
		{ name: "files entry missing hostPath", doc: { env: {}, files: [{ guestPath: "/home/sandbox/cred" }] } },
		{
			name: "hostPath relative",
			doc: { env: {}, files: [{ hostPath: "home/me/cred", guestPath: "/home/sandbox/cred" }] },
		},
		{
			name: "hostPath tilde-relative",
			doc: { env: {}, files: [{ hostPath: "~/cred", guestPath: "/home/sandbox/cred" }] },
		},
		{
			name: "guestPath tilde-relative (spec 26's prose shorthand — store keeps absolute)",
			doc: { env: {}, files: [{ hostPath: "/home/me/cred", guestPath: "~/.claude/.credentials.json" }] },
		},
		{
			name: "guestPath with newline",
			doc: { env: {}, files: [{ hostPath: "/home/me/cred", guestPath: "/home/sandbox/x\n/cred" }] },
		},
		{
			name: "duplicate guestPath (would silently clobber at consumption)",
			doc: {
				env: {},
				files: [
					{ hostPath: "/home/me/a", guestPath: "/home/sandbox/cred" },
					{ hostPath: "/home/me/b", guestPath: "/home/sandbox/cred" },
				],
			},
		},
	];

	it.each(badDocs)("$name → null", ({ doc }) => {
		expect(normalizeSecrets(doc)).toBeNull();
	});
});

describe("loadSecrets", () => {
	it("yields the empty store when nothing exists yet", async () => {
		await withTempDirs((dirs) => {
			expect(loadSecrets(dirs)).toEqual(emptySecrets());
		});
	});

	it("round-trips a saved store", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			expect(loadSecrets(dirs)).toEqual(fullStore);
		});
	});

	it("judges the halves independently — a mangled env line empties only env", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			writeFileSync(paths(dirs).envPath, "not a pair\n");
			const loaded = loadSecrets(dirs);
			expect(loaded.env).toEqual({});
			expect(loaded.files).toEqual(fullStore.files);
		});
	});

	it("judges the halves independently — a corrupt files.json empties only files", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			writeFileSync(paths(dirs).filesPath, "not json {{{");
			const loaded = loadSecrets(dirs);
			expect(loaded.env).toEqual(fullStore.env);
			expect(loaded.files).toEqual([]);
		});
	});

	it("yields empty env for a CRLF-mangled (hand-edited) env file", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			writeFileSync(paths(dirs).envPath, "A=1\r\n");
			expect(loadSecrets(dirs).env).toEqual({});
		});
	});
});

describe("saveSecrets", () => {
	it("creates the 0700 dir and writes both files 0600", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			const p = paths(dirs);
			expect(mode(p.dir)).toBe(0o700);
			expect(mode(p.envPath)).toBe(0o600);
			expect(mode(p.filesPath)).toBe(0o600);
		});
	});

	it("writes env as plain sorted KEY=value lines — never JSON", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			const text = readFileSync(paths(dirs).envPath, "utf8");
			expect(text).toBe("ANTHROPIC_API_KEY=sk-ant-sandbox\nEMPTY_VALUE=\nWITH_EQUALS=a=b=c\nZED=1\n");
		});
	});

	it("writes files.json as the JSON map with a trailing newline", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			const text = readFileSync(paths(dirs).filesPath, "utf8");
			expect(text).toBe(`${JSON.stringify(fullStore.files, null, 2)}\n`);
		});
	});

	it("writes an empty env as a zero-byte file and files as []", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, emptySecrets());
			const p = paths(dirs);
			expect(readFileSync(p.envPath, "utf8")).toBe("");
			expect(readFileSync(p.filesPath, "utf8")).toBe("[]\n");
		});
	});

	it("tightens pre-existing loose perms (mkdir + chmod on every save)", async () => {
		await withTempDirs((dirs) => {
			const p = paths(dirs);
			mkdirSync(p.dir, { recursive: true, mode: 0o755 });
			writeFileSync(p.envPath, "STALE=1\n", { mode: 0o644 });
			writeFileSync(p.filesPath, "[]\n", { mode: 0o644 });
			saveSecrets(dirs, fullStore);
			expect(mode(p.dir)).toBe(0o700);
			expect(mode(p.envPath)).toBe(0o600);
			expect(mode(p.filesPath)).toBe(0o600);
		});
	});

	it("leaves no .tmp files behind", async () => {
		await withTempDirs((dirs) => {
			saveSecrets(dirs, fullStore);
			saveSecrets(dirs, emptySecrets());
			expect(readdirSync(paths(dirs).dir).sort()).toEqual(["env", "files.json"]);
		});
	});
});
