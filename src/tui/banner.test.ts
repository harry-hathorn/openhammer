import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BANNER, printBanner } from "./banner.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
// README is the source of truth — extract its FIRST ```text fenced block (the banner).
const fenceMatch = readme.match(/```text\r?\n([\s\S]*?)\r?\n```/);

describe("banner", () => {
	it("README exposes a text-fenced banner block", () => {
		expect(fenceMatch).not.toBeNull();
	});

	it("BANNER byte-matches the README's first text-fenced block (refuses drift)", () => {
		expect(fenceMatch).not.toBeNull();
		const block = fenceMatch?.[1];
		expect(block).toBeDefined();
		// byte-for-byte: compare the UTF-8 encodings, not just string identity.
		expect(Buffer.from(BANNER, "utf8")).toEqual(Buffer.from(block ?? "", "utf8"));
	});

	it("printBanner writes the banner + a trailing newline to the stream", () => {
		let written = "";
		const stream = {
			write(chunk: string | Uint8Array): boolean {
				written += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
				return true;
			},
		};
		printBanner(stream);
		expect(written).toBe(`${BANNER}\n`);
	});
});
