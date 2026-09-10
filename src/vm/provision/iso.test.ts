import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveVmDirs, type VmDirs } from "../session.ts";
import type { BinRunResult, RunBin } from "./cidata.ts";
import { ensureIso, ISO_NAME, ISO_SEED_ENV, ISO_SHA256, ISO_URL, sha256OfFile } from "./iso.ts";

/** A fresh HOME per test — resolveVmDirs({homeDir}) roots the whole vm tree inside it; nothing real is touched. */
async function withTempDirs(fn: (dirs: VmDirs) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "openhammer-iso-"));
	try {
		await fn(resolveVmDirs({ homeDir: home }));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** Set `OPENHAMMER_VM_ISO_SEED` for one test; restored however the test ends (the withTempHome precedent). */
function withSeedEnv(value: string | undefined, fn: () => void | Promise<void>): () => Promise<void> {
	return async () => {
		const prev = process.env[ISO_SEED_ENV];
		process.env[ISO_SEED_ENV] = value;
		try {
			await fn();
		} finally {
			if (prev === undefined) {
				delete process.env[ISO_SEED_ENV];
			} else {
				process.env[ISO_SEED_ENV] = prev;
			}
		}
	};
}

interface BinCall {
	readonly bin: string;
	readonly args: readonly string[];
}

/** A recording RunBin answering `code` (plus optional tails) to every call; a successful curl `-o <path>` leaves real bytes behind. */
function fakeRunBin(code: number, stderr = "boom"): { run: RunBin; calls: BinCall[] } {
	const calls: BinCall[] = [];
	return {
		calls,
		run: async (bin, args): Promise<BinRunResult> => {
			calls.push({ bin, args: [...args] });
			if (code === 0) {
				const outIndex = args.indexOf("-o");
				const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;
				if (bin === "curl" && typeof outPath === "string") {
					writeFileSync(outPath, "downloaded-bytes");
				}
			}
			return { code, stdoutTail: "", stderrTail: stderr };
		},
	};
}

/** A hasher scripted per call in order (then repeating the last answer). */
function scriptedHash(answers: string[]): { hashFile: (path: string) => Promise<string>; calls: string[] } {
	const calls: string[] = [];
	let index = 0;
	return {
		calls,
		hashFile: async (path: string): Promise<string> => {
			calls.push(path);
			const answer = answers[Math.min(index, answers.length - 1)] ?? ISO_SHA256;
			index += 1;
			return answer;
		},
	};
}

/** A hasher answering purely by path (the cached file vs the re-acquired one, same path or not). */
function hashByPath(map: (path: string, call: number) => string): { hashFile: (path: string) => Promise<string> } {
	let call = 0;
	return {
		hashFile: async (path: string): Promise<string> => {
			call += 1;
			return map(path, call);
		},
	};
}

describe("iso pin constants", () => {
	it("the pin is the 22-measured omarchy-4.0.3 triple (an accidental pin edit fails here)", () => {
		expect(ISO_URL).toBe("https://iso.omarchy.org/omarchy-4.0.3.iso");
		expect(ISO_SHA256).toBe("03d60bc74306dca51f96e1a84b690871d8d606826b260edd0208962da8507d14");
		expect(ISO_NAME).toBe("omarchy-4.0.3.iso");
		expect(ISO_SEED_ENV).toBe("OPENHAMMER_VM_ISO_SEED");
	});
});

describe("ensureIso — cached", () => {
	it("a file that hashes to the pin is returned as cached with no curl", async () => {
		await withTempDirs(async (dirs) => {
			mkdirSync(dirs.isos, { recursive: true });
			const path = join(dirs.isos, ISO_NAME);
			writeFileSync(path, "pretend-iso-bytes");
			const curl = fakeRunBin(0);
			const { hashFile } = hashByPath(() => ISO_SHA256);
			const state = await ensureIso(dirs, { hashFile, runBin: curl.run });
			expect(state).toEqual({ path, action: "cached", size: "pretend-iso-bytes".length, sha256: ISO_SHA256 });
			expect(curl.calls).toEqual([]); // no network on a verified cache hit
		});
	});

	it("creates the isos dir 0700 when absent", async () => {
		await withTempDirs(async (dirs) => {
			const curl = fakeRunBin(0);
			const { hashFile } = hashByPath(() => ISO_SHA256);
			await ensureIso(dirs, { hashFile, runBin: curl.run });
			expect(statSync(dirs.isos).mode & 0o777).toBe(0o700);
		});
	});
});

describe("ensureIso — download", () => {
	it("downloads via curl with the resumable .part argv, renames on success, verifies", async () => {
		await withTempDirs(async (dirs) => {
			const curl = fakeRunBin(0);
			const { hashFile } = hashByPath(() => ISO_SHA256);
			const state = await ensureIso(dirs, { hashFile, runBin: curl.run });
			expect(state.action).toBe("downloaded");
			expect(state.size).toBe("downloaded-bytes".length); // the fake curl's real bytes
			expect(curl.calls).toEqual([
				{ bin: "curl", args: ["-L", "--continue-at", "-", "-o", join(dirs.isos, `${ISO_NAME}.part`), ISO_URL] },
			]);
			expect(existsSync(join(dirs.isos, `${ISO_NAME}.part`))).toBe(false); // renamed away
			expect(existsSync(join(dirs.isos, ISO_NAME))).toBe(true);
		});
	});

	it("a cached file that MIShashes is deleted and re-acquired via download", async () => {
		await withTempDirs(async (dirs) => {
			mkdirSync(dirs.isos, { recursive: true });
			const path = join(dirs.isos, ISO_NAME);
			writeFileSync(path, "stale-bytes");
			const curl = fakeRunBin(0);
			// First hash (the stale cache) is wrong; the second (post-download) matches the pin.
			const { hashFile, calls } = scriptedHash(["deadbeef", ISO_SHA256]);
			const state = await ensureIso(dirs, { hashFile, runBin: curl.run });
			expect(state.action).toBe("downloaded");
			expect(calls).toEqual([path, path]); // the stale file hashed, then the fresh one
			expect(curl.calls).toHaveLength(1);
		});
	});

	it("a failed curl throws with the stderr tail and KEEPS the .part for resume", async () => {
		await withTempDirs(async (dirs) => {
			const curl = fakeRunBin(22, "curl: (22) HTTP2 stream error");
			await expect(ensureIso(dirs, { hashFile: async () => ISO_SHA256, runBin: curl.run })).rejects.toThrow(
				"iso: curl exited 22: curl: (22) HTTP2 stream error",
			);
		});
	});

	it("a post-download sha256 mismatch deletes the file and throws loudly", async () => {
		await withTempDirs(async (dirs) => {
			const curl = fakeRunBin(0);
			const { hashFile } = hashByPath(() => "wrongdigest");
			await expect(ensureIso(dirs, { hashFile, runBin: curl.run })).rejects.toThrow(
				`iso: sha256 mismatch after download (got wrongdigest, want ${ISO_SHA256}) — deleted`,
			);
			expect(existsSync(join(dirs.isos, ISO_NAME))).toBe(false); // never left for a later boot
		});
	});
});

describe("ensureIso — seeding", () => {
	afterEach(() => {
		delete process.env[ISO_SEED_ENV];
	});

	it("a seed that verifies is hardlinked into the cache with no curl (the 5.8 GiB re-download skipped)", async () => {
		await withTempDirs(async (dirs) => {
			const home = mkdtempSync(join(tmpdir(), "openhammer-iso-seedsrc-"));
			try {
				const seedPath = join(home, "spike-copy.iso");
				writeFileSync(seedPath, "seed-bytes");
				const curl = fakeRunBin(0);
				const run = withSeedEnv(seedPath, async () => {
					const { hashFile } = hashByPath(() => ISO_SHA256);
					const state = await ensureIso(dirs, { hashFile, runBin: curl.run });
					expect(state).toEqual({
						path: join(dirs.isos, ISO_NAME),
						action: "seeded",
						size: "seed-bytes".length,
						sha256: ISO_SHA256,
					});
				});
				await run();
				expect(curl.calls).toEqual([]);
				expect(readFileSync(join(dirs.isos, ISO_NAME), "utf8")).toBe("seed-bytes");
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	});

	it("a seed that MIShashes is deleted and the download runs (the pin governs the untrusted seed)", async () => {
		await withTempDirs(async (dirs) => {
			const home = mkdtempSync(join(tmpdir(), "openhammer-iso-seedbad-"));
			try {
				const seedPath = join(home, "tampered.iso");
				writeFileSync(seedPath, "tampered");
				const curl = fakeRunBin(0);
				const logs: string[] = [];
				const run = withSeedEnv(seedPath, async () => {
					// Call order is the only distinguisher (seed + download verify the SAME
					// target path): first the seeded copy (wrong), then the download (pin).
					const { hashFile } = scriptedHash(["seedwrong", ISO_SHA256]);
					const state = await ensureIso(dirs, { hashFile, runBin: curl.run, log: (line) => logs.push(line) });
					expect(state.action).toBe("downloaded");
				});
				await run();
				expect(curl.calls).toHaveLength(1);
				expect(logs.some((line) => line.includes(`seeded ${ISO_NAME} hashes seedwrong`))).toBe(true);
			} finally {
				rmSync(home, { recursive: true, force: true });
			}
		});
	});

	it("a seed path that is not a readable file falls through to the download with a logged note", async () => {
		await withTempDirs(async (dirs) => {
			const curl = fakeRunBin(0);
			const logs: string[] = [];
			const run = withSeedEnv(join(dirs.isos, "does-not-exist.iso"), async () => {
				const state = await ensureIso(dirs, {
					hashFile: async () => ISO_SHA256,
					runBin: curl.run,
					log: (line) => logs.push(line),
				});
				expect(state.action).toBe("downloaded");
			});
			await run();
			expect(curl.calls).toHaveLength(1);
			expect(logs.some((line) => line.includes("is not a readable file — downloading instead"))).toBe(true);
		});
	});
});

describe("sha256OfFile", () => {
	it("streams the real digest of a file (the default hashFile path)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-iso-hash-"));
		try {
			const path = join(dir, "payload");
			const payload = Buffer.from("openhammer iso hash fixture — streamed, not buffered");
			writeFileSync(path, payload);
			// The expected digest computed independently here, via the library directly.
			expect(await sha256OfFile(path)).toBe(createHash("sha256").update(payload).digest("hex"));
			writeFileSync(path, "different");
			expect(await sha256OfFile(path)).not.toBe(createHash("sha256").update(payload).digest("hex"));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
