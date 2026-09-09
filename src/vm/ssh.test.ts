import { spawn as realSpawn } from "node:child_process";
import { chmodSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	remoteQuote,
	SSH_BIN,
	SSH_CONNECT_TIMEOUT_SEC,
	SSH_CONTROL_PERSIST_SEC,
	SSH_TAIL_BYTES,
	type SshChild,
	type SshDeps,
	type SshTarget,
	sshBaseArgv,
	sshCloseMux,
	sshExec,
	sshExecArgv,
	sshTargetForPort,
} from "./ssh.ts";

// The sample session target: spec-22's measured port, the session.ts per-session pin/socket
// paths, and the host-minted key. Paths are plain absolute strings — the builders must treat
// them opaquely (the qemu args.test.ts precedent).
const TARGET: SshTarget = {
	user: "sandbox",
	host: "127.0.0.1",
	port: 41733,
	keyPath: "/vm/secrets/id_ed25519",
	knownHostsPath: "/vm/sessions/s1/known_hosts",
	controlPath: "/vm/sessions/s1/cm.sock",
};

const PERSIST_TARGET: SshTarget = { ...TARGET, controlPersistSec: 90 };

const BASE_ARGV = [
	"ssh",
	"-F",
	"/dev/null",
	"-o",
	"BatchMode=yes",
	"-o",
	"StrictHostKeyChecking=yes",
	"-o",
	"UserKnownHostsFile=/vm/sessions/s1/known_hosts",
	"-o",
	"GlobalKnownHostsFile=/dev/null",
	"-o",
	"IdentityFile=/vm/secrets/id_ed25519",
	"-o",
	"IdentitiesOnly=yes",
	"-o",
	"ConnectTimeout=10",
	"-o",
	"ControlMaster=auto",
	"-o",
	"ControlPath=/vm/sessions/s1/cm.sock",
	"-o",
	"ControlPersist=600",
	"-p",
	"41733",
];

// Real-exec tests need a POSIX sh (both for the stub's shebang and the quoting round-trip);
// skip — not fail — on hosts without one.
const shExists = statSync("/bin/sh", { throwIfNoEntry: false }) !== undefined;
const itSh = shExists ? it : it.skip;

/** A child stand-in: records stdin, emits scripted stdio/close/error — the QemuChild-test trick. */
interface FakeSshChild extends SshChild {
	readonly stdinWrites: string[];
	readonly stdinEnded: boolean;
	emitStdout(text: string): void;
	emitStderr(text: string): void;
	emitClose(code: number | null, signal: string | null): void;
	emitError(message: string): void;
}

function fakeSshChild(): FakeSshChild {
	const stdoutListeners: Array<(chunk: Buffer) => void> = [];
	const stderrListeners: Array<(chunk: Buffer) => void> = [];
	const closeListeners: Array<(code: number | null, signal: string | null) => void> = [];
	const errorListeners: Array<(error: Error) => void> = [];
	const stdinErrorListeners: Array<(error: Error) => void> = [];
	const stdinWrites: string[] = [];
	let stdinEnded = false;
	const child: FakeSshChild = {
		// The single-cast implementor of the overloaded `on`: TS cannot correlate the `event`
		// union with the matching listener union, so each branch narrows by hand.
		on(event: "close" | "error", listener: (...args: never[]) => void): unknown {
			if (event === "close") {
				closeListeners.push(listener as (code: number | null, signal: string | null) => void);
			} else {
				errorListeners.push(listener as (error: Error) => void);
			}
			return undefined;
		},
		stdin: {
			write(chunk: string): boolean {
				stdinWrites.push(chunk);
				return true;
			},
			end(): void {
				stdinEnded = true;
			},
			on(_event: "error", listener: (error: Error) => void): unknown {
				// sshExec registers an EPIPE absorber here; the fake's stdin never errors,
				// so the listener is recorded and never fired.
				stdinErrorListeners.push(listener);
				return undefined;
			},
		},
		stdout: {
			on(_event: "data", listener: (chunk: Buffer) => void): unknown {
				stdoutListeners.push(listener);
				return undefined;
			},
		},
		stderr: {
			on(_event: "data", listener: (chunk: Buffer) => void): unknown {
				stderrListeners.push(listener);
				return undefined;
			},
		},
		stdinWrites,
		get stdinEnded(): boolean {
			return stdinEnded;
		},
		emitStdout(text: string): void {
			for (const listener of [...stdoutListeners]) listener(Buffer.from(text, "utf8"));
		},
		emitStderr(text: string): void {
			for (const listener of [...stderrListeners]) listener(Buffer.from(text, "utf8"));
		},
		emitClose(code: number | null, signal: string | null): void {
			for (const listener of [...closeListeners]) listener(code, signal);
		},
		emitError(message: string): void {
			for (const listener of [...errorListeners]) listener(new Error(message));
		},
	};
	return child;
}

/** A deps.spawn that records every (bin, args) and always hands back the given child. */
function recordingSpawn(child: SshChild): SshDeps & { calls: Array<{ bin: string; args: string[] }> } {
	const calls: Array<{ bin: string; args: string[] }> = [];
	return {
		calls,
		spawn: (bin: string, args: readonly string[]): SshChild => {
			calls.push({ bin, args: [...args] });
			return child;
		},
	};
}

/** Spawn a real process and capture code + stdout — the test-side mini-runner for the sh round-trips. */
function capture(bin: string, args: readonly string[]): Promise<{ code: number | null; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = realSpawn(bin, [...args], { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", (error: Error) => reject(error));
		child.on("close", (code) => resolve({ code, stdout }));
	});
}

describe("sshBaseArgv", () => {
	it("is the exact pinned-option prefix (golden)", () => {
		expect(sshBaseArgv(TARGET)).toEqual(BASE_ARGV);
	});

	it("controlPersistSec overrides the ControlPersist default, nothing else moves", () => {
		const argv = sshBaseArgv(PERSIST_TARGET);
		expect(argv).toHaveLength(BASE_ARGV.length);
		expect(argv[argv.indexOf("ControlPersist=90") - 1]).toBe("-o");
		expect(argv).not.toContain(`ControlPersist=${SSH_CONTROL_PERSIST_SEC}`);
	});
});

describe("sshExecArgv", () => {
	it("is base + -- + destination + the ONE pre-joined, per-argument-quoted command (golden)", () => {
		expect(sshExecArgv(TARGET, ["ls", "-1", "my file.txt"])).toEqual([
			...BASE_ARGV,
			"--",
			"sandbox@127.0.0.1",
			"'ls' '-1' 'my file.txt'",
		]);
	});

	it("hostile elements are quoted words in the join, never interpolated", () => {
		expect(sshExecArgv(TARGET, ["printf", "%s", "it's $(x) `y`", "-flag", ""])).toEqual([
			...BASE_ARGV,
			"--",
			"sandbox@127.0.0.1",
			`'printf' '%s' 'it'\\''s $(x) \`y\`' '-flag' ''`,
		]);
	});

	it("throws on an empty remoteArgv (a silent remote no-op is a bug, not a command)", () => {
		expect(() => sshExecArgv(TARGET, [])).toThrow(
			"sshExecArgv: remoteArgv must have at least one element (the guest binary)",
		);
	});
});

describe("sshTargetForPort", () => {
	it("completes a port-less target with the discovered port and moves nothing else", () => {
		// 25d's join: the session's own facts arrive without a port (it does not exist yet);
		// the discovered number is the only thing that fills the gap.
		const base: Omit<SshTarget, "port"> = {
			user: "sandbox",
			host: "127.0.0.1",
			keyPath: "/vm/secrets/id_ed25519",
			knownHostsPath: "/vm/sessions/s1/known_hosts",
			controlPath: "/vm/sessions/s1/cm.sock",
		};
		expect(sshTargetForPort(base, 40199)).toEqual({ ...base, port: 40199 });
		// The completed target is a first-class SshTarget — the builders accept it as-is.
		expect(sshExecArgv(sshTargetForPort(base, 40199), ["true"])).toContain("-p");
		expect(sshExecArgv(sshTargetForPort(base, 40199), ["true"])).toContain("40199");
	});
});

describe("remoteQuote", () => {
	it("is the POSIX single-quote escaper — hostile-shape table", () => {
		const cases: Array<[string, string]> = [
			["ls", "'ls'"],
			["my file.txt", "'my file.txt'"],
			["it's", `'it'\\''s'`],
			['say "hi"', `'say "hi"'`],
			["$(rm -rf /)", `'$(rm -rf /)'`],
			["back`tick`", "'back`tick`'"],
			["line1\nline2", "'line1\nline2'"],
			["-leading-dash", "'-leading-dash'"],
			["", "''"],
			["héllo→世界", "'héllo→世界'"],
			["a'b\"c$(d)e`f`g\nh", `'a'\\''b"c$(d)e\`f\`g\nh'`],
		];
		for (const [input, expected] of cases) {
			expect(remoteQuote(input)).toBe(expected);
		}
	});

	itSh("round-trips hostile arguments verbatim through a REAL POSIX shell", async () => {
		const hostile = [
			"plain",
			"two  spaces",
			"it's",
			'say "hi"',
			"$(rm -rf /)",
			"back`tick`",
			"line1\nline2",
			"-leading-dash",
			"",
			"héllo→世界",
			"a'b\"c$(d)e`f`g\nh",
		];
		// Exactly what the remote shell would receive: ssh ships the joined quoted words as
		// one string to `sh -c` — model that join and evaluate it with the host's real sh.
		const commandString = ["printf", "%s\n", ...hostile].map(remoteQuote).join(" ");
		const { code, stdout } = await capture("/bin/sh", ["-c", commandString]);
		expect(code).toBe(0);
		// printf '%s\n' per argument == [args].join("\n") + "\n", embedded newlines included.
		expect(stdout).toBe(`${hostile.join("\n")}\n`);
	});
});

describe("argv invariants (every builder)", () => {
	const execArgv = sshExecArgv(TARGET, ["true"]);
	const hostileArgv = sshExecArgv(TARGET, ["bash", "-c", "echo hi"]);
	const overrideArgv = sshExecArgv(PERSIST_TARGET, ["true"]);
	const allArgv = [
		["base", sshBaseArgv(TARGET)],
		["base-override", sshBaseArgv(PERSIST_TARGET)],
		["exec", execArgv],
		["exec-hostile", hostileArgv],
		["exec-override", overrideArgv],
	] as const;

	it("returns argv arrays — every element a non-empty string, never a shell command line", () => {
		for (const [, argv] of allArgv) {
			expect(Array.isArray(argv)).toBe(true);
			for (const arg of argv) {
				expect(typeof arg).toBe("string");
				expect(arg.length).toBeGreaterThan(0);
			}
		}
	});

	it("pins the host key in every argv: strict checking, per-session known_hosts, no global file", () => {
		for (const [, argv] of allArgv) {
			expect(argv).toContain("StrictHostKeyChecking=yes");
			expect(argv).toContain(`UserKnownHostsFile=${TARGET.knownHostsPath}`);
			expect(argv).toContain("GlobalKnownHostsFile=/dev/null");
		}
	});

	it("reads no ssh config: -F /dev/null rides every argv (the argv is the whole truth)", () => {
		for (const [, argv] of allArgv) {
			const fFlag = argv.indexOf("-F");
			expect(fFlag).toBeGreaterThan(-1);
			expect(argv[fFlag + 1]).toBe("/dev/null");
		}
	});

	it("pins the identity in every argv: one IdentityFile + IdentitiesOnly, never a duplicate -i", () => {
		for (const [, argv] of allArgv) {
			expect(argv).toContain(`IdentityFile=${TARGET.keyPath}`);
			expect(argv).toContain("IdentitiesOnly=yes");
			expect(argv.filter((arg) => arg === "-i")).toEqual([]);
		}
	});

	it("muxes every argv: ControlMaster=auto + ControlPath + ControlPersist (the override where given)", () => {
		for (const [name, argv] of allArgv) {
			expect(argv).toContain("ControlMaster=auto");
			expect(argv).toContain(`ControlPath=${TARGET.controlPath}`);
			const persist = name.endsWith("override") ? "ControlPersist=90" : `ControlPersist=${SSH_CONTROL_PERSIST_SEC}`;
			expect(argv).toContain(persist);
		}
	});

	it("never prompts and bounds the fresh connect: BatchMode=yes + ConnectTimeout", () => {
		for (const [, argv] of allArgv) {
			expect(argv).toContain("BatchMode=yes");
			expect(argv).toContain(`ConnectTimeout=${SSH_CONNECT_TIMEOUT_SEC}`);
		}
	});

	it("sets no option twice: every -o key appears at most once; -p and -- each at most once", () => {
		for (const [, argv] of allArgv) {
			const optionKeys: string[] = [];
			for (let i = 0; i < argv.length; i++) {
				if (argv[i] === "-o") {
					i += 1;
					const value = argv[i] ?? "";
					optionKeys.push(value.split("=")[0] ?? "");
				}
			}
			expect(new Set(optionKeys).size).toBe(optionKeys.length);
			expect(argv.filter((arg) => arg === "-p")).toEqual(["-p"]);
			const guards = argv.filter((arg) => arg === "--");
			expect(guards.length === 0 || guards.length === 1).toBe(true);
		}
	});

	it("loopback-only transport: the destination is <user>@127.0.0.1, right after --", () => {
		for (const argv of [execArgv, hostileArgv]) {
			expect(argv[argv.indexOf("--") + 1]).toBe("sandbox@127.0.0.1");
			// Exactly ONE element after the destination: the pre-joined command.
			expect(argv[argv.length - 2]).toBe("sandbox@127.0.0.1");
		}
	});
});

describe("sshExec (fake spawn)", () => {
	it("spawns exactly sshExecArgv — the golden argv IS the spawned argv", async () => {
		const child = fakeSshChild();
		const recorder = recordingSpawn(child);
		const pending = sshExec(TARGET, ["printf", "out"], {}, recorder);
		child.emitClose(0, null);
		await pending;
		expect(recorder.calls).toEqual([{ bin: SSH_BIN, args: sshExecArgv(TARGET, ["printf", "out"]).slice(1) }]);
	});

	it("splits the pipes: own callbacks, own tails, exit 0 resolves", async () => {
		const child = fakeSshChild();
		const stdoutSeen: string[] = [];
		const stderrSeen: string[] = [];
		const pending = sshExec(
			TARGET,
			["cat"],
			{
				onStdout: (chunk) => stdoutSeen.push(chunk.toString("utf8")),
				onStderr: (chunk) => stderrSeen.push(chunk.toString("utf8")),
			},
			recordingSpawn(child),
		);
		child.emitStdout("OUT-1");
		child.emitStderr("ERR-1");
		child.emitStdout("OUT-2");
		child.emitClose(0, null);
		const result = await pending;
		expect(stdoutSeen).toEqual(["OUT-1", "OUT-2"]);
		expect(stderrSeen).toEqual(["ERR-1"]);
		expect(result).toEqual({
			exitCode: 0,
			timedOut: false,
			stdoutTail: "OUT-1OUT-2",
			stderrTail: "ERR-1",
		});
	});

	it("onChunk sees BOTH pipes in arrival order (the merged-stream contract)", async () => {
		const child = fakeSshChild();
		const merged: string[] = [];
		const pending = sshExec(
			TARGET,
			["cat"],
			{ onChunk: (chunk) => merged.push(chunk.toString("utf8")) },
			recordingSpawn(child),
		);
		child.emitStdout("OUT-1");
		child.emitStderr("ERR-1");
		child.emitStdout("OUT-2");
		child.emitClose(0, null);
		await pending;
		expect(merged).toEqual(["OUT-1", "ERR-1", "OUT-2"]);
	});

	it("keeps only the last SSH_TAIL_BYTES per pipe", async () => {
		const child = fakeSshChild();
		const pending = sshExec(TARGET, ["cat"], {}, recordingSpawn(child));
		child.emitStdout(`${"a".repeat(5000)}STDOUT-END`);
		child.emitStderr(`${"b".repeat(5000)}STDERR-END`);
		child.emitClose(0, null);
		const result = await pending;
		expect(result.stdoutTail.length).toBe(SSH_TAIL_BYTES);
		expect(result.stdoutTail.endsWith("STDOUT-END")).toBe(true);
		expect(result.stderrTail.length).toBe(SSH_TAIL_BYTES);
		expect(result.stderrTail.endsWith("STDERR-END")).toBe(true);
	});

	it("writes stdin then EOFs it; with no stdin it still EOFs (never wait on host stdin)", async () => {
		const fed = fakeSshChild();
		const fedPending = sshExec(TARGET, ["base64", "-d"], { stdin: "aGVsbG8=" }, recordingSpawn(fed));
		fed.emitClose(0, null);
		await fedPending;
		expect(fed.stdinWrites).toEqual(["aGVsbG8="]);
		expect(fed.stdinEnded).toBe(true);

		const unfed = fakeSshChild();
		const unfedPending = sshExec(TARGET, ["true"], {}, recordingSpawn(unfed));
		unfed.emitClose(0, null);
		await unfedPending;
		expect(unfed.stdinWrites).toEqual([]);
		expect(unfed.stdinEnded).toBe(true);
	});

	it("maps exit codes: guest rc resolves as-is, signal death resolves -1, timedOut is always false", async () => {
		const killed = fakeSshChild();
		const killedPending = sshExec(TARGET, ["sleep", "1000"], { timeoutSec: 1 }, recordingSpawn(killed));
		killed.emitClose(null, "SIGKILL");
		await expect(killedPending).resolves.toEqual({
			exitCode: -1,
			timedOut: false,
			stdoutTail: "",
			stderrTail: "",
		});

		const guestFailure = fakeSshChild();
		const failurePending = sshExec(TARGET, ["grep", "x"], {}, recordingSpawn(guestFailure));
		guestFailure.emitClose(2, null);
		await expect(failurePending).resolves.toMatchObject({ exitCode: 2, timedOut: false });
	});

	it("rejects only on spawn error — and a late close cannot override the rejection", async () => {
		const child = fakeSshChild();
		const pending = sshExec(TARGET, ["true"], {}, recordingSpawn(child));
		child.emitError(`spawn ${SSH_BIN} ENOENT`);
		child.emitClose(0, null); // the settled guard must keep this moot
		await expect(pending).rejects.toThrow(`spawn ${SSH_BIN} ENOENT`);
	});
});

describe("sshCloseMux", () => {
	it("sends -O exit over the full pinned option set, destination after --, stdin EOF'd", async () => {
		const child = fakeSshChild();
		const recorder = recordingSpawn(child);
		const pending = sshCloseMux(TARGET, recorder);
		expect(recorder.calls).toHaveLength(1);
		const args = recorder.calls[0]?.args ?? [];
		expect(recorder.calls[0]?.bin).toBe(SSH_BIN);
		expect(args.slice(0, 2)).toEqual(["-O", "exit"]);
		expect(args[args.indexOf("--") + 1]).toBe("sandbox@127.0.0.1");
		expect(args.at(-1)).toBe("sandbox@127.0.0.1");
		for (const pinned of [
			"-F",
			"/dev/null",
			"BatchMode=yes",
			"StrictHostKeyChecking=yes",
			`UserKnownHostsFile=${TARGET.knownHostsPath}`,
			"GlobalKnownHostsFile=/dev/null",
			`IdentityFile=${TARGET.keyPath}`,
			"IdentitiesOnly=yes",
			"ControlMaster=auto",
			`ControlPath=${TARGET.controlPath}`,
			`ControlPersist=${SSH_CONTROL_PERSIST_SEC}`,
		]) {
			expect(args).toContain(pinned);
		}
		expect(child.stdinEnded).toBe(true);
		child.emitClose(0, null); // "Exit request sent."
		await expect(pending).resolves.toBe(true);
	});

	it("false when no master answers (rc 255) — fine at session close", async () => {
		const child = fakeSshChild();
		const pending = sshCloseMux(TARGET, recordingSpawn(child));
		child.emitClose(255, null);
		await expect(pending).resolves.toBe(false);
	});

	it("rejects on spawn error (the one genuine-throw path)", async () => {
		const child = fakeSshChild();
		const pending = sshCloseMux(TARGET, recordingSpawn(child));
		child.emitError(`spawn ${SSH_BIN} ENOENT`);
		await expect(pending).rejects.toThrow(`spawn ${SSH_BIN} ENOENT`);
	});
});

describe("sshExec against a real stub ssh (integration-lite)", () => {
	// The stub: prints each argv element NUL-terminated, then `cat`s stdin to stdout. The
	// `cat` terminates only at stdin EOF, so these tests prove the write-then-EOF discipline
	// end-to-end: without the end(), close would never fire.
	function writeStub(): string {
		const dir = mkdtempSync(join(tmpdir(), "openhammer-ssh-"));
		const path = join(dir, "argv-dump");
		writeFileSync(path, '#!/bin/sh\nprintf "%s\\0" "$@"\ncat\n');
		chmodSync(path, 0o755);
		return path;
	}

	itSh("the remote command is ONE argv element through a real exec — never re-split", async () => {
		const stub = writeStub();
		const result = await sshExec(
			TARGET,
			["ls", "-1", "my file.txt"],
			{},
			{
				spawn: (_bin, args) => realSpawn(stub, [...args]),
			},
		);
		expect(result.exitCode).toBe(0);
		expect(result.stderrTail).toBe("");
		const received = result.stdoutTail.split("\0").filter((element) => element !== "");
		expect(received).toEqual(sshExecArgv(TARGET, ["ls", "-1", "my file.txt"]).slice(1));
		expect(received.at(-1)).toBe("'ls' '-1' 'my file.txt'");
		// Exactly one element carries the joined command (spaces + quotes intact inside it).
		expect(received.filter((element) => element.includes(" "))).toEqual(["'ls' '-1' 'my file.txt'"]);
	});

	itSh("stdin is written and EOF'd — the stub's cat proves both", async () => {
		const stub = writeStub();
		const result = await sshExec(
			TARGET,
			["base64", "-d"],
			{ stdin: "PIPED-STDIN-MARKER" },
			{ spawn: (_bin, args) => realSpawn(stub, [...args]) },
		);
		expect(result.exitCode).toBe(0);
		// The argv dump first, then cat's echo — and only EOF lets cat finish at all.
		expect(result.stdoutTail.endsWith("PIPED-STDIN-MARKER")).toBe(true);
		expect(result.stdoutTail).toContain(`IdentityFile=${TARGET.keyPath}`);
	});
});

describe("published constants", () => {
	it("ships the measured/spec budgets", () => {
		expect(SSH_BIN).toBe("ssh");
		expect(SSH_CONNECT_TIMEOUT_SEC).toBe(10);
		expect(SSH_CONTROL_PERSIST_SEC).toBe(600);
		expect(SSH_TAIL_BYTES).toBe(4096);
	});

	// sshAvailable() is deliberately untested here: it runs the real binary's --version, so
	// its result depends on the host (the cloudflared/qemu precedent — those availability
	// probes are never spawned from tests either).
});
