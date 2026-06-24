import { describe, expect, it } from "vitest";
import { parseSubFlags } from "./flags.ts";

describe("parseSubFlags", () => {
	it("parses `--name value` (space form) into values", () => {
		const r = parseSubFlags(["--provider", "ngrok", "--authtoken", "T0KEN"]);
		expect(r.values).toEqual({ provider: "ngrok", authtoken: "T0KEN" });
		expect(r.bools.size).toBe(0);
		expect(r.positionals).toEqual([]);
	});

	it("parses `--name=value` (equals form), allowing dash-leading values", () => {
		const r = parseSubFlags(["--label=ci-bot", "--authtoken=-starts-with-dash"]);
		expect(r.values).toEqual({ label: "ci-bot", authtoken: "-starts-with-dash" });
	});

	it("treats a trailing `--name` as a boolean flag", () => {
		const r = parseSubFlags(["--provider", "ngrok", "--default"]);
		expect(r.values).toEqual({ provider: "ngrok" });
		expect([...r.bools]).toEqual(["default"]);
	});

	it("treats `--name` immediately before another flag as boolean", () => {
		const r = parseSubFlags(["--default", "--provider", "ngrok"]);
		expect([...r.bools]).toEqual(["default"]);
		expect(r.values).toEqual({ provider: "ngrok" });
	});

	it("collects non-flag tokens as positionals in order", () => {
		const r = parseSubFlags(["mcp.allowedClients", "claude-code"]);
		expect(r.positionals).toEqual(["mcp.allowedClients", "claude-code"]);
		expect(r.values).toEqual({});
	});

	it("interleaves flags and positionals correctly", () => {
		const r = parseSubFlags(["--provider", "ngrok", "extra-positional", "--default"]);
		expect(r.values).toEqual({ provider: "ngrok" });
		expect([...r.bools]).toEqual(["default"]);
		expect(r.positionals).toEqual(["extra-positional"]);
	});

	it("everything after `--` is positional (sentinel)", () => {
		const r = parseSubFlags(["--", "--not-a-flag", "value"]);
		expect(r.positionals).toEqual(["--not-a-flag", "value"]);
		expect(r.values).toEqual({});
		expect(r.bools.size).toBe(0);
	});

	it("an unrecognized short option lands in `unknown` (never throws)", () => {
		const r = parseSubFlags(["-x", "value"]);
		expect(r.unknown).toEqual(["-x"]);
		expect(r.positionals).toEqual(["value"]);
	});

	it("a value that begins with `-` must use the `=` form (else the flag is boolean)", () => {
		// `--threshold -1`: `-1` starts with `-` → `--threshold` is boolean, `-1` is unknown.
		const r = parseSubFlags(["--threshold", "-1"]);
		expect([...r.bools]).toEqual(["threshold"]);
		expect(r.unknown).toEqual(["-1"]);
	});

	it("empty input → empty everything", () => {
		const r = parseSubFlags([]);
		expect(r.values).toEqual({});
		expect(r.bools.size).toBe(0);
		expect(r.positionals).toEqual([]);
		expect(r.unknown).toEqual([]);
	});

	it("a flag with no value at the very end is boolean", () => {
		const r = parseSubFlags(["--provider", "ngrok", "--print-secret"]);
		expect(r.values).toEqual({ provider: "ngrok" });
		expect([...r.bools]).toEqual(["print-secret"]);
	});
});
