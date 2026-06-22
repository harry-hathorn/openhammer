import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";

/** Build `count` newline-joined lines "line 1".."line N" (no trailing newline). */
function lines(count: number): string {
	return Array.from({ length: count }, (_, i) => `line ${i + 1}`).join("\n");
}

describe("formatSize", () => {
	it("formats bytes below 1KB with a B suffix (spec acceptance: 512*1024 → 512.0KB)", () => {
		expect(formatSize(0)).toBe("0B");
		expect(formatSize(1023)).toBe("1023B");
	});

	it("formats KB between 1KB and 1MB", () => {
		expect(formatSize(512 * 1024)).toBe("512.0KB");
		expect(formatSize(1024)).toBe("1.0KB");
	});

	it("formats MB at and above 1MB", () => {
		expect(formatSize(1024 * 1024)).toBe("1.0MB");
		expect(formatSize(2.5 * 1024 * 1024)).toBe("2.5MB");
	});
});

describe("truncateHead", () => {
	it("passes content through unchanged when under both limits", () => {
		const content = "a\nb\nc";
		const r = truncateHead(content);
		expect(r.truncated).toBe(false);
		expect(r.truncatedBy).toBeNull();
		expect(r.content).toBe(content);
		expect(r.outputLines).toBe(3);
		expect(r.firstLineExceedsLimit).toBe(false);
	});

	it("truncates 3000 lines down to the first 2000 by line limit (spec acceptance)", () => {
		const content = lines(3000);
		const r = truncateHead(content);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
		expect(r.outputLines).toBe(DEFAULT_MAX_LINES); // 2000
		expect(r.totalLines).toBe(3000);
		expect(r.firstLineExceedsLimit).toBe(false);
		// Keeps the head: first line present, line 2001 absent.
		expect(r.content.startsWith("line 1\n")).toBe(true);
		expect(r.content).not.toContain("line 2001");
	});

	it("returns empty content when a single line exceeds the byte limit (spec acceptance)", () => {
		// 60KB single line (no newline) > 50KB default.
		const content = "x".repeat(60 * 1024);
		const r = truncateHead(content);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.content).toBe("");
		expect(r.outputLines).toBe(0);
		expect(r.firstLineExceedsLimit).toBe(true);
		expect(r.totalBytes).toBe(60 * 1024);
	});

	it("truncates by bytes when many lines overflow the byte budget before the line limit", () => {
		// 10 lines each ~10KB → ~100KB, well over the 50KB default; few lines.
		const big = `${"y".repeat(10 * 1024)}`;
		const content = Array.from({ length: 10 }, () => big).join("\n");
		const r = truncateHead(content);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(r.outputLines).toBeLessThan(10);
	});

	it("respects a custom maxLines override", () => {
		const content = lines(10);
		const r = truncateHead(content, { maxLines: 3 });
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("lines");
		expect(r.outputLines).toBe(3);
		expect(r.maxLines).toBe(3);
	});
});

describe("truncateTail", () => {
	it("passes content through unchanged when under both limits", () => {
		const content = "a\nb\nc";
		const r = truncateTail(content);
		expect(r.truncated).toBe(false);
		expect(r.content).toBe(content);
		expect(r.lastLinePartial).toBe(false);
	});

	it("keeps the LAST 2000 lines (spec acceptance)", () => {
		const content = lines(3000);
		const r = truncateTail(content);
		expect(r.truncated).toBe(true);
		expect(r.outputLines).toBe(DEFAULT_MAX_LINES); // 2000
		expect(r.totalLines).toBe(3000);
		// Tail kept: last line present, line 1000 (dropped) absent.
		expect(r.content.endsWith("\nline 3000")).toBe(true);
		expect(r.content).not.toContain("\nline 1000\n");
	});

	it("takes a partial last line when a single oversized line exceeds maxBytes", () => {
		// 60KB single line → no whole line fits; tail keeps the end as a partial.
		const content = "z".repeat(60 * 1024);
		const r = truncateTail(content);
		expect(r.truncated).toBe(true);
		expect(r.truncatedBy).toBe("bytes");
		expect(r.lastLinePartial).toBe(true);
		expect(r.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(r.content.length).toBeGreaterThan(0);
	});

	it("respects a custom maxBytes override", () => {
		const content = lines(3000);
		const r = truncateTail(content, { maxBytes: 100 });
		expect(r.truncated).toBe(true);
		expect(r.outputBytes).toBeLessThanOrEqual(100);
		expect(r.maxBytes).toBe(100);
	});
});

describe("truncateLine", () => {
	it("returns short lines unchanged", () => {
		expect(truncateLine("short")).toEqual({ text: "short", wasTruncated: false });
	});

	it("defaults to GREP_MAX_LINE_LENGTH", () => {
		const line = "a".repeat(GREP_MAX_LINE_LENGTH);
		expect(truncateLine(line).wasTruncated).toBe(false);
		expect(truncateLine(`${line}x`).wasTruncated).toBe(true);
	});

	it("adds a [truncated] suffix and caps to maxChars", () => {
		const line = "b".repeat(GREP_MAX_LINE_LENGTH + 50);
		const r = truncateLine(line);
		expect(r.wasTruncated).toBe(true);
		expect(r.text).toBe(`${"b".repeat(GREP_MAX_LINE_LENGTH)}... [truncated]`);
	});

	it("honours an explicit maxChars override", () => {
		const r = truncateLine("abcdefghij", 4);
		expect(r).toEqual({ text: "abcd... [truncated]", wasTruncated: true });
	});
});
