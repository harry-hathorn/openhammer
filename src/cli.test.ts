import { describe, expect, it } from "vitest";
import { runCli } from "./cli.ts";
import { BANNER } from "./tui/banner.ts";

/** A recording `BannerStream` fake: collects writes as a string. */
function recordingStream() {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
	};
	return { stream, text: () => chunks.join("") };
}

describe("runCli", () => {
	it("prints the README banner on an interactive (TTY) launch", () => {
		const out = recordingStream();
		const err = recordingStream();
		runCli([], { stdout: out.stream, stderr: err.stream, isTTY: true });
		expect(out.text()).toContain(BANNER);
	});

	it("does NOT print the banner on a non-interactive launch", () => {
		const out = recordingStream();
		const err = recordingStream();
		runCli([], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(out.text()).toBe("");
	});

	it("writes diagnostics to stderr and suppresses the banner when non-interactive", () => {
		const out = recordingStream();
		const err = recordingStream();
		const parsed = runCli(["--bogus"], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(parsed.diagnostics).toHaveLength(1);
		expect(err.text()).toContain("warning: Unknown option: --bogus");
		expect(out.text()).toBe("");
	});

	it("returns the parsed args for the dispatcher", () => {
		const out = recordingStream();
		const err = recordingStream();
		const parsed = runCli(["channel", "list"], { stdout: out.stream, stderr: err.stream, isTTY: false });
		expect(parsed.command).toBe("channel");
		expect(parsed.rest).toEqual(["list"]);
		expect(parsed.tunnel).toBe(false);
	});
});
