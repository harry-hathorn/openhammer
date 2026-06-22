import { describe, expect, it } from "vitest";
import {
	type AppliedEditsResult,
	applyEditsToNormalizedContent,
	detectLineEnding,
	fuzzyFindText,
	normalizeForFuzzyMatch,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";

const BOM = "﻿";
const NBSP = " ";
const EN_QUAD = " "; // start of the U+2002–U+200A spaces range
const FOUR_PER_EM = " "; // inside the range
const HAIR_SPACE = " "; // end of the range
const IDEOGRAPHIC_SPACE = "　";

describe("stripBom", () => {
	it("strips a leading UTF-8 BOM and reports it", () => {
		expect(stripBom(`${BOM}hello`)).toEqual({ bom: BOM, text: "hello" });
	});

	it("returns an empty bom when none is present", () => {
		expect(stripBom("hello")).toEqual({ bom: "", text: "hello" });
	});
});

describe("detectLineEnding", () => {
	it("detects CRLF", () => {
		expect(detectLineEnding("a\r\nb")).toBe("\r\n");
	});

	it("detects LF", () => {
		expect(detectLineEnding("a\nb")).toBe("\n");
	});

	it("defaults to LF when there are no newlines", () => {
		expect(detectLineEnding("abc")).toBe("\n");
	});

	it("prefers CRLF when it appears before LF", () => {
		expect(detectLineEnding("a\r\nb\nc")).toBe("\r\n");
	});
});

describe("normalizeToLF", () => {
	it("converts CRLF to LF", () => {
		expect(normalizeToLF("a\r\nb\r\n")).toBe("a\nb\n");
	});

	it("converts a lone CR to LF", () => {
		expect(normalizeToLF("a\rb")).toBe("a\nb");
	});

	it("leaves LF-only text unchanged", () => {
		expect(normalizeToLF("a\nb")).toBe("a\nb");
	});
});

describe("restoreLineEndings", () => {
	it("restores CRLF", () => {
		expect(restoreLineEndings("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
	});

	it("leaves LF text unchanged", () => {
		expect(restoreLineEndings("a\nb", "\n")).toBe("a\nb");
	});
});

describe("normalizeForFuzzyMatch", () => {
	it("strips trailing whitespace from each line", () => {
		expect(normalizeForFuzzyMatch("foo   \nbar\t")).toBe("foo\nbar");
	});

	it("normalizes smart single quotes to ASCII", () => {
		expect(normalizeForFuzzyMatch("‘x’")).toBe("'x'");
	});

	it("normalizes smart double quotes to ASCII", () => {
		expect(normalizeForFuzzyMatch("“x”")).toBe('"x"');
	});

	it("normalizes Unicode dashes to an ASCII hyphen", () => {
		expect(normalizeForFuzzyMatch("a—b")).toBe("a-b");
	});

	it("normalizes NBSP to a regular space", () => {
		expect(normalizeForFuzzyMatch(`a${NBSP}b`)).toBe("a b");
	});

	it("normalizes a space inside the U+2002–U+200A range", () => {
		expect(normalizeForFuzzyMatch(`a${FOUR_PER_EM}b`)).toBe("a b");
		expect(normalizeForFuzzyMatch(`a${EN_QUAD}b`)).toBe("a b");
		expect(normalizeForFuzzyMatch(`a${HAIR_SPACE}b`)).toBe("a b");
	});

	it("normalizes the ideographic space U+3000", () => {
		expect(normalizeForFuzzyMatch(`a${IDEOGRAPHIC_SPACE}b`)).toBe("a b");
	});
});

describe("fuzzyFindText", () => {
	it("returns an exact match without fuzzy matching", () => {
		const r = fuzzyFindText("hello world", "world");
		expect(r.found).toBe(true);
		expect(r.usedFuzzyMatch).toBe(false);
		expect(r.index).toBe(6);
		expect(r.matchLength).toBe(5);
		expect(r.contentForReplacement).toBe("hello world");
	});

	it("reports not-found", () => {
		const r = fuzzyFindText("hello", "world");
		expect(r.found).toBe(false);
		expect(r.index).toBe(-1);
		expect(r.matchLength).toBe(0);
	});

	it("falls back to fuzzy match on trailing-whitespace differences", () => {
		const r = fuzzyFindText("foo   \nbar", "foo\nbar");
		expect(r.found).toBe(true);
		expect(r.usedFuzzyMatch).toBe(true);
		expect(r.matchLength).toBe("foo\nbar".length);
		expect(r.contentForReplacement).toBe("foo\nbar");
	});
});

describe("applyEditsToNormalizedContent", () => {
	it("applies a single exact match", () => {
		const r = applyEditsToNormalizedContent("foo bar baz", [{ oldText: "bar", newText: "qux" }], "f.txt");
		const expected: AppliedEditsResult = { baseContent: "foo bar baz", newContent: "foo qux baz" };
		expect(r).toEqual({ ok: true, value: expected });
	});

	it("applies multiple disjoint edits against the original content (not incrementally)", () => {
		const content = "alpha\nbeta\ngamma";
		const r = applyEditsToNormalizedContent(
			content,
			[
				{ oldText: "alpha", newText: "ALPHA" },
				{ oldText: "gamma", newText: "GAMMA" },
			],
			"f.txt",
		);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.value.newContent).toBe("ALPHA\nbeta\nGAMMA");
		}
	});

	it("returns err with the not-found message", () => {
		const r = applyEditsToNormalizedContent("foo bar baz", [{ oldText: "nope", newText: "x" }], "f.txt");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toBe(
				"Could not find the exact text in f.txt. The old text must match exactly including all whitespace and newlines.",
			);
		}
	});

	it("returns err with the multi-edit not-found message", () => {
		const r = applyEditsToNormalizedContent(
			"foo",
			[
				{ oldText: "foo", newText: "FOO" },
				{ oldText: "missing", newText: "X" },
			],
			"f.txt",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toBe(
				"Could not find edits[1] in f.txt. The oldText must match exactly including all whitespace and newlines.",
			);
		}
	});

	it("returns err when oldText occurs more than once (duplicate)", () => {
		const r = applyEditsToNormalizedContent("foo foo foo", [{ oldText: "foo", newText: "bar" }], "f.txt");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toBe(
				"Found 3 occurrences of the text in f.txt. The text must be unique. Please provide more context to make it unique.",
			);
		}
	});

	it("returns err with the overlap message for adjacent overlapping edits", () => {
		const r = applyEditsToNormalizedContent(
			"abcdefgh",
			[
				{ oldText: "abcde", newText: "X" },
				{ oldText: "defgh", newText: "Y" },
			],
			"f.txt",
		);
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toBe(
				"edits[0] and edits[1] overlap in f.txt. Merge them into one edit or target disjoint regions.",
			);
		}
	});

	it("returns err when an edit produces no change", () => {
		const r = applyEditsToNormalizedContent("foo bar", [{ oldText: "bar", newText: "bar" }], "f.txt");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toContain("No changes made to f.txt");
		}
	});

	it("returns err for empty oldText", () => {
		const r = applyEditsToNormalizedContent("foo bar", [{ oldText: "", newText: "x" }], "f.txt");
		expect(r.ok).toBe(false);
		if (!r.ok) {
			expect(r.error.message).toBe("oldText must not be empty in f.txt.");
		}
	});

	it("matches via fuzzy trailing-whitespace and writes normalized content", () => {
		// content has trailing spaces the LLM omitted from oldText
		const r = applyEditsToNormalizedContent("foo   \nbar", [{ oldText: "foo\nbar", newText: "qux\nbar" }], "f.txt");
		expect(r.ok).toBe(true);
		if (r.ok) {
			// fuzzy space strips the trailing whitespace, so the result is normalized
			expect(r.value.newContent).toBe("qux\nbar");
		}
	});

	it("preserves BOM + CRLF through a full strip→normalize→apply→restore round trip", () => {
		// This mirrors what edit.ts will do (spec 06, step 5–7).
		const raw = `${BOM}line1\r\nline2\r\n`;
		const { bom, text: content } = stripBom(raw);
		const ending = detectLineEnding(content);
		const normalized = normalizeToLF(content);
		const applied = applyEditsToNormalizedContent(normalized, [{ oldText: "line2", newText: "line two" }], "f.txt");
		expect(applied.ok).toBe(true);
		if (!applied.ok) return;
		const finalContent = bom + restoreLineEndings(applied.value.newContent, ending);
		expect(finalContent).toBe(`${BOM}line1\r\nline two\r\n`);
	});
});
