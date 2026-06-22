import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OutputAccumulator } from "./output-accumulator.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "./truncate.ts";

// The accumulator may tee the full stream to a real temp file under the OS tmpdir.
// Track every path it hands back so no test leaks files into the CI sandbox.
const created: string[] = [];

afterEach(() => {
	for (const p of created.splice(0)) {
		rmSync(p, { force: true });
	}
});

/** Build `count` newline-joined lines "line 1".."line N" (no trailing newline). */
function lines(count: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("under the limits", () => {
	it("returns the full content unchanged with no temp file", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("hello\nworld"));
		const snap = acc.snapshot();
		expect(snap.truncation.truncated).toBe(false);
		expect(snap.content).toBe("hello\nworld");
		expect(snap.fullOutputPath).toBeUndefined();
	});
});

describe("over the line limit", () => {
	it("keeps the LAST 2000 lines and marks truncation by lines", () => {
		const acc = new OutputAccumulator();
		// 3000 short lines (~24KB) — under the byte limit, over the line limit.
		acc.append(Buffer.from(lines(3000)));
		const snap = acc.snapshot();
		// Crossing any limit tees the full stream to a temp file during append
		// (persistIfTruncated only adds an extra trigger at snapshot time) — so the
		// path is set even without it. Track it for cleanup.
		if (snap.fullOutputPath) created.push(snap.fullOutputPath);
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.truncation.totalLines).toBe(3000);
		expect(snap.content.endsWith("\nline 3000")).toBe(true);
		expect(snap.content).not.toContain("\nline 1000\n");
	});
});

describe("over the byte limit (>50KB)", () => {
	it("marks truncation by bytes and keeps a non-empty tail", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("x".repeat(60 * 1024)));
		const snap = acc.snapshot();
		if (snap.fullOutputPath) created.push(snap.fullOutputPath);
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.truncation.truncatedBy).toBe("bytes");
		expect(snap.truncation.totalBytes).toBe(60 * 1024);
		expect(Buffer.byteLength(snap.content, "utf-8")).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(snap.content.length).toBeGreaterThan(0);
	});

	it("persistIfTruncated tees the FULL output to a temp file (spec acceptance)", async () => {
		const payload = "x".repeat(60 * 1024);
		const acc = new OutputAccumulator();
		acc.append(Buffer.from(payload));
		const snap = acc.snapshot({ persistIfTruncated: true });
		expect(snap.truncation.truncated).toBe(true);
		expect(snap.fullOutputPath).toBeTruthy();
		const path = snap.fullOutputPath;
		if (!path) throw new Error("expected a persisted temp file path");
		created.push(path);

		// Flush the write stream before reading it back.
		await acc.closeTempFile();

		expect(existsSync(path)).toBe(true);
		expect(statSync(path).size).toBe(payload.length);
		expect(readFileSync(path, "utf-8")).toBe(payload);
	});
});

describe("tempFilePrefix", () => {
	it("defaults to the openhammer prefix (deliberate change from pi's pi-output)", async () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("y".repeat(60 * 1024)));
		const snap = acc.snapshot({ persistIfTruncated: true });
		const path = snap.fullOutputPath;
		expect(path).toBeTruthy();
		if (!path) throw new Error("unreachable");
		created.push(path);
		await acc.closeTempFile();
		expect(basename(path).startsWith("openhammer-")).toBe(true);
		expect(basename(path).endsWith(".log")).toBe(true);
	});

	it("honours an explicit prefix override", async () => {
		const acc = new OutputAccumulator({ tempFilePrefix: "oh-custom" });
		acc.append(Buffer.from("y".repeat(60 * 1024)));
		const snap = acc.snapshot({ persistIfTruncated: true });
		const path = snap.fullOutputPath;
		expect(path).toBeTruthy();
		if (!path) throw new Error("unreachable");
		created.push(path);
		await acc.closeTempFile();
		expect(basename(path).startsWith("oh-custom-")).toBe(true);
	});
});

describe("finish", () => {
	it("is idempotent and still resolves a snapshot", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("a\nb"));
		acc.finish();
		acc.finish(); // second call is a no-op
		const snap = acc.snapshot();
		expect(snap.content).toBe("a\nb");
		expect(snap.truncation.truncated).toBe(false);
	});

	it("replaces an incomplete trailing multi-byte sequence with U+FFFD on finish", () => {
		const acc = new OutputAccumulator();
		// 0xC3 is the lead byte of "é" (0xC3 0xA9); with no continuation byte
		// arriving, finish() flushes a genuinely truncated sequence → replacement.
		acc.append(Buffer.from([0xc3]));
		acc.finish();
		expect(acc.snapshot().content).toBe("�");
	});

	it("throws when append is called after finish", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("x"));
		acc.finish();
		expect(() => acc.append(Buffer.from("y"))).toThrowError(/finished/);
	});
});

describe("streaming UTF-8 across chunk boundaries", () => {
	it("reconstructs a multi-byte character split between two appends", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from([0xc3])); // lead byte of "é"
		acc.append(Buffer.from([0xa9])); // continuation byte
		acc.finish();
		expect(acc.snapshot().content).toBe("é");
	});
});

describe("getLastLineBytes", () => {
	it("tracks the byte length of the current (still-open) line", () => {
		const acc = new OutputAccumulator();
		acc.append(Buffer.from("hello\nworld")); // "world" is the open line → 5 bytes
		expect(acc.getLastLineBytes()).toBe(5);
		acc.append(Buffer.from("abc")); // extends the open line → 8 bytes
		expect(acc.getLastLineBytes()).toBe(8);
	});
});

// Sanity: the defaults mirror truncate.ts so the accumulator and the truncation
// helpers agree on the 2000-line / 50KB ceiling.
it("uses truncate.ts DEFAULT_MAX_LINES / DEFAULT_MAX_BYTES as its limits", () => {
	const acc = new OutputAccumulator();
	acc.append(Buffer.from(lines(DEFAULT_MAX_LINES))); // exactly at the line limit
	expect(acc.snapshot().truncation.truncated).toBe(false);
	acc.append(Buffer.from("\nextra line")); // one more line → over
	const over = acc.snapshot();
	if (over.fullOutputPath) created.push(over.fullOutputPath);
	expect(over.truncation.truncated).toBe(true);
});
