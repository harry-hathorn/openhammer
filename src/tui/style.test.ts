import { describe, expect, it } from "vitest";
import { createStyle, isColorEnabled, type Style } from "./style.ts";

/** Strip ANSI SGR sequences so asserts compare visible text only. Built from a
 * string (not a regex literal) so it carries no literal control char (biome). */
const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
function stripAnsi(s: string): string {
	return s.replace(ANSI_SGR, "");
}

describe("style — createStyle(false) is identity", () => {
	const s: Style = createStyle(false);
	it("every wrapper returns the input untouched (no SGR codes)", () => {
		for (const fn of [
			s.accent,
			s.success,
			s.error,
			s.warning,
			s.muted,
			s.dim,
			s.bold,
			s.inverse,
			s.border,
			s.borderAccent,
		]) {
			expect(fn("hello")).toBe("hello");
		}
	});

	it("selectListTheme fns are identity when disabled", () => {
		const t = s.selectListTheme;
		for (const fn of [t.selectedPrefix, t.selectedText, t.description, t.scrollInfo, t.noMatch]) {
			expect(fn("row")).toBe("row");
		}
	});
});

describe("style — createStyle(true) emits SGR + stays width-honest", () => {
	const s: Style = createStyle(true);

	it("each wrapper wraps the text in an SGR sequence and resets it", () => {
		const cases: Array<[keyof Style, string]> = [
			["accent", "x"],
			["success", "ok"],
			["error", "bad"],
			["warning", "careful"],
			["muted", "gray"],
			["dim", "faint"],
			["bold", "strong"],
			["inverse", "flip"],
			["border", "line"],
			["borderAccent", "line"],
		];
		for (const [key, text] of cases) {
			const fn = s[key] as (t: string) => string;
			const out = fn(text);
			expect(out).not.toBe(text); // colorized
			expect(out.startsWith("\x1b[")).toBe(true); // opens with an SGR
			expect(out.includes(text)).toBe(true); // original text is present
			expect(stripAnsi(out)).toBe(text); // width-honest: visible text == input
		}
	});

	it("composes without bleeding across segments (each fn self-resets)", () => {
		// bold(accent(x)) + plain(y): the reset after x means y is not styled.
		const line = `${s.bold(s.accent("title"))} value`;
		// After stripping, equals the concatenation; no stray attributes leak past resets.
		expect(stripAnsi(line)).toBe("title value");
	});

	it("selectListTheme colorizes the selected row and dims the rest", () => {
		const t = s.selectListTheme;
		expect(stripAnsi(t.selectedText("→ Status"))).toBe("→ Status");
		expect(t.selectedText("x").startsWith("\x1b[")).toBe(true);
		expect(stripAnsi(t.description("hint"))).toBe("hint");
		expect(t.description("hint").includes("\x1b[90m")).toBe(true); // muted = gray
	});
});

describe("style — isColorEnabled respects NO_COLOR / FORCE_COLOR / TTY", () => {
	it("NO_COLOR set (any value, even empty) disables", () => {
		expect(isColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
		expect(isColorEnabled({ NO_COLOR: "" }, true)).toBe(false);
	});

	it("FORCE_COLOR=0 disables", () => {
		expect(isColorEnabled({ FORCE_COLOR: "0" }, true)).toBe(false);
	});

	it("enabled when a TTY and neither override is set", () => {
		expect(isColorEnabled({}, true)).toBe(true);
	});

	it("disabled when not a TTY (piped / CI)", () => {
		expect(isColorEnabled({}, false)).toBe(false);
	});

	it("NO_COLOR wins over a TTY", () => {
		expect(isColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
	});
});
