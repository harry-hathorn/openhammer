// FsBackend over the ssh transport — spec 25's FsBackend-over-ssh checkbox (25b; 25a's ssh.ts
// is the transport underneath, 25c's VmBackend is the consumer that embeds this as its `fs`).
// Every op is ONE sshExec call with a REMOTE ARGV — the per-element quoting is 25a's
// remoteQuote chain (sshExecArgv quotes each element, joins with spaces, hands ssh ONE
// pre-joined command element; see ssh.ts's module header for why that must be one element).
// This file owns the guest-binary choices and the Result mapping; spawn hygiene is inherited
// from the transport, not re-solved here.
//
// THE OP TABLE (the guest is spec 26's golden image — coreutils + bash are pinned there):
//
//   readFile(path)   ["base64", "-w0", "--", path]
//   writeFile(p, d)  ["bash", "-c", 'base64 -d > "$1"', "bash", p]     data rides STDIN
//   stat(path)       ["stat", "-c", "%F|%s|%Y", "--", path]
//   readdir(path)    ["ls", "-1A", "--", path]
//   mkdir(path)      ["mkdir", "-p", "--", path]
//   exists(path)     ["test", "-e", path]
//   access(path)     ["test", "-r", path]
//
// `--` DISCIPLINE, PER OP: the coreutils getopt utilities (base64/stat/ls/mkdir) take `--`,
// so it rides every one of their argvs — a guest path can never be option-parsed even if the
// absolute-path contract below ever broke. `test` is the deliberate exception: POSIX test has
// NO `--` handling (a literal `--` is a string operand — `test -e -- path` tests one string,
// not the path), and it needs none, because every path this backend receives is an ABSOLUTE
// guest path by contract (the tools resolve through resolveToCwd before the seam; 25c keeps
// that true in VM mode) and an absolute path starts with `/`, which nothing parses as an
// option. `test` invoked bare resolves to the guest shell's BUILTIN (dash/bash both carry
// one) — semantically identical to /usr/bin/test. writeFile's path needs no guard either: it
// rides `$1`, an argv slot remoteQuote delivers as one quoted word the fixed script never
// re-parses — and sh never option-parses a `>` redirect target at all.
//
// THE writeFile SCRIPT SHAPE: `base64 -d > "$1"`. The redirect must exist (base64 has no
// output flag), so this is the fs layer's ONE bash -c shell string (bash stays the sanctioned
// shell-string exception, AGENTS.md:79). There is deliberately NO `--` after `-d` because no
// operand follows it — stdin is the input, so a `--` there would guard nothing. The path
// rides the `$1` argv slot, never the script text; the script itself is a compile-time
// constant. Data streams as base64 over stdin — no ARG_MAX ceiling (spec 25's requirement).
//
// FULL-STDOUT PAYLOADS: readFile and readdir buffer their ENTIRE stdout through sshExec's
// onStdout into a local chunk array, concatenated once at resolution. The 4 KiB stdoutTail
// is a bounded diagnostic tail (ssh.ts's tailSink), NOT a payload channel — a readdir of a
// populated directory blows straight past 4 KiB, and so does any real file. stat's
// fixed-shape ~30-byte line is the one payload small enough to ride the tail. readFile's
// memory ceiling (documented, not re-architected — nothing in the tool layer reads that
// much): the file exists guest-side, crosses the wire as base64 (~4/3x), lands as host text,
// then decodes — peak ~2.4x the file size host-side. The read tool caps at 50 KB
// (truncate.ts), three orders of magnitude below any practical ceiling.
//
// readdir FIDELITY: `-A`, not the spec's bare `-1`. node:fs readdir — LocalBackend's
// behavior, which spec 23 froze as "zero behavior change" — includes dotfiles and excludes
// `.`/`..`; plain `ls -1` HIDES dotfiles and would silently break the ls tool's documented
// "Includes dotfiles" contract. Known edges, inherent to any line-based listing: a guest
// filename containing a NEWLINE splits into phantom entries (readFile/writeFile/stat handle
// such names losslessly — the path is one quoted argv element; only the readdir listing is
// ambiguous), and `ls` lists a non-directory operand as itself, exit 0, where node readdir
// errs ENOTDIR — unreachable through the tools (ls.ts stats-and-gates isDir before readdir).
//
// ERROR MODEL (the Result spine): every expected failure returns err, never throws; the
// promise rejects only if the transport itself does (the real sshExec rejects only on a
// spawn error). Non-zero guest exits err carrying the guest's own stderr in the message plus
// a node errno `.code` when that stderr matches a known fragment — edit.ts's errnoCode reads
// `.code`, so cross-backend error classification keeps working. `test -r`'s exit 1 is
// ambiguous between missing and unreadable where node's access(R_OK) distinguishes ENOENT
// from EACCES — so rc 1 pays ONE follow-up `test -e` over the mux to restore the distinction
// (the happy path stays a single op per call).
import type { FsBackend, StatShape } from "../tools/backend.ts";
import { err, ok } from "../tools/result.ts";
import { type SshExecResult, type SshTarget, sshExec } from "./ssh.ts";

/** The exec seam this layer rides — structural: the real sshExec and a recording fake fit alike. */
export type SshFsExec = typeof sshExec;

/** Injectable seams (the qemu/process.ts injection-arg precedent: the production call shape stays clean). */
export interface SshFsDeps {
	/** Override the transport exec. Default: the real muxed sshExec. */
	readonly exec?: SshFsExec;
}

/**
 * Guest stderr fragment → node errno code. The guest's wording is preserved verbatim in the
 * error message; the code is the machine-readable half cross-backend consumers switch on.
 */
const ERRNO_BY_FRAGMENT: ReadonlyArray<readonly [string, string]> = [
	["No such file or directory", "ENOENT"],
	["Permission denied", "EACCES"],
	["Not a directory", "ENOTDIR"],
	["Is a directory", "EISDIR"],
	["File exists", "EEXIST"],
];

/** Strict base64 — the exact shape coreutils `base64 -w0` emits: alphabet, at most two `=`. */
const STRICT_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

function errnoFromStderr(stderr: string): string | undefined {
	for (const [fragment, code] of ERRNO_BY_FRAGMENT) {
		if (stderr.includes(fragment)) return code;
	}
	return undefined;
}

/** A non-zero guest exit → err carrying the guest's stderr and a classified errno code. */
function guestError(op: string, path: string, result: SshExecResult): NodeJS.ErrnoException {
	const stderr = result.stderrTail.trim();
	const code = errnoFromStderr(stderr);
	const detail = stderr === "" ? "(no guest stderr)" : stderr;
	const error: NodeJS.ErrnoException = new Error(`ssh fs ${op} '${path}': guest exited ${result.exitCode}: ${detail}`);
	if (code !== undefined) error.code = code;
	return error;
}

/** A node-shaped errno error (`ENOENT: no such file or directory, access '/x'`) — LocalBackend's exact text. */
function errnoError(code: "ENOENT" | "EACCES", op: string, path: string): NodeJS.ErrnoException {
	const fragment = code === "ENOENT" ? "no such file or directory" : "permission denied";
	const error: NodeJS.ErrnoException = new Error(`${code}: ${fragment}, ${op} '${path}'`);
	error.code = code;
	return error;
}

/** Collect a pipe's FULL stream — the payload channel (sshExec's 4 KiB tails are diagnostics only). */
function fullStdoutSink(): { push(chunk: Buffer): void; text(): string } {
	const chunks: Buffer[] = [];
	return {
		push(chunk: Buffer): void {
			chunks.push(chunk);
		},
		text(): string {
			return Buffer.concat(chunks).toString("utf8");
		},
	};
}

/**
 * The FsBackend over one ssh target: every op one muxed sshExec (~ms warm — spec 22 gate 7),
 * Result-wrapped, never throwing for expected failures. Paths are absolute guest paths by
 * contract (see the module header); `~` in a path can never expand host-side because these
 * argvs never touch a host shell at all, and never expand guest-side because remoteQuote
 * single-quotes every element.
 */
export function createSshFs(target: SshTarget, deps: SshFsDeps = {}): FsBackend {
	const run = deps.exec ?? sshExec;
	return {
		readFile: async (path) => {
			const stdout = fullStdoutSink();
			const result = await run(target, ["base64", "-w0", "--", path], {
				onStdout: (chunk) => stdout.push(chunk),
			});
			if (result.exitCode !== 0) {
				return err(guestError("readFile", path, result));
			}
			const encoded = stdout.text();
			// Node's base64 decoder is LENIENT (it skips foreign characters) — the regex +
			// length gate is what makes corrupt output err instead of decoding garbage.
			if (!STRICT_BASE64.test(encoded) || encoded.length % 4 !== 0) {
				return err(
					new Error(
						`ssh fs readFile '${path}': guest base64 emitted a non-strict payload (${encoded.length} bytes)`,
					),
				);
			}
			return ok(Buffer.from(encoded, "base64"));
		},

		writeFile: async (path, data) => {
			const result = await run(target, ["bash", "-c", 'base64 -d > "$1"', "bash", path], {
				stdin: data.toString("base64"),
			});
			if (result.exitCode !== 0) {
				return err(guestError("writeFile", path, result));
			}
			return ok(undefined);
		},

		stat: async (path) => {
			const result = await run(target, ["stat", "-c", "%F|%s|%Y", "--", path]);
			if (result.exitCode !== 0) {
				return err(guestError("stat", path, result));
			}
			// One line, one `|`-join, fixed shape (`regular file|1234|1699999999`) — comfortably
			// inside the 4 KiB tail, so this op alone may parse the tail instead of buffering.
			const line = result.stdoutTail.trim();
			const parts = line.split("|");
			// %F words contain no `|` and the numerics are decimal; anything else is a guest
			// we do not understand, which errs rather than inventing a stat.
			if (parts.length !== 3 || !/^\d+$/.test(parts[1] ?? "") || !/^-?\d+$/.test(parts[2] ?? "")) {
				return err(new Error(`ssh fs stat '${path}': unparseable guest stat output: ${line}`));
			}
			const typeWords = parts[0] ?? "";
			return ok({
				isFile: typeWords === "regular file",
				isDir: typeWords === "directory",
				size: Number(parts[1]),
				// %Y is whole seconds — the cross-backend StatShape carries ms, so ×1000
				// (sub-second guest mtimes are outside this transport's resolution).
				mtimeMs: Number(parts[2]) * 1000,
			} satisfies StatShape);
		},

		readdir: async (path) => {
			const stdout = fullStdoutSink();
			const result = await run(target, ["ls", "-1A", "--", path], {
				onStdout: (chunk) => stdout.push(chunk),
			});
			if (result.exitCode !== 0) {
				return err(guestError("readdir", path, result));
			}
			const listing = stdout.text();
			if (listing === "") return ok([]); // empty directory
			// ls terminates every entry with \n; strip one trailing newline, then split.
			return ok((listing.endsWith("\n") ? listing.slice(0, -1) : listing).split("\n"));
		},

		mkdir: async (path) => {
			const result = await run(target, ["mkdir", "-p", "--", path]);
			if (result.exitCode !== 0) {
				return err(guestError("mkdir", path, result));
			}
			return ok(undefined);
		},

		exists: async (path) => {
			const result = await run(target, ["test", "-e", path]);
			if (result.exitCode === 0) return ok(true);
			if (result.exitCode === 1) return ok(false);
			// rc 2 is unreachable for `-e <path>`; anything else (255 = connection death) errs.
			return err(guestError("exists", path, result));
		},

		access: async (path) => {
			const result = await run(target, ["test", "-r", path]);
			if (result.exitCode === 0) return ok(undefined);
			if (result.exitCode === 1) {
				// `test -r` rc 1 is missing OR unreadable; node's access(R_OK) says which, so
				// one extra muxed hop (failure path only) restores the ENOENT/EACCES split.
				const existence = await run(target, ["test", "-e", path]);
				if (existence.exitCode === 1) return err(errnoError("ENOENT", "access", path));
				if (existence.exitCode === 0) return err(errnoError("EACCES", "access", path));
				return err(guestError("access", path, existence));
			}
			return err(guestError("access", path, result));
		},
	};
}
