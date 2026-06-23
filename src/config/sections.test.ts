import { describe, expect, it } from "vitest";
import { CONFIG_SECTIONS, mcpSection } from "./sections.ts";
import { defaultSettings, type Settings } from "./settings.ts";

/** Settings with a given `allowedClients` list (the only field the `mcp` section touches). */
function withClients(clients: string[]): Settings {
	return { ...defaultSettings(), mcp: { allowedClients: clients } };
}

describe("mcpSection — fields", () => {
	it("declares a single text field named allowedClients", () => {
		expect(mcpSection.id).toBe("mcp");
		expect(mcpSection.fields).toHaveLength(1);
		const field = mcpSection.fields[0];
		expect(field).toBeDefined();
		if (field) {
			expect(field.key).toBe("allowedClients");
			expect(field.kind).toBe("text");
		}
	});
});

describe("mcpSection — read", () => {
	it("joins the current list with comma+space for display", () => {
		expect(mcpSection.read(withClients(["cursor", "claude"]))).toEqual({ allowedClients: "cursor, claude" });
	});

	it("reads an empty string for an empty list", () => {
		expect(mcpSection.read(defaultSettings())).toEqual({ allowedClients: "" });
	});

	it("reads a single wildcard verbatim", () => {
		expect(mcpSection.read(withClients(["*"]))).toEqual({ allowedClients: "*" });
	});
});

describe("mcpSection — write", () => {
	it("parses a comma list into string[]", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "cursor, claude" });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude"]);
	});

	it("parses a newline-separated list", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "cursor\nclaude\nvscode" });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude", "vscode"]);
	});

	it("trims entries and drops empties", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "  cursor  ,, , claude ," });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude"]);
	});

	it("writes [] for an empty answer", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "" }).mcp.allowedClients).toEqual([]);
	});

	it("writes [] for a whitespace-only answer", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "   " }).mcp.allowedClients).toEqual([]);
	});

	it("preserves a wildcard", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "*" }).mcp.allowedClients).toEqual(["*"]);
	});

	it("returns an immutable update — channels/version/defaultChannel untouched", () => {
		const original: Settings = {
			...defaultSettings(),
			channels: [{ id: "x", kind: "nginx", mode: "static", options: { publicUrl: "https://x" } }],
			defaultChannel: "x",
		};
		const next = mcpSection.write(original, { allowedClients: "cursor" });
		expect(next).not.toBe(original); // new object
		expect(next.channels).toBe(original.channels); // untouched by reference
		expect(next.version).toBe(original.version);
		expect(next.defaultChannel).toBe("x");
		expect(next.mcp).not.toBe(original.mcp); // mcp replaced
	});

	it("defaults a missing allowedClients key to []", () => {
		expect(mcpSection.write(defaultSettings(), {}).mcp.allowedClients).toEqual([]);
	});
});

describe("mcpSection — round-trip", () => {
	it("read → write returns the same list (comma-joined round-trips through parse)", () => {
		const s = withClients(["cursor", "claude", "vscode"]);
		const seed = mcpSection.read(s);
		const back = mcpSection.write(s, seed);
		expect(back.mcp.allowedClients).toEqual(["cursor", "claude", "vscode"]);
	});

	it("an empty list round-trips", () => {
		const seed = mcpSection.read(defaultSettings());
		expect(mcpSection.write(defaultSettings(), seed).mcp.allowedClients).toEqual([]);
	});
});

describe("CONFIG_SECTIONS registry", () => {
	it("keys the mcp section by id", () => {
		expect(CONFIG_SECTIONS.mcp).toBe(mcpSection);
	});

	it("has exactly the mcp section", () => {
		expect(Object.keys(CONFIG_SECTIONS).sort()).toEqual(["mcp"]);
	});
});
