import { describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { buildGuide, guideTool } from "./guide.ts";

// The `guide` tool is a `ToolModule`; tests drive `execute` directly (Tier-0) and
// the pure `buildGuide` builder. It takes no params and returns a single text block
// of orientation markdown built from the working root (spec 18, Phase A).

const ROOT = "/srv/openhammer-root";

/** Unwrap a successful Result; throw (failing the test) if it was an err. */
function unwrap<T extends ToolOk>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!r.ok) {
		throw new Error(`expected ok, got err: ${r.error.message}`);
	}
	return r.value;
}

/** The single text block of a `guide` result. */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

describe("buildGuide", () => {
	it("embeds the resolved working root (the working-root contract)", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain(ROOT);
		expect(md).toContain("Working root");
	});

	it("states the working-root contract: paths resolve under the root, bash cwd does not persist, use absolute paths", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("does not persist");
		expect(md).toContain("absolute paths");
	});

	it("describes OpenHammer as a stateless, no-LLM tool executor", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("no LLM");
		expect(md).toContain("stateless");
	});

	it("lists all 7 capability tools, one line each", () => {
		const md = buildGuide(ROOT);
		for (const name of ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
			expect(md).toContain(`\`${name}\``);
		}
	});

	it("carries the workflow notes: bounded output / response_too_large, no memory, container = jail", () => {
		const md = buildGuide(ROOT);
		expect(md).toContain("response_too_large");
		expect(md).toContain("no memory between calls");
		expect(md).toContain("container");
	});

	it("ends with the evolvability note", () => {
		expect(buildGuide(ROOT)).toContain("This guide evolves as OpenHammer grows.");
	});

	it("reflects a different root verbatim (rootDir is the only input)", () => {
		const other = "/a/different/abs/root";
		expect(buildGuide(other)).toContain(other);
		expect(buildGuide(other)).not.toContain(ROOT);
	});
});

describe("guideTool", () => {
	it("has the guide shape: name, 'Read this first' description, empty object schema", () => {
		expect(guideTool.name).toBe("guide");
		expect(guideTool.description).toContain("Read this first");
		expect(guideTool.inputSchema.type).toBe("object");
		// `guide` takes no parameters — an empty properties object (no required).
		expect(guideTool.inputSchema.properties).toEqual({});
	});

	it("execute returns ok with a single text block equal to buildGuide(rootDir)", async () => {
		const r = await guideTool.execute({}, ROOT);
		expect(r.ok).toBe(true);
		expect(textOf(r)).toBe(buildGuide(ROOT));
	});

	it("execute is rootDir-driven and ignores any args (no params)", async () => {
		// The handler forwards `args ?? {}`; guide must not choke on stray args.
		const r = await guideTool.execute({ unexpected: "ignored" }, ROOT);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(textOf(r)).toContain(ROOT);
		}
	});
});
