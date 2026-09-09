import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CAPTURE_CAP_BYTES,
	type CaptureDeps,
	capKeepEnd,
	captureOnTeardown,
	createExchangeRing,
	QMP_RING_LINES,
	writeDebugCapture,
} from "./capture.ts";

/** A fresh scratch dir per test — every capture lands inside it; nothing real is touched. */
function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "openhammer-capture-"));
}

function mode(path: string): number {
	return statSync(path).mode & 0o777;
}

describe("capKeepEnd", () => {
	it("is a no-op at or under the cap (exact bytes, not truncated)", () => {
		const under = capKeepEnd("hello\n", 64);
		expect(under.truncated).toBe(false);
		expect(under.data.toString("utf8")).toBe("hello\n");
		const exact = capKeepEnd("abcdef", 6);
		expect(exact.truncated).toBe(false);
		expect(exact.data.toString("utf8")).toBe("abcdef");
	});

	it("keeps the END byte-exactly when over cap and no newline follows the cut", () => {
		const capped = capKeepEnd("abcdefghij", 4);
		expect(capped.truncated).toBe(true);
		expect(capped.data.toString("utf8")).toBe("ghij");
	});

	it("aligns a mid-line cut down to the next line boundary at/after the cut (still ≤ cap)", () => {
		// 18 bytes: "LINE1\nLINE2\nLINE3\n" — a 9-byte cap cuts at byte 9, mid-LINE2.
		const capped = capKeepEnd("LINE1\nLINE2\nLINE3\n", 9);
		expect(capped.truncated).toBe(true);
		// The window slides to byte 12 (just past LINE2's newline): LINE3 whole, 6 bytes ≤ 9.
		expect(capped.data.toString("utf8")).toBe("LINE3\n");
	});

	it("also advances past a newline the cut lands exactly ON (no empty leading line)", () => {
		// 12 bytes, 7-byte cap: the cut at byte 5 is LINE1's own newline — start moves to 6.
		const capped = capKeepEnd("LINE1\nLINE2\n", 7);
		expect(capped.data.toString("utf8")).toBe("LINE2\n");
		expect(capped.truncated).toBe(true);
	});

	it("can empty out when no whole line fits the window (whole lines, never over cap)", () => {
		// 8 bytes "AAAA\nBB\n", 3-byte cap: the window is mid-BB; the only newline below the
		// cut ends BB, so the next whole line starts past the buffer's end.
		const capped = capKeepEnd("AAAA\nBB\n", 3);
		expect(capped.truncated).toBe(true);
		expect(capped.data.byteLength).toBe(0);
	});

	it("cuts at the raw byte when nothing after the cut has a newline (one giant line)", () => {
		const capped = capKeepEnd("x".repeat(5000), 100);
		expect(capped.truncated).toBe(true);
		expect(capped.data.byteLength).toBe(100);
		expect(capped.data.toString("utf8")).toBe("x".repeat(100));
	});

	it("is byte-oriented by design: a cut inside a multi-byte UTF-8 sequence keeps exactly the cap bytes", () => {
		// é is 2 bytes; 100 of them = 200 bytes. A 51-byte cap cuts one byte into a char —
		// documented behavior (serial/QMP are byte streams): the orphan byte decodes U+FFFD.
		const capped = capKeepEnd("é".repeat(100), 51);
		expect(capped.truncated).toBe(true);
		expect(capped.data.byteLength).toBe(51);
		const text = capped.data.toString("utf8");
		expect(text.charCodeAt(0)).toBe(0xfffd); // the split code point
		expect(text.slice(1)).toBe("é".repeat(25)); // 51 = 1 orphan byte + 25 whole chars
	});

	it("takes Buffers too (the write path hands Buffers around)", () => {
		const capped = capKeepEnd(Buffer.from("LINE1\nLINE2\n"), 7);
		expect(capped.data.toString("utf8")).toBe("LINE2\n");
		expect(capped.truncated).toBe(true);
	});
});

describe("writeDebugCapture", () => {
	it("writes all three sources with manifest fields; files 0600, missing debug dir created 0700", async () => {
		const home = tempDir();
		const serialPath = join(home, "serial.log");
		writeFileSync(serialPath, "boot ok\nssh ready\n");
		const stderrTail = "qemu-system-x86_64: terminating on signal 15\n";
		const qmpLines = ['{"execute":"quit","arguments":{},"id":9}', '{"return": {}, "id": 9}'];
		const debugDir = join(home, "s1", "debug"); // does not exist yet

		const result = await writeDebugCapture(debugDir, {
			serialLogPath: serialPath,
			qemuStderrTail: stderrTail,
			qmpExchanges: qmpLines,
		});

		expect(result).toEqual({
			dir: debugDir,
			files: [
				{ name: "serial-tail.log", bytes: 18, truncated: false },
				{ name: "qemu-stderr.log", bytes: Buffer.byteLength(stderrTail), truncated: false },
				{ name: "qmp-last.jsonl", bytes: Buffer.byteLength(`${qmpLines.join("\n")}\n`), truncated: false },
			],
		});
		expect(readFileSync(join(debugDir, "serial-tail.log"), "utf8")).toBe("boot ok\nssh ready\n");
		expect(readFileSync(join(debugDir, "qemu-stderr.log"), "utf8")).toBe(stderrTail);
		expect(readFileSync(join(debugDir, "qmp-last.jsonl"), "utf8")).toBe(`${qmpLines.join("\n")}\n`);
		expect(mode(join(debugDir, "serial-tail.log"))).toBe(0o600);
		expect(mode(debugDir)).toBe(0o700);
	});

	it("skips absent, empty, and missing sources — the manifest shows only what was captured", async () => {
		const home = tempDir();
		const emptySerial = join(home, "serial.log");
		writeFileSync(emptySerial, ""); // exists but zero bytes → skipped
		const result = await writeDebugCapture(join(home, "debug"), {
			serialLogPath: emptySerial,
			qemuStderrTail: "", // empty tail → skipped
			qmpExchanges: [], // no exchanges → skipped
		});
		expect(result.files).toEqual([]);
		expect(readdirSync(join(home, "debug"))).toEqual([]);

		const missingSerial = await writeDebugCapture(join(home, "debug2"), {
			serialLogPath: join(home, "nope.log"), // never written (boot died before QEMU)
		});
		expect(missingSerial.files).toEqual([]);
	});

	it("skips an unreadable serial file without rejecting (the other sources still captured)", async () => {
		const home = tempDir();
		const serialPath = join(home, "serial.log");
		writeFileSync(serialPath, "bytes\n");
		const failing: CaptureDeps = { readTail: () => Promise.reject(new Error("EACCES: permission denied")) };
		const result = await writeDebugCapture(
			join(home, "debug"),
			{ serialLogPath: serialPath, qemuStderrTail: "kept\n" },
			failing,
		);
		expect(result.files).toEqual([{ name: "qemu-stderr.log", bytes: 5, truncated: false }]);
		expect(readFileSync(join(result.dir, "qemu-stderr.log"), "utf8")).toBe("kept\n");
	});

	it("truncates a >1 MiB serial log keep-end, whole-line aligned, truncated: true", async () => {
		const home = tempDir();
		const serialPath = join(home, "serial.log");
		// 300-byte lines (all-ASCII), 4000 of them = 1,200,000 bytes > the 1,048,576 cap.
		// The cap boundary lands 224 bytes into line 504 → alignment starts at line 505.
		const lineAt = (i: number): string => `${String(i).padStart(6, "0")}${"x".repeat(293)}\n`;
		writeFileSync(serialPath, Array.from({ length: 4000 }, (_, i) => lineAt(i)).join(""));

		const result = await writeDebugCapture(join(home, "debug"), { serialLogPath: serialPath });

		const expectedBytes = (4000 - 505) * 300;
		expect(expectedBytes).toBeLessThanOrEqual(CAPTURE_CAP_BYTES);
		expect(result.files).toEqual([{ name: "serial-tail.log", bytes: expectedBytes, truncated: true }]);
		const text = readFileSync(join(result.dir, "serial-tail.log"), "utf8");
		expect(text.length).toBe(expectedBytes);
		expect(text.startsWith(lineAt(505))).toBe(true);
		expect(text.endsWith(lineAt(3999))).toBe(true);
	});
});

describe("captureOnTeardown — the thin composition", () => {
	it("reads serial from the paths, stderr from the handle, QMP from the snapshot", async () => {
		const home = tempDir();
		const serialPath = join(home, "serial.log");
		writeFileSync(serialPath, "serial line\n");
		const result = await captureOnTeardown(
			{ serialPath, debugDir: join(home, "s1", "debug") },
			{ stderrTail: () => Promise.resolve("stderr line\n") },
			["one", "two"],
		);
		expect(result.files.map((file) => file.name)).toEqual(["serial-tail.log", "qemu-stderr.log", "qmp-last.jsonl"]);
		expect(readFileSync(join(result.dir, "serial-tail.log"), "utf8")).toBe("serial line\n");
		expect(readFileSync(join(result.dir, "qmp-last.jsonl"), "utf8")).toBe("one\ntwo\n");
	});

	it("no handle → no stderr file; absent sources stay skipped", async () => {
		const home = tempDir();
		const result = await captureOnTeardown({ serialPath: join(home, "missing.log"), debugDir: join(home, "debug") });
		expect(result.files).toEqual([]);
	});
});

describe("createExchangeRing", () => {
	it("keeps the last `capacity` lines, in wire order", () => {
		const ring = createExchangeRing(3);
		for (const line of ["greeting", "cmd-1", "reply-1", "cmd-2", "reply-2"]) {
			ring.onExchange(line);
		}
		expect(ring.lines()).toEqual(["reply-1", "cmd-2", "reply-2"]);
	});

	it("defaults to the published QMP_RING_LINES capacity", () => {
		expect(QMP_RING_LINES).toBe(200);
		const ring = createExchangeRing();
		for (let i = 0; i < QMP_RING_LINES + 10; i++) {
			ring.onExchange(String(i));
		}
		const lines = ring.lines();
		expect(lines).toHaveLength(QMP_RING_LINES);
		expect(lines[0]).toBe("10");
		expect(lines.at(-1)).toBe(String(QMP_RING_LINES + 9));
	});

	it("snapshots: pushes after lines() do not mutate the taken array", () => {
		const ring = createExchangeRing(2);
		ring.onExchange("a");
		const snapshot = ring.lines();
		ring.onExchange("b");
		expect(snapshot).toEqual(["a"]);
		expect(ring.lines()).toEqual(["a", "b"]);
	});
});
