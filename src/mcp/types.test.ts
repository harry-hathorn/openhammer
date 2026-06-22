/**
 * Smoke test for the tool/MCP contract types. Most of the value here is
 * type-level: if `ToolContent`, `ToolModule`, or `McpToolEntry` drift from the
 * shape the registry/server/tools rely on, this file fails to compile under
 * `tsc`. The runtime assertions pin the discriminated-union structure and the
 * `Result` shape the handlers must return — a cheap guard against silent
 * structural drift until real tool modules (specs 03–09) and the registry land.
 */
import { describe, expect, it } from "vitest";
import { err, ok } from "../tools/result.ts";
import type { McpToolEntry, ToolContent, ToolModule, ToolOk } from "./types.ts";

describe("types: ToolContent", () => {
	it("narrows on the `type` discriminant (text)", () => {
		const block: ToolContent = { type: "text", text: "hello" };
		if (block.type === "text") {
			expect(block.text).toBe("hello");
		} else {
			throw new Error("unreachable: discriminant mismatch");
		}
	});

	it("narrows on the `type` discriminant (image)", () => {
		const block: ToolContent = { type: "image", data: "AAAA", mimeType: "image/png" };
		if (block.type === "image") {
			expect(block.data).toBe("AAAA");
			expect(block.mimeType).toBe("image/png");
		} else {
			throw new Error("unreachable: discriminant mismatch");
		}
	});
});

describe("types: ToolModule + McpToolEntry", () => {
	// A minimal stand-in for a real tool module (specs 03–09 export these).
	const module: ToolModule = {
		name: "read",
		description: "read a file",
		inputSchema: { type: "object", properties: { path: { type: "string" } } },
		async execute(_args, _rootDir) {
			const value: ToolOk = { content: [{ type: "text", text: "ok" }] };
			return ok(value);
		},
	};

	it("execute returns a Result<ToolOk> success", async () => {
		const result = await module.execute({}, "/srv");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.content[0]).toMatchObject({ type: "text", text: "ok" });
		}
	});

	it("execute can return an err without throwing", async () => {
		const failing: ToolModule = {
			...module,
			async execute() {
				return err(new Error("boom"));
			},
		};
		const result = await failing.execute({}, "/srv");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBeInstanceOf(Error);
			expect(result.error.message).toBe("boom");
		}
	});

	it("the registry entry shape binds a module to rootDir via handler", async () => {
		const entry: McpToolEntry = {
			tool: { name: module.name, description: module.description, inputSchema: module.inputSchema },
			handler: (args) => module.execute(args ?? {}, "/srv"),
		};
		expect(entry.tool.name).toBe("read");
		// handler defaults args to {} when called bare, and threads rootDir.
		const result = await entry.handler();
		expect(result.ok).toBe(true);
	});
});
