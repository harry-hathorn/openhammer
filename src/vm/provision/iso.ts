/**
 * The pinned Omarchy live-ISO fetch (spec 26): download once, verify sha256, NEVER boot
 * unverified — promoted from scripts/vm-spike/iso.ts (the code that fetched both golden
 * builds' ISO) with the pin constants promoted from the spike's scratch.ts. The pin IS the
 * contract (22-measured): any digest change upstream is a finding, not something we absorb.
 *
 * **Seeding** (new in the product, absent in the spike): before downloading ~5.8 GiB again,
 * `OPENHAMMER_VM_ISO_SEED` (an operator-set env var naming an absolute path to a
 * pre-existing copy — e.g. the spike's own `isos/omarchy-4.0.3.iso`) is hardlink-or-copied
 * into the cache and then hash-verified. The seed is UNTRUSTED INPUT — the same pinned-sha256
 * check governs it; a mismatch deletes the copy and falls through to the download. This
 * exists so the orchestrator's measured 5.8 GiB spike download is never repeated.
 *
 * Download shape (the spike's, verbatim): curl with an ARG ARRAY (never a shell string) to
 * `<isos>/<name>.part` with `--continue-at -` (a killed download resumes), rename on success,
 * streamed sha256 verify, delete + throw on mismatch. A failed curl leaves the `.part` in
 * place on purpose — that is the resume input for the retry.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, createReadStream, linkSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { VmDirs } from "../session.ts";
import type { BinRunResult, RunBin } from "./cidata.ts";

// ---- the pin (promoted from scripts/vm-spike/scratch.ts — 22-measured "Chosen defaults") ----

/** The one ISO the installer boots; a new pin means a new golden (spec 26's rebuild rule). */
export const ISO_URL = "https://iso.omarchy.org/omarchy-4.0.3.iso";

/** The pinned digest — any upstream change is a finding, not something this module absorbs. */
export const ISO_SHA256 = "03d60bc74306dca51f96e1a84b690871d8d606826b260edd0208962da8507d14";

/** The cache file name under `<vm root>/isos/` (derived from the pinned URL — one pin, one name). */
export const ISO_NAME = "omarchy-4.0.3.iso";

/** The operator seed override (see the module header): an absolute path to a pre-existing copy. */
export const ISO_SEED_ENV = "OPENHAMMER_VM_ISO_SEED";

// ---- the shared binary runner ----

const TAIL_BYTES = 4096;

/**
 * The spike's proc.ts `run`, promoted verbatim (the cidata.ts private twin, shared here so
 * the ISO fetch, the install ssh poll, and the qemu-img calls all keep ONE spawn posture):
 * arg array in — never a shell string — optionally piped stdin then EOF, last 4 KiB of both
 * pipes kept, await exit; a spawn failure (ENOENT) resolves `code: null` with the error in
 * the tail — callers check the code and throw with the tail.
 */
export const runBinDefault: RunBin = (bin, args, options = {}): Promise<BinRunResult> =>
	new Promise<BinRunResult>((resolveRun) => {
		const child = spawn(bin, [...args], {
			stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		const keep = (prior: string, chunk: Buffer): string => `${prior}${chunk.toString("utf8")}`.slice(-TAIL_BYTES);
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = keep(stdout, chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr = keep(stderr, chunk);
		});
		const stdin = child.stdin; // nullable in spawn's types regardless of stdio config
		if (options.stdin !== undefined && stdin !== null) {
			stdin.on("error", () => {
				// EPIPE against a child that died before consuming stdin — the exit owns the report.
			});
			stdin.write(options.stdin);
			stdin.end();
		}
		child.on("error", (error: Error) => {
			resolveRun({
				code: null,
				stdoutTail: stdout,
				stderrTail: `${stderr}\nspawn error: ${error.message}`.trim(),
			});
		});
		child.on("close", (code) => {
			resolveRun({ code, stdoutTail: stdout, stderrTail: stderr });
		});
	});

// ---- hashing ----

/**
 * Streamed sha256 of a file — never buffers the whole ~6 GB ISO. (`Readable[Symbol.asyncIterator]`
 * is typed to yield `any` in @types/node 20; the stream is binary, so every chunk is a Buffer —
 * cast through unknown per standards.) Promoted verbatim from the spike's iso.ts.
 */
export async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path) as unknown as AsyncIterable<Buffer>) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

// ---- the fetch ----

export type IsoAction = "cached" | "seeded" | "downloaded";

export interface IsoState {
	readonly path: string;
	readonly action: IsoAction;
	readonly size: number;
	readonly sha256: string;
}

/** The injectable seams (the qemu/process.ts injection-arg precedent: the production call shape stays clean). */
export interface IsoDeps {
	/** Override the file hasher (tests fake the pinned digest without a 6 GB fixture). Default: streamed sha256. */
	readonly hashFile?: (path: string) => Promise<string>;
	/** Override the download runner (tests record the curl argv). Default: {@link runBinDefault}. */
	readonly runBin?: RunBin;
	/** Override the seed-source lookup (default: `process.env.OPENHAMMER_VM_ISO_SEED`). */
	readonly seedPath?: () => string | undefined;
	/** Progress lines (default: none — the install runner passes its own log prefix in). */
	readonly log?: (line: string) => void;
}

/** curl's download argv — `.part` + `--continue-at -` is the resume story (a killed fetch resumes). */
function downloadArgv(partialPath: string): string[] {
	return ["-L", "--continue-at", "-", "-o", partialPath, ISO_URL];
}

/**
 * Ensure the pinned ISO is present and digest-verified under `<vm root>/isos/` (0700):
 * 1. already cached + hashes to the pin → `cached` (no network);
 * 2. a cached file that MIShashes is deleted (stale/partial — re-acquire);
 * 3. no file + a seed source → hardlink-or-copy + verify → `seeded` (mismatch: delete, fall through);
 * 4. download via curl to `.part` (resumable), rename, verify → `downloaded`.
 * A post-download mismatch deletes the file and throws loudly — an unverified ISO is never
 * left where a later boot could find it.
 */
export async function ensureIso(dirs: VmDirs, deps: IsoDeps = {}): Promise<IsoState> {
	const log = deps.log ?? (() => {});
	const hashFile = deps.hashFile ?? sha256OfFile;
	const runBin = deps.runBin ?? runBinDefault;
	const seedPath = deps.seedPath ?? (() => process.env[ISO_SEED_ENV]);

	mkdirSync(dirs.isos, { recursive: true, mode: 0o700 });
	const path = join(dirs.isos, ISO_NAME);

	const existing = statSync(path, { throwIfNoEntry: false });
	if (existing !== undefined) {
		const sha256 = await hashFile(path);
		if (sha256 === ISO_SHA256) {
			return { path, action: "cached", size: existing.size, sha256 };
		}
		log(`existing ${ISO_NAME} hashes ${sha256} (want ${ISO_SHA256}) — re-acquiring`);
		unlinkSync(path);
	}

	const seed = seedPath();
	if (seed !== undefined && seed !== "") {
		const seedStat = statSync(seed, { throwIfNoEntry: false });
		if (seedStat === undefined || !seedStat.isFile()) {
			log(`seed ${ISO_SEED_ENV}=${seed} is not a readable file — downloading instead`);
		} else {
			// Hardlink first: instant for a 5.8 GiB file and shares nothing but the inode; copy
			// is the fallback for cross-device seeds (EXDEV) and odd filesystems refusing links.
			try {
				linkSync(seed, path);
			} catch {
				copyFileSync(seed, path);
			}
			const sha256 = await hashFile(path);
			if (sha256 === ISO_SHA256) {
				return { path, action: "seeded", size: statSync(path).size, sha256 };
			}
			log(`seeded ${ISO_NAME} hashes ${sha256} (want ${ISO_SHA256}) — deleted, downloading instead`);
			unlinkSync(path);
		}
	}

	const partial = `${path}.part`;
	const result = await runBin("curl", downloadArgv(partial));
	if (result.code !== 0) {
		// The .part is deliberately KEPT — it is the resume input for the retry.
		throw new Error(`iso: curl exited ${result.code ?? "spawn error"}: ${result.stderrTail.trim()}`);
	}
	renameSync(partial, path);
	const size = statSync(path).size;
	const sha256 = await hashFile(path);
	if (sha256 !== ISO_SHA256) {
		unlinkSync(path);
		throw new Error(`iso: sha256 mismatch after download (got ${sha256}, want ${ISO_SHA256}) — deleted`);
	}
	return { path, action: "downloaded", size, sha256 };
}
