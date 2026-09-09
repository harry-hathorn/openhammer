// Pinned live-ISO fetch for the spike: download once, verify sha256, never boot unverified.
import { createHash } from "node:crypto";
import { createReadStream, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { run } from "./proc.ts";
import { ISO_NAME, ISO_SHA256, ISO_URL, type SpikeDirs } from "./scratch.ts";

export type IsoAction = "cached" | "downloaded";

export interface IsoState {
	readonly path: string;
	readonly action: IsoAction;
	readonly size: number;
	readonly sha256: string;
}

// `Readable[Symbol.asyncIterator]` is typed to yield `any` in @types/node 20; the stream is
// binary (no setEncoding), so every chunk is a Buffer — cast through unknown per standards.
async function sha256OfFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path) as unknown as AsyncIterable<Buffer>) {
		hash.update(chunk);
	}
	return hash.digest("hex");
}

/**
 * Ensure the pinned Omarchy live ISO is present and digest-verified under
 * `<SPIKE_DIR>/isos/`. Skips the download when the file already hashes correctly;
 * re-downloads (resumable `.part`, `curl --continue-at -`) when absent or stale.
 * A post-download mismatch deletes the file and throws loudly.
 */
export async function ensureIso(dirs: SpikeDirs): Promise<IsoState> {
	const path = join(dirs.isos, ISO_NAME);
	const existing = statSync(path, { throwIfNoEntry: false });
	if (existing !== undefined) {
		const sha256 = await sha256OfFile(path);
		if (sha256 === ISO_SHA256) {
			return { path, action: "cached", size: existing.size, sha256 };
		}
		console.error(`iso: existing ${ISO_NAME} hashes ${sha256} (want ${ISO_SHA256}) — re-downloading`);
		unlinkSync(path);
	}
	const partial = `${path}.part`;
	const result = await run("curl", ["-L", "--continue-at", "-", "-o", partial, ISO_URL]);
	if (result.code !== 0) {
		throw new Error(`iso: curl exited ${result.code}: ${result.stderrTail.trim()}`);
	}
	renameSync(partial, path);
	const size = statSync(path).size;
	const sha256 = await sha256OfFile(path);
	if (sha256 !== ISO_SHA256) {
		unlinkSync(path);
		throw new Error(`iso: sha256 mismatch after download (got ${sha256}, want ${ISO_SHA256}) — deleted`);
	}
	return { path, action: "downloaded", size, sha256 };
}
