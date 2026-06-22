import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAllTools } from "./index.ts";

const EXPECTED_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

describe("createAllTools", () => {
	it("returns exactly 7 entries named read,bash,edit,write,grep,find,ls (in order)", () => {
		// `/srv` is the spec's nominal root — the names/order are rootDir-independent;
		// rootDir only flows into the handler closure, not the tool descriptors.
		const entries = createAllTools("/srv");
		expect(entries).toHaveLength(7);
		expect(entries.map((e) => e.tool.name)).toEqual([...EXPECTED_NAMES]);
	});

	it("lifts name/description/inputSchema onto each entry's tool descriptor", () => {
		const entries = createAllTools("/srv");
		for (const entry of entries) {
			// Every descriptor carries the three MCP-visible fields (no cast needed —
			// ToolModule.inputSchema is already Tool["inputSchema"], the single source).
			expect(typeof entry.tool.name).toBe("string");
			expect(typeof entry.tool.description).toBe("string");
			expect(entry.tool.inputSchema.type).toBe("object");
			// No two tools share a name.
		}
		expect(new Set(entries.map((e) => e.tool.name)).size).toBe(7);
	});

	it("handler forwards args to execute and returns a Result<ToolOk> on the ok branch", async () => {
		// Bind to a real temp dir so bash can cwd into it; echo proves args forwarding
		// and the handler closing over rootDir end-to-end (the bash tool spawns the
		// configured shell). This is the same local-exec path bash.test.ts exercises.
		const rootDir = mkdtempSync(join(tmpdir(), "openhammer-index-"));
		const entries = createAllTools(rootDir);
		const bash = entries.find((e) => e.tool.name === "bash");
		if (!bash) throw new Error("bash entry missing");

		const result = await bash.handler({ command: "echo openhammer-registry" });

		// Result spine: the ok discriminant narrows to a ToolOk with content blocks.
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(Array.isArray(result.value.content)).toBe(true);
			expect(result.value.content.length).toBeGreaterThan(0);
			const text = result.value.content.map((c) => (c.type === "text" ? c.text : "")).join("");
			expect(text).toContain("openhammer-registry");
		}
	});

	it("handler defaults missing args to {} (a no-arg call still returns a Result)", async () => {
		const entries = createAllTools(mkdtempSync(join(tmpdir(), "openhammer-index-")));
		// `read` with no path -> an expected failure encoded as err, never a throw.
		const read = entries.find((e) => e.tool.name === "read");
		if (!read) throw new Error("read entry missing");

		const result = await read.handler();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
		}
	});
});
