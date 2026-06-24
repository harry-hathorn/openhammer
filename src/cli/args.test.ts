import { describe, expect, it } from "vitest";
import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
	describe("command dispatch table", () => {
		it("extracts `command` + single-token `rest`", () => {
			const r = parseArgs(["channel", "add"]);
			expect(r.command).toBe("channel");
			expect(r.rest).toEqual(["add"]);
			expect(r.diagnostics).toEqual([]);
		});

		it("extracts `command` + multi-token `rest` (subcommand + operand)", () => {
			const r = parseArgs(["config", "set", "mcp"]);
			expect(r.command).toBe("config");
			expect(r.rest).toEqual(["set", "mcp"]);
		});

		it("extracts `doctor` and `monitor` with empty rest", () => {
			expect(parseArgs(["doctor"])).toMatchObject({ command: "doctor", rest: [] });
			expect(parseArgs(["monitor"])).toMatchObject({ command: "monitor", rest: [] });
		});

		it("treats `start` as the command word", () => {
			const r = parseArgs(["start"]);
			expect(r.command).toBe("start");
			expect(r.rest).toEqual([]);
		});

		it("no argv → null command (default → boot)", () => {
			const r = parseArgs([]);
			expect(r.command).toBeNull();
			expect(r.rest).toEqual([]);
			expect(r.diagnostics).toEqual([]);
		});

		it("an unrecognized first positional is left for the dispatcher (no diagnostic)", () => {
			const r = parseArgs(["frobnicate", "x"]);
			expect(r.command).toBe("frobnicate");
			expect(r.rest).toEqual(["x"]);
			expect(r.diagnostics).toEqual([]);
		});

		it("flags before the command still yield the command word", () => {
			const r = parseArgs(["--tunnel", "start"]);
			expect(r.command).toBe("start");
			expect(r.tunnel).toBe(true);
			expect(r.rest).toEqual([]);
		});

		it("flags interspersed with positionals are parsed out of `rest`", () => {
			const r = parseArgs(["channel", "--tunnel", "remove", "abc"]);
			expect(r.command).toBe("channel");
			expect(r.tunnel).toBe(true);
			expect(r.rest).toEqual(["remove", "abc"]);
		});
	});

	describe("flags", () => {
		it("parses `--tunnel`", () => {
			const r = parseArgs(["--tunnel"]);
			expect(r.tunnel).toBe(true);
			expect(r.command).toBeNull();
			expect(r.diagnostics).toEqual([]);
		});

		it("parses `--channel <id>`", () => {
			expect(parseArgs(["--channel", "abc-123"]).channel).toBe("abc-123");
		});

		it("parses `--channel=<id>` (equals form)", () => {
			expect(parseArgs(["--channel=abc-123"]).channel).toBe("abc-123");
		});

		it("parses `--help` and `-h`", () => {
			expect(parseArgs(["--help"]).help).toBe(true);
			expect(parseArgs(["-h"]).help).toBe(true);
		});
	});

	describe("unknown options → diagnostics (never throws)", () => {
		it("unknown long option → warning", () => {
			const r = parseArgs(["--bogus"]);
			expect(r.diagnostics).toEqual([{ type: "warning", message: "Unknown option: --bogus" }]);
		});

		it("unknown short option → error", () => {
			const r = parseArgs(["-x"]);
			expect(r.diagnostics).toEqual([{ type: "error", message: "Unknown option: -x" }]);
		});

		it("`--channel` with no value → error", () => {
			const r = parseArgs(["--channel"]);
			expect(r.diagnostics).toEqual([{ type: "error", message: "Option --channel requires a value" }]);
		});

		it("`--channel` followed by another flag → error and the flag still parses", () => {
			const r = parseArgs(["--channel", "--tunnel"]);
			expect(r.channel).toBeUndefined();
			expect(r.tunnel).toBe(true);
			expect(r.diagnostics).toEqual([{ type: "error", message: "Option --channel requires a value" }]);
		});

		it("`--channel=<value>` with an unknown `--x=y` → warning", () => {
			const r = parseArgs(["--bogus=yes"]);
			expect(r.diagnostics).toEqual([{ type: "warning", message: "Unknown option: --bogus" }]);
		});

		it("accumulates multiple diagnostics", () => {
			const r = parseArgs(["--bogus", "-y"]);
			expect(r.diagnostics).toHaveLength(2);
		});

		it("does not throw on unusual input", () => {
			expect(() => parseArgs(["-z", "--bogus", "cmd"])).not.toThrow();
		});
	});

	describe("subcommand flag passthrough (spec 20g)", () => {
		it("an unknown long option AFTER the command passes through to `rest` (no diagnostic)", () => {
			const r = parseArgs(["channel", "add", "--provider", "ngrok", "--authtoken", "T"]);
			expect(r.command).toBe("channel");
			expect(r.rest).toEqual(["add", "--provider", "ngrok", "--authtoken", "T"]);
			expect(r.diagnostics).toEqual([]);
		});

		it("`--flag=value` AFTER the command passes through verbatim", () => {
			const r = parseArgs(["auth", "add-client", "--label=ci-bot", "--print-secret"]);
			expect(r.command).toBe("auth");
			expect(r.rest).toEqual(["add-client", "--label=ci-bot", "--print-secret"]);
			expect(r.diagnostics).toEqual([]);
		});

		it("a boolean-style subcommand flag (`--default` at the tail) passes through", () => {
			const r = parseArgs(["channel", "add", "--provider", "ngrok", "--default"]);
			expect(r.rest).toEqual(["add", "--provider", "ngrok", "--default"]);
			expect(r.diagnostics).toEqual([]);
		});

		it("recognized top-level flags are still extracted even after the command", () => {
			// `--tunnel` is a known top-level flag → parsed out of `rest`, not passthrough.
			const r = parseArgs(["channel", "--tunnel", "remove", "abc"]);
			expect(r.command).toBe("channel");
			expect(r.tunnel).toBe(true);
			expect(r.rest).toEqual(["remove", "abc"]);
		});

		it("an unknown long option BEFORE the command is still a warning (top-level typo)", () => {
			const r = parseArgs(["--bogus", "start"]);
			expect(r.command).toBe("start");
			expect(r.diagnostics).toEqual([{ type: "warning", message: "Unknown option: --bogus" }]);
		});
	});
});
