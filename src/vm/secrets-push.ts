// Session-start secrets push (spec 29) — the post-readiness ride over the ToolBackend's fs
// that turns 26a's host-side store into the guest's THREE working env contexts (22-measured
// gate 4 / finding 11):
//
// - `~/.openhammer/env` — the runShell-prefix context (backend.ts's wrapper sources it with
//   `set -a` for EVERY non-interactive ssh exec) and, via 26d's bashrc/zshrc source lines,
//   the interactive-shell context.
// - `~/.config/environment.d/openhammer.conf` — the graphical/user-manager context: systemd's
//   user manager parses it when the manager STARTS, so Hyprland/compositor launches inherit
//   the pairs even though they never see a shell rc file. The environment.d format IS
//   KEY=value lines, so both guest files receive IDENTICAL bytes.
// - each `files` entry — the credential map, written to its absolute guest path.
//
// THE FORMAT IS THE STORE'S: plain sorted `KEY=value` lines — 26a's serializeEnv shape,
// deliberately restated here (secrets.ts keeps its serializer private) so the pushed bytes
// are byte-identical to what the host store holds. No quoting layer: all three consumers
// are line-based parsers, and the store already rejects newlines/NULs at write time.
//
// PERMS: the vm fs's writeFile has NO mode argument (`base64 -d > "$1"` — fs-ssh.ts), so a
// pushed file lands at the guest umask default (0644). Every written file therefore gets a
// follow-up `chmod 600` through `runArgv` — the ARGV twin, never a shell string (a guest
// path is one quoted argv element; spawn hygiene). The two env files carry the same
// credential values the store keeps at 0600 host-side, so they ride the same chmod: the
// store's posture (26a: "never silently downgrade security on") mirrored guest-side.
//
// ERROR MODEL: a missing/unreadable HOST credential file is a REPORTED SKIP, not a throw —
// the store allowed mapping a not-yet-existing file (26a's hostPath contract: "existence is
// NOT checked here — spec 29 checks at consumption"), and consumption is exactly this push.
// Any BACKEND failure — a Result-err from an fs op, a non-zero chmod — THROWS: this layer
// reports honestly instead of half-succeeding silently, and the CALLER (the service wiring)
// owns the fatal-vs-logged decision (spec 29's wiring makes it non-fatal; see service.ts).
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ToolBackend } from "../tools/backend.ts";
import type { SecretsStore } from "./provision/secrets.ts";

/** The guest env file, relative to the backend's guest home — the runShell/rc-file context. */
export const GUEST_ENV_REL_PATH = ".openhammer/env";

/** The environment.d conf, relative to the guest home — the graphical-session context. */
export const GUEST_ENVIRONMENT_D_REL_PATH = ".config/environment.d/openhammer.conf";

/** One credential file the guest did NOT receive, and why (the host read's error). */
export interface SecretsPushSkip {
	/** The mapped HOST path that could not be delivered. */
	readonly hostPath: string;
	/** Why (the host read's error message — ENOENT for the never-existed case). */
	readonly reason: string;
}

/** What one push amounted to — the service's log line and the tests' assertion target. */
export interface PushReport {
	/** Env pairs written to BOTH guest env files. */
	readonly envPairs: number;
	/** Credential files pushed to their guest paths (0600 in-guest). */
	readonly filesPushed: number;
	/** Credential files skipped — the store allowed them; the host could not deliver. */
	readonly filesSkipped: readonly SecretsPushSkip[];
}

/** Injection seams (the repo's injection-arg precedent: the production call shape stays clean). */
export interface PushSecretsDeps {
	/** Override the HOST credential read (default: fs/promises readFile — bytes, not text). */
	readonly readHostFile?: (path: string) => Promise<Buffer>;
}

/** The env files' exact bytes: keys SORTED, `KEY=value\n` — 26a's store format, restated. */
export function serializeEnvLines(env: Record<string, string>): string {
	return [...Object.keys(env)]
		.sort()
		.map((key) => `${key}=${env[key]}\n`)
		.join("");
}

/** Narrow an unknown throw/catch value to its message string (the repo's messageOf). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * One guest file write, complete: mkdir -p the PARENT (the ssh writeFile is a `> "$1"`
 * redirect — it cannot create directories, and a fresh golden's credential homes do not
 * exist yet), then the fs backend's writeFile (no mode arg — see the module header), then
 * `chmod 600 <path>` through runArgv so the file never sits at the guest umask default.
 * Any failure throws with the actionable detail (the fs op's error, or the chmod's exit +
 * a bounded stderr tail).
 */
async function writeGuestFile(backend: ToolBackend, guestPath: string, data: Buffer): Promise<void> {
	const dir = dirname(guestPath);
	const made = await backend.fs.mkdir(dir);
	if (!made.ok) {
		throw new Error(`secrets push: cannot create ${dir}: ${made.error.message}`);
	}
	const written = await backend.fs.writeFile(guestPath, data);
	if (!written.ok) {
		throw new Error(`secrets push: cannot write ${guestPath}: ${written.error.message}`);
	}
	let stderrTail = "";
	const chmod = await backend.runArgv("chmod", ["600", guestPath], {
		onStderr: (chunk: Buffer) => {
			stderrTail = `${stderrTail}${chunk.toString("utf8")}`.slice(-2048);
		},
	});
	if (chmod.exitCode !== 0) {
		const detail = chmod.timedOut ? " (timed out)" : stderrTail.trim() === "" ? "" : `: ${stderrTail.trim()}`;
		throw new Error(`secrets push: chmod 600 ${guestPath} exited ${chmod.exitCode}${detail}`);
	}
}

/**
 * Push the store into the guest over the backend's fs (spec 29's session-start extras).
 * Sequence: write `~/.openhammer/env` → write `~/.config/environment.d/openhammer.conf`
 * (identical sorted KEY=value bytes, both chmod 600) → per credential file: host read
 * (missing/unreadable = a reported skip) → guest writeFile → chmod 600. Every write is
 * mkdir -p the parent first (see {@link writeGuestFile}) — the env dirs AND each mapped
 * credential's parent, since a fresh agent golden has neither `.config/environment.d` nor,
 * say, `~/.claude` (nothing is baked — the FIRST credential push must create its home).
 * Throws on any backend failure; the caller decides fatal vs logged-continue.
 */
export async function pushSecrets(
	backend: ToolBackend,
	store: SecretsStore,
	deps: PushSecretsDeps = {},
): Promise<PushReport> {
	const readHostFile = deps.readHostFile ?? readFile;
	const home = backend.homedir(); // the GUEST home (VmBackend derives it from the manifest's user)

	// The dual injection: one content, two files, two consumers (the module header's three
	// contexts). Written even when the store's env half is empty — the files ARE the
	// injection points, and empty bytes inject nothing (an idempotent no-op, like the
	// store's own saveSecrets writing an empty env half).
	const envContent = Buffer.from(serializeEnvLines(store.env), "utf8");
	await writeGuestFile(backend, join(home, GUEST_ENV_REL_PATH), envContent);
	await writeGuestFile(backend, join(home, GUEST_ENVIRONMENT_D_REL_PATH), envContent);

	const filesSkipped: SecretsPushSkip[] = [];
	let filesPushed = 0;
	for (const mapping of store.files) {
		let data: Buffer;
		try {
			data = await readHostFile(mapping.hostPath);
		} catch (error) {
			// The store allowed mapping a not-yet-existing file; consumption is where
			// existence is judged — skip with the reason, never throw (the module header).
			filesSkipped.push({ hostPath: mapping.hostPath, reason: messageOf(error) });
			continue;
		}
		await writeGuestFile(backend, mapping.guestPath, data);
		filesPushed += 1;
	}
	return { envPairs: Object.keys(store.env).length, filesPushed, filesSkipped };
}
