// Spec 22 — Phase 0 spike harness. Throwaway-but-reproducible: never imported from src/,
// excluded from the npm package (files: ["dist"]). Plain TS run with `npx tsx`.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

// The pin is the contract: any digest change upstream is a finding, not something we absorb.
export const ISO_URL = "https://iso.omarchy.org/omarchy-4.0.3.iso";
export const ISO_SHA256 = "03d60bc74306dca51f96e1a84b690871d8d606826b260edd0208962da8507d14";
export const ISO_NAME = "omarchy-4.0.3.iso";

export interface SpikeDirs {
	readonly root: string;
	readonly isos: string;
	readonly sessions: string;
	readonly runs: string;
}

/**
 * Resolve (and create, 0700) the spike scratch tree. `SPIKE_DIR` overrides the default
 * `~/.openhammer/vm-spike` — every big artifact (the ~6 GB ISO, 40G qcow2 disks, serial
 * logs, session OVMF VARS copies) lives under the resolved root and nowhere else.
 */
export function openSpikeDirs(): SpikeDirs {
	const root = resolve(process.env.SPIKE_DIR ?? join(homedir(), ".openhammer", "vm-spike"));
	const dirs: SpikeDirs = {
		root,
		isos: join(root, "isos"),
		sessions: join(root, "sessions"),
		runs: join(root, "runs"),
	};
	for (const path of [root, dirs.isos, dirs.sessions, dirs.runs]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
	}
	return dirs;
}
