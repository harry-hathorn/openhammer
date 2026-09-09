import { spawn as realSpawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FsBackend } from "../tools/backend.ts";
import type { Result } from "../tools/result.ts";
import { createSshFs } from "./fs-ssh.ts";
import { type SshExecOptions, type SshExecResult, type SshTarget, sshExec, sshExecArgv } from "./ssh.ts";

// The sample session target (ssh.test.ts's): paths are opaque strings to the builders.
const TARGET: SshTarget = {
	user: "sandbox",
	host: "127.0.0.1",
	port: 41733,
	keyPath: "/vm/secrets/id_ed25519",
	knownHostsPath: "/vm/sessions/s1/known_hosts",
	controlPath: "/vm/sessions/s1/cm.sock",
};

/** Unwrap a Result for happy-path assertions (failures throw with the real message). */
function unwrap<T>(result: Result<T>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/** edit.ts's errnoCode, test-side: the errno code an Error carries, if any. */
function errnoCode(error: Error): string | undefined {
	return "code" in error && typeof error.code === "string" ? error.code : undefined;
}

// ---------------------------------------------------------------- unit fakes ----

/** One scripted exec outcome: the resolved result plus chunks emitted through the callbacks. */
interface ScriptedExec extends Partial<SshExecResult> {
	exitCode: number;
	/** Emitted through opts.onStdout in order, before the result resolves. */
	stdoutChunks?: string[];
	/** Emitted through opts.onStderr in order, before the result resolves. */
	stderrChunks?: string[];
}

/** A recorded exec call: the remote argv + the options the op threaded through. */
interface RecordedExecCall {
	remoteArgv: string[];
	opts: SshExecOptions;
}

/**
 * The injected exec seam: records every (remoteArgv, opts) and answers from the script (an
 * exhausted or absent entry resolves exit 0 with empty pipes). stdout/stderr chunks go through
 * the callbacks — NOT into the resolved tails — so payload handling cannot accidentally lean
 * on the 4 KiB tail the real sshExec also fills separately.
 */
function recordingExec(script: ScriptedExec[] = []): { exec: typeof sshExec; calls: RecordedExecCall[] } {
	const calls: RecordedExecCall[] = [];
	let next = 0;
	const exec: typeof sshExec = async (_target, remoteArgv, opts = {}) => {
		calls.push({ remoteArgv: [...remoteArgv], opts });
		const entry = script[next];
		next += 1;
		for (const chunk of entry?.stdoutChunks ?? []) opts.onStdout?.(Buffer.from(chunk, "utf8"));
		for (const chunk of entry?.stderrChunks ?? []) opts.onStderr?.(Buffer.from(chunk, "utf8"));
		return {
			exitCode: entry?.exitCode ?? 0,
			timedOut: false,
			stdoutTail: entry?.stdoutTail ?? "",
			stderrTail: entry?.stderrTail ?? "",
		};
	};
	return { exec, calls };
}

// ------------------------------------------------------- real-process plumbing ----

// The hostile gates need a POSIX sh plus, for the echo stub and the local-ssh model, real
// coreutils — skip (never fail) on hosts without them (the ssh.test.ts precedent).
const shExists = statSync("/bin/sh", { throwIfNoEntry: false }) !== undefined;

/** Resolve a binary's absolute path with the REAL PATH (before any stub shadows it). */
function commandPath(bin: string): string | undefined {
	if (!shExists) return undefined;
	const result = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8" });
	const path = result.stdout.trim();
	return result.status === 0 && path !== "" && !path.includes("\n") ? path : undefined;
}

const REAL_BASE64 = commandPath("base64");
const REAL_BASH = commandPath("bash");

const canEcho = shExists && REAL_BASE64 !== undefined;
const canLocalSsh = canEcho && REAL_BASH !== undefined;
const itSh = shExists ? it : it.skip;
const itEcho = canEcho ? it : it.skip;
const itLocalSsh = canLocalSsh ? it : it.skip;

/** Spawn a real process: byte-exact stdout, text stderr, optional env/cwd/stdin. */
function capture(
	bin: string,
	args: readonly string[],
	opts?: { env?: NodeJS.ProcessEnv; cwd?: string; stdin?: string },
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = realSpawn(bin, [...args], {
			env: opts?.env ?? process.env,
			cwd: opts?.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		const chunks: Buffer[] = [];
		let stderrText = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrText += chunk.toString("utf8");
		});
		// EPIPE against a child that exited first is stream-level noise; close/error own the
		// report (the ssh.ts stdin-error precedent).
		child.stdin?.on("error", () => {});
		if (opts?.stdin !== undefined) child.stdin?.write(opts.stdin);
		child.stdin?.end();
		child.on("error", (error: Error) => reject(error));
		child.on("close", (code) => resolve({ code, stdout: Buffer.concat(chunks), stderr: stderrText }));
	});
}

/**
 * A LOCAL ssh model for the exec seam: rides the REAL sshExec (real argv construction, real
 * stdin write-then-EOF, real stream plumbing) with the spawn replaced by `/bin/sh -c <joined>`
 * — exactly what the guest's sshd does with the joined command string. The result: the ops run
 * against the HOST's filesystem through the genuine quoting chain, end to end.
 */
function localSshExec(): typeof sshExec {
	return (target, remoteArgv, opts = {}, deps = {}) =>
		sshExec(target, remoteArgv, opts, {
			...deps,
			spawn: (_bin, args) => {
				const joined = args.at(-1) ?? "";
				return realSpawn("/bin/sh", ["-c", joined], {
					env: process.env,
					stdio: ["pipe", "pipe", "pipe"],
					windowsHide: true,
				});
			},
		});
}

/**
 * The echo-stub PATH: one generic stub (echo each received argument as ONE base64 line via the
 * REAL base64 — resolved by absolute path, because the stub named `base64` shadows PATH lookup
 * and a bare `base64` inside it would recurse), plus a same-name wrapper for every guest
 * binary the fs ops invoke that is NOT a shell builtin. `test` is a dash/bash BUILTIN — no
 * PATH stub can see it — so exists/access are gated semantically in their own test below.
 */
function writeEchoStubs(): string {
	if (REAL_BASE64 === undefined) throw new Error("echo gate needs a real base64 on PATH");
	const dir = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-stubs-"));
	const stub = join(dir, "echo-args");
	writeFileSync(
		stub,
		`#!/bin/sh\nfor arg in "$@"; do\n\tprintf '%s' "$arg" | ${REAL_BASE64} -w0\n\tprintf '\\n'\ndone\n`,
	);
	chmodSync(stub, 0o755);
	for (const name of ["base64", "bash", "ls", "mkdir", "stat"]) {
		const bin = join(dir, name);
		writeFileSync(bin, `#!/bin/sh\nexec '${stub}' "$@"\n`);
		chmodSync(bin, 0o755);
	}
	return dir;
}

/** The hostile corpus (spec 25's hard gate): every shape that breaks naive quoting. */
const HOSTILE_NAMES = [
	"plain.txt",
	"has space.txt",
	"quo'te.txt",
	'dou"ble.txt',
	"$(danger).txt",
	"back`tick.txt",
	"new\nline.txt",
	"-leading-dash",
	"semi;colon.txt",
	"pipe|.txt",
	"amp&ersand.txt",
	"~tilde.txt",
	"$HOME.txt",
	"éuni.txt",
	"a b.txt",
];

/**
 * Drive one op through the backend, then return the exact pair ssh would ship: the remote
 * argv AND the joined, per-argument-quoted command string sshExecArgv produces for it (the
 * string the guest's sshd hands to `sh -c`).
 */
async function joinedCommandFor(
	invoke: (fs: FsBackend, path: string) => Promise<unknown>,
	path: string,
): Promise<{ remoteArgv: string[]; joined: string }> {
	const recorder = recordingExec();
	const fs = createSshFs(TARGET, { exec: recorder.exec });
	await invoke(fs, path);
	const remoteArgv = recorder.calls[0]?.remoteArgv;
	if (remoteArgv === undefined) throw new Error("no exec call recorded for the op");
	const joined = sshExecArgv(TARGET, remoteArgv).at(-1);
	if (joined === undefined) throw new Error("no joined command produced");
	return { remoteArgv, joined };
}

// ------------------------------------------------------------ op argv (golden) ----

describe("createSshFs op construction (fake exec)", () => {
	it("builds the exact remote argv per op, exactly one exec each (golden table)", async () => {
		const cases: Array<{
			op: string;
			invoke: (fs: FsBackend) => Promise<unknown>;
			argv: string[];
			opts: { stdin?: string; onStdout?: boolean };
		}> = [
			{
				op: "readFile",
				invoke: (fs) => fs.readFile("/g/f.txt"),
				argv: ["base64", "-w0", "--", "/g/f.txt"],
				opts: { onStdout: true },
			},
			{
				op: "writeFile",
				invoke: (fs) => fs.writeFile("/g/f.txt", Buffer.from("hi")),
				argv: ["bash", "-c", 'base64 -d > "$1"', "bash", "/g/f.txt"],
				opts: { stdin: Buffer.from("hi").toString("base64") },
			},
			{
				op: "stat",
				invoke: (fs) => fs.stat("/g/f.txt"),
				argv: ["stat", "-c", "%F|%s|%Y", "--", "/g/f.txt"],
				opts: {},
			},
			{
				op: "readdir",
				invoke: (fs) => fs.readdir("/g/d"),
				argv: ["ls", "-1A", "--", "/g/d"],
				opts: { onStdout: true },
			},
			{
				op: "mkdir",
				invoke: (fs) => fs.mkdir("/g/d"),
				argv: ["mkdir", "-p", "--", "/g/d"],
				opts: {},
			},
			{
				op: "exists",
				invoke: (fs) => fs.exists("/g/f.txt"),
				argv: ["test", "-e", "/g/f.txt"],
				opts: {},
			},
			{
				op: "access",
				invoke: (fs) => fs.access("/g/f.txt"),
				argv: ["test", "-r", "/g/f.txt"],
				opts: {},
			},
		];
		for (const { op, invoke, argv, opts } of cases) {
			const recorder = recordingExec();
			const fs = createSshFs(TARGET, { exec: recorder.exec });
			await invoke(fs);
			expect(recorder.calls.length, `${op}: exactly one exec`).toBe(1);
			const call = recorder.calls[0];
			if (call === undefined) throw new Error(`${op}: no call recorded`);
			expect({ op, argv: call.remoteArgv }).toEqual({ op, argv });
			expect(call.opts.stdin, `${op}: stdin`).toBe(opts.stdin);
			if (opts.onStdout === true) {
				expect(typeof call.opts.onStdout, `${op}: buffers full stdout`).toBe("function");
			} else {
				expect(call.opts.onStdout, `${op}: no stdout buffering`).toBeUndefined();
			}
		}
	});
});

// ------------------------------------------------------------------- readFile ----

describe("readFile", () => {
	it("decodes chunked base64 across split mid-token boundaries", async () => {
		const data = Buffer.from("every byte will split the payload mid-token", "utf8");
		const encoded = data.toString("base64");
		const recorder = recordingExec([
			{ exitCode: 0, stdoutChunks: [encoded.slice(0, 7), encoded.slice(7, 20), encoded.slice(20)] },
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/a.txt");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.equals(data)).toBe(true);
	});

	it("reads the payload from the onStdout STREAM, not the 4 KiB tail — beyond the tail bound", async () => {
		// 12 KiB of deterministic bytes → ~16 KiB of base64, four chunks; the scripted tail
		// holds decoy text to prove nothing payload-shaped ever reads it.
		const data = Buffer.alloc(12 * 1024);
		for (let i = 0; i < data.length; i++) data[i] = i % 251;
		const encoded = data.toString("base64");
		const chunkSize = Math.ceil(encoded.length / 4);
		const recorder = recordingExec([
			{
				exitCode: 0,
				stdoutChunks: [0, 1, 2, 3].map((n) => encoded.slice(n * chunkSize, (n + 1) * chunkSize)),
				stdoutTail: "DECOY-TAIL-NOT-THE-PAYLOAD",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/big.bin");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.equals(data)).toBe(true);
	});

	it("an empty file is an empty buffer (empty base64 is strict)", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutChunks: [] }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/empty.txt");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.equals(Buffer.alloc(0))).toBe(true);
	});

	it("a non-zero guest exit errs with the guest stderr and a classified errno", async () => {
		const recorder = recordingExec([
			{
				exitCode: 1,
				stderrChunks: ["base64: /g/a.txt: No such file or directory\n"],
				stderrTail: "base64: /g/a.txt: No such file or directory\n",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/a.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("guest exited 1");
			expect(result.error.message).toContain("No such file or directory");
			expect(errnoCode(result.error)).toBe("ENOENT");
		}
	});

	it("connection death (exit 255, no stderr) errs without inventing guest words", async () => {
		const recorder = recordingExec([{ exitCode: 255 }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/a.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("guest exited 255");
			expect(result.error.message).toContain("(no guest stderr)");
			expect(errnoCode(result.error)).toBeUndefined();
		}
	});

	it("non-strict base64 output errs instead of decoding garbage (node's decoder is lenient)", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutChunks: ["certa!nly~not(base64)"] }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readFile("/g/corrupt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("non-strict payload");
	});
});

// ------------------------------------------------------------------ writeFile ----

describe("writeFile", () => {
	it("streams the data as base64 over stdin; the path rides the $1 argv slot", async () => {
		const data = Buffer.from([0, 1, 2, 250, 251, 255]);
		const recorder = recordingExec();
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.writeFile("/g/f.bin", data);
		expect(result.ok).toBe(true);
		const call = recorder.calls[0];
		if (call === undefined) throw new Error("no call recorded");
		expect(call.remoteArgv).toEqual(["bash", "-c", 'base64 -d > "$1"', "bash", "/g/f.bin"]);
		expect(call.opts.stdin).toBe(data.toString("base64"));
	});

	it("every byte value 0-255 encodes to valid stdin base64 (round-trip decode)", async () => {
		const data = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
		const recorder = recordingExec();
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		await fs.writeFile("/g/all.bin", data);
		const call = recorder.calls[0];
		const stdin = call?.opts.stdin;
		expect(typeof stdin).toBe("string");
		if (stdin !== undefined) expect(Buffer.from(stdin, "base64").equals(data)).toBe(true);
	});

	it("a failed redirect (missing parent) errs ENOENT-shaped from the guest stderr", async () => {
		const recorder = recordingExec([
			{
				exitCode: 1,
				stderrChunks: ["bash: line 1: /g/missing/f.txt: No such file or directory\n"],
				stderrTail: "bash: line 1: /g/missing/f.txt: No such file or directory\n",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.writeFile("/g/missing/f.txt", Buffer.from("x"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("No such file or directory");
			expect(errnoCode(result.error)).toBe("ENOENT");
		}
	});
});

// ---------------------------------------------------------------------- stat ----

describe("stat", () => {
	it("parses the %F|%s|%Y line: regular file", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutTail: "regular file|1234|1699999999\n" }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.stat("/g/f.txt");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.isFile).toBe(true);
			expect(result.value.isDir).toBe(false);
			expect(result.value.size).toBe(1234);
			expect(result.value.mtimeMs).toBe(1699999999000);
		}
	});

	it("parses the %F|%s|%Y line: directory", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutTail: "directory|4096|1700000000\n" }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.stat("/g/d");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.isFile).toBe(false);
			expect(result.value.isDir).toBe(true);
		}
	});

	it("a non-file non-dir type is neither (stat follows symlinks, so this is rare but legal)", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutTail: "local socket|0|1700000000\n" }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.stat("/g/sock");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.isFile).toBe(false);
			expect(result.value.isDir).toBe(false);
		}
	});

	it("a missing path errs ENOENT-shaped with the guest's own stderr", async () => {
		const recorder = recordingExec([
			{
				exitCode: 1,
				stderrChunks: ["stat: cannot statx '/g/a.txt': No such file or directory\n"],
				stderrTail: "stat: cannot statx '/g/a.txt': No such file or directory\n",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.stat("/g/a.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("cannot statx");
			expect(errnoCode(result.error)).toBe("ENOENT");
		}
	});

	it("unparseable output errs instead of inventing a stat", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutTail: "garbage\n" }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.stat("/g/x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("unparseable");
	});
});

// ------------------------------------------------------------------- readdir ----

describe("readdir", () => {
	it("splits lines and keeps dotfiles (-A: node readdir parity)", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutChunks: ["a.txt\n.hidden\nb dir\n"] }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readdir("/g/d");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual(["a.txt", ".hidden", "b dir"]);
	});

	it("an empty directory is [] — not a phantom empty entry", async () => {
		const recorder = recordingExec([{ exitCode: 0, stdoutChunks: [] }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readdir("/g/empty");
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value).toEqual([]);
	});

	it("buffers the FULL listing past the 4 KiB tail bound", async () => {
		const names = Array.from({ length: 1200 }, (_, i) => `entry-${String(i).padStart(5, "0")}`);
		const listing = `${names.map((name) => `${name}\n`).join("")}`;
		const chunkSize = Math.ceil(listing.length / 3);
		const recorder = recordingExec([
			{
				exitCode: 0,
				stdoutChunks: [0, 1, 2].map((n) => listing.slice(n * chunkSize, (n + 1) * chunkSize)),
				stdoutTail: "ONLY-A-TAIL",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readdir("/g/big");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.length).toBe(names.length);
			expect(result.value[0]).toBe("entry-00000");
			expect(result.value[names.length - 1]).toBe(`entry-${String(names.length - 1).padStart(5, "0")}`);
		}
	});

	it("a non-zero guest exit errs (EACCES-shaped when the guest says so)", async () => {
		const recorder = recordingExec([
			{
				exitCode: 2,
				stderrChunks: ["ls: cannot open directory '/g/d': Permission denied\n"],
				stderrTail: "ls: cannot open directory '/g/d': Permission denied\n",
			},
		]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.readdir("/g/d");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toContain("Permission denied");
			expect(errnoCode(result.error)).toBe("EACCES");
		}
	});
});

// ------------------------------------------------------- mkdir / exists / access ----

describe("mkdir, exists, access", () => {
	it("mkdir: rc 0 is ok, rc 1 errs with the guest's words", async () => {
		const okRecorder = recordingExec([{ exitCode: 0 }]);
		const okFs = createSshFs(TARGET, { exec: okRecorder.exec });
		expect((await okFs.mkdir("/g/a/b/c")).ok).toBe(true);

		const errRecorder = recordingExec([
			{ exitCode: 1, stderrTail: "mkdir: cannot create directory '/g/f.txt/x': Not a directory\n" },
		]);
		const errFs = createSshFs(TARGET, { exec: errRecorder.exec });
		const result = await errFs.mkdir("/g/f.txt/x");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(errnoCode(result.error)).toBe("ENOTDIR");
	});

	it("exists: rc 0 → true, rc 1 → false, anything else (255 = connection death) errs", async () => {
		const yes = createSshFs(TARGET, { exec: recordingExec([{ exitCode: 0 }]).exec });
		expect(unwrap(await yes.exists("/g/f.txt"))).toBe(true);

		const no = createSshFs(TARGET, { exec: recordingExec([{ exitCode: 1 }]).exec });
		expect(unwrap(await no.exists("/g/f.txt"))).toBe(false);

		const dead = createSshFs(TARGET, {
			exec: recordingExec([{ exitCode: 255, stderrTail: "ssh: connect to host" }]).exec,
		});
		const result = await dead.exists("/g/f.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("guest exited 255");
	});

	it("access: rc 0 is ok and costs exactly ONE exec (the happy path never disambiguates)", async () => {
		const recorder = recordingExec([{ exitCode: 0 }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		expect((await fs.access("/g/f.txt")).ok).toBe(true);
		expect(recorder.calls.length).toBe(1);
	});

	it("access: rc 1 + exists → EACCES, in node's exact message shape", async () => {
		const recorder = recordingExec([{ exitCode: 1 }, { exitCode: 0 }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.access("/g/locked.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("EACCES: permission denied, access '/g/locked.txt'");
			expect(errnoCode(result.error)).toBe("EACCES");
		}
		expect(recorder.calls.map((call) => call.remoteArgv)).toEqual([
			["test", "-r", "/g/locked.txt"],
			["test", "-e", "/g/locked.txt"],
		]);
	});

	it("access: rc 1 + missing → ENOENT (the follow-up test -e restores node's split)", async () => {
		const recorder = recordingExec([{ exitCode: 1 }, { exitCode: 1 }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.access("/g/gone.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.message).toBe("ENOENT: no such file or directory, access '/g/gone.txt'");
			expect(errnoCode(result.error)).toBe("ENOENT");
		}
	});

	it("access: rc 1 + connection death on the follow-up errs with the transport's words", async () => {
		const recorder = recordingExec([{ exitCode: 1 }, { exitCode: 255, stderrTail: "" }]);
		const fs = createSshFs(TARGET, { exec: recorder.exec });
		const result = await fs.access("/g/f.txt");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.message).toContain("guest exited 255");
	});
});

// ------------------------------------------- the hostile-input hard gate (spec 25) ----

describe("hostile-input round-trips (spec 25 hard gate: ssh's quoting is verified, not trusted)", () => {
	itEcho("every non-test op's path operand arrives VERBATIM through a real POSIX sh parse", async () => {
		const stubDir = writeEchoStubs();
		const sandbox = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-hostile-"));
		// test is a shell BUILTIN — the PATH stub cannot see it — so its ops are gated in the
		// semantic test below; every other op's guest binary is an external binary the stub
		// intercepts.
		const ops: Array<[string, (fs: FsBackend, path: string) => Promise<unknown>]> = [
			["readFile", (fs, path) => fs.readFile(path)],
			["writeFile", (fs, path) => fs.writeFile(path, Buffer.from("payload"))],
			["stat", (fs, path) => fs.stat(path)],
			["readdir", (fs, path) => fs.readdir(path)],
			["mkdir", (fs, path) => fs.mkdir(path)],
		];
		for (const [opName, invoke] of ops) {
			for (const name of HOSTILE_NAMES) {
				const path = join(sandbox, name);
				// The REAL argv + REAL join for this op — the exact string sshExec ships and
				// the guest's sshd hands to `sh -c`; evaluate it with the host's real sh.
				const { remoteArgv, joined } = await joinedCommandFor(invoke, path);
				const { code, stdout } = await capture("/bin/sh", ["-c", joined], {
					env: { PATH: `${stubDir}:${process.env.PATH ?? ""}` },
				});
				expect(code, `${opName} / ${name}: stub parse exit`).toBe(0);
				const echoed = stdout
					.toString("utf8")
					.split("\n")
					.filter((line) => line !== "")
					.map((line) => Buffer.from(line, "base64"));
				// The stub saw everything after argv[0] — flags AND the hostile path — byte-exact.
				const operands = remoteArgv.slice(1).map((operand) => Buffer.from(operand, "utf8"));
				expect(echoed.length, `${opName} / ${name}: operand count`).toBe(operands.length);
				for (const [i, operand] of operands.entries()) {
					expect(echoed[i]?.equals(operand), `${opName} / ${name}: operand ${i} verbatim`).toBe(true);
				}
			}
		}
		rmSync(sandbox, { recursive: true, force: true });
		rmSync(stubDir, { recursive: true, force: true });
	});

	itSh(
		"exists/access paths arrive verbatim — semantic proof (test is a builtin; the stub cannot see it)",
		async () => {
			const sandbox = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-semantic-"));
			// `test -e X` exits 0 ONLY when X arrived as ONE intact word naming an existing path:
			// a split or re-evaluated operand changes the arg count or the parse (rc 2, or a
			// parse error) — never 0. The pwned canary catches re-evaluation directly.
			const names = [...HOSTILE_NAMES, "$(touch pwned).txt"];
			for (const name of names) {
				writeFileSync(join(sandbox, name), "x");
			}
			const ops: Array<[string, (fs: FsBackend, path: string) => Promise<unknown>]> = [
				["exists", (fs, path) => fs.exists(path)],
				["access", (fs, path) => fs.access(path)],
			];
			for (const [opName, invoke] of ops) {
				for (const name of names) {
					const path = join(sandbox, name);
					const presentCommand = await joinedCommandFor(invoke, path);
					const present = await capture("/bin/sh", ["-c", presentCommand.joined], {
						cwd: sandbox,
					});
					expect(present.code, `${opName} / ${name}: existing hostile path exits 0`).toBe(0);
					const absentCommand = await joinedCommandFor(invoke, `${path}.absent`);
					const absent = await capture("/bin/sh", ["-c", absentCommand.joined], {
						cwd: sandbox,
					});
					expect(absent.code, `${opName} / ${name}: missing path exits 1`).toBe(1);
				}
			}
			// Nothing was ever re-evaluated: the command substitution inside the filename never ran.
			expect(existsSync(join(sandbox, "pwned"))).toBe(false);
			rmSync(sandbox, { recursive: true, force: true });
		},
	);

	itLocalSsh("writeFile delivers every byte value 0-255 verbatim through the base64 stdin path", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-data-"));
		const data = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
		const path = join(dir, "all-byte-values.bin");
		const fs = createSshFs(TARGET, { exec: localSshExec() });
		const result = await fs.writeFile(path, data);
		if (!result.ok) throw result.error;
		expect(readFileSync(path).equals(data)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	itLocalSsh("readFile returns hostile-named binary content byte-exact through the real chain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-read-"));
		const data = Buffer.from(Array.from({ length: 256 }, (_, byte) => byte));
		const path = join(dir, "new\nline 'q' \"d\" $(x) `t`.bin");
		writeFileSync(path, data);
		const fs = createSshFs(TARGET, { exec: localSshExec() });
		const result = await fs.readFile(path);
		if (!result.ok) throw result.error;
		expect(result.value.equals(data)).toBe(true);
		rmSync(dir, { recursive: true, force: true });
	});

	itLocalSsh("the full op set round-trips real files through the real quoting chain", async () => {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-fs-ssh-full-"));
		const fs = createSshFs(TARGET, { exec: localSshExec() });
		const hostileDir = join(dir, "dir 'q' & $(sub)");
		const hostileFile = join(dir, "back`tick`.txt");
		const data = Buffer.from("round trip\nbytes éè\n\x00\x01\xff", "utf8");

		unwrap(await fs.mkdir(hostileDir));
		unwrap(await fs.writeFile(join(hostileDir, "in;side $.txt"), data));
		unwrap(await fs.writeFile(join(hostileDir, ".hidden"), Buffer.from("dot")));
		unwrap(await fs.writeFile(hostileFile, data));

		const listing = unwrap(await fs.readdir(hostileDir)).sort();
		expect(listing).toEqual([".hidden", "in;side $.txt"].sort());

		const readFileResult = await fs.readFile(hostileFile);
		if (!readFileResult.ok) throw readFileResult.error;
		expect(readFileResult.value.equals(data)).toBe(true);

		const fileStat = unwrap(await fs.stat(hostileFile));
		expect(fileStat.isFile).toBe(true);
		expect(fileStat.isDir).toBe(false);
		expect(fileStat.size).toBe(data.length);
		expect(Number.isFinite(fileStat.mtimeMs)).toBe(true);

		const dirStat = unwrap(await fs.stat(hostileDir));
		expect(dirStat.isDir).toBe(true);
		expect(dirStat.isFile).toBe(false);

		expect(unwrap(await fs.exists(hostileFile))).toBe(true);
		expect(unwrap(await fs.exists(join(dir, "missing")))).toBe(false);
		expect((await fs.access(hostileFile)).ok).toBe(true);

		const missingRead = await fs.readFile(join(dir, "no such 'thing'"));
		expect(missingRead.ok).toBe(false);
		if (!missingRead.ok) expect(errnoCode(missingRead.error)).toBe("ENOENT");
		const missingStat = await fs.stat(join(dir, "no such 'thing'"));
		expect(missingStat.ok).toBe(false);
		if (!missingStat.ok) expect(errnoCode(missingStat.error)).toBe("ENOENT");

		rmSync(dir, { recursive: true, force: true });
	});
});
