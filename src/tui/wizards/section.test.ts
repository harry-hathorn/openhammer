import { describe, expect, it } from "vitest";
import { type ConfigSection, mcpSection } from "../../config/sections.ts";
import { defaultSettings, type Settings } from "../../config/settings.ts";
import { BANNER } from "../banner.ts";
import type { ConfigField } from "../schema.ts";
import type { WizardIo } from "../wizard.ts";
import { seedDefaults, setSection } from "./section.ts";

/**
 * A recording fake {@link WizardIo} — no TTY, no clack. Each primitive shifts its
 * next answer from a per-kind queue (`null` simulates cancel); the section wizard
 * consumes `select` first (the section id) then the field primitives in declaration
 * order (driven by `runWizard`). Mirrors channel.test.ts's per-method shape so every
 * method returns only its own type — no casts.
 */
function fakeIo(returns: {
	select?: (string | null)[];
	text?: (string | null)[];
	password?: (string | null)[];
	confirm?: (boolean | null)[];
}): WizardIo {
	const take = <T>(arr: T[] | undefined): T | null => {
		if (!arr || arr.length === 0) return null;
		const v = arr.shift();
		return v === undefined ? null : v;
	};
	return {
		async select() {
			return take(returns.select);
		},
		async text() {
			return take(returns.text);
		},
		async password() {
			return take(returns.password);
		},
		async confirm() {
			return take(returns.confirm);
		},
		intro() {},
		outro() {},
	};
}

/** A recording BannerStream — captures bytes exactly like banner.test.ts / channel.test.ts. */
function fakeStream(): { stream: { write(c: string | Uint8Array): boolean }; written: () => string } {
	let out = "";
	const stream = {
		write(c: string | Uint8Array): boolean {
			out += typeof c === "string" ? c : Buffer.from(c).toString("utf8");
			return true;
		},
	};
	return { stream, written: () => out };
}

describe("seedDefaults", () => {
	it("overrides a text field's default from the seed string", () => {
		const fields: ConfigField[] = [{ key: "name", label: "name", kind: "text" }];
		const seeded = seedDefaults(fields, { name: "current" });
		const f = seeded[0];
		expect(f).toBeDefined();
		expect(f && f.kind === "text" && f.default).toBe("current");
	});

	it("coerces a confirm field's true/false seed string back to a boolean", () => {
		const fields: ConfigField[] = [{ key: "on", label: "on", kind: "confirm" }];
		expect(seedDefaults(fields, { on: "true" })[0]).toMatchObject({ kind: "confirm", default: true });
		expect(seedDefaults(fields, { on: "false" })[0]).toMatchObject({ kind: "confirm", default: false });
	});

	it("leaves a field unchanged when the seed omits its key", () => {
		const field: ConfigField = { key: "name", label: "name", kind: "text", default: "preset" };
		const seeded = seedDefaults([field], {});
		expect(seeded[0]).toBe(field); // same reference — untouched
	});

	it("is non-destructive (returns new field objects)", () => {
		const field: ConfigField = { key: "name", label: "name", kind: "text" };
		const seeded = seedDefaults([field], { name: "x" });
		expect(seeded[0]).not.toBe(field); // new object
		expect(field).toMatchObject({ key: "name", kind: "text" }); // original has no default
	});
});

describe("setSection — happy path", () => {
	it("seeds + applies the mcp section and returns the updated Settings", async () => {
		const { stream, written } = fakeStream();
		const io = fakeIo({ select: ["mcp"], text: ["cursor, claude"] });

		const result = await setSection(defaultSettings(), { io, stream, sections: [mcpSection] });

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.value.mcp.allowedClients).toEqual(["cursor", "claude"]);
			// Non-mcp fields preserved (immutable update over the whole doc).
			expect(result.value.channels).toEqual([]);
			expect(result.value.version).toBe(defaultSettings().version);
		}
		// runWizard printed the banner once (framing the field phase) to the injected stream.
		expect(written()).toBe(`${BANNER}\n`);
	});

	it("seeds the current list so the operator edits it", async () => {
		// The seeded default would carry "cursor"; an empty answer keeps it via reduceFields.
		const current: Settings = { ...defaultSettings(), mcp: { allowedClients: ["cursor"] } };
		const io = fakeIo({ select: ["mcp"], text: [""] }); // submit empty

		const result = await setSection(current, { io, stream: fakeStream().stream, sections: [mcpSection] });

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			// Empty submit + seeded default → "cursor" is kept (the edit-existing UX).
			expect(result.value.mcp.allowedClients).toEqual(["cursor"]);
		}
	});
});

describe("setSection — no-write paths", () => {
	it("returns null when the operator cancels the section select", async () => {
		const result = await setSection(defaultSettings(), {
			io: fakeIo({ select: [null] }),
			stream: fakeStream().stream,
			sections: [mcpSection],
		});
		expect(result).toBeNull();
	});

	it("returns null when the operator cancels a field", async () => {
		const result = await setSection(defaultSettings(), {
			io: fakeIo({ select: ["mcp"], text: [null] }),
			stream: fakeStream().stream,
			sections: [mcpSection],
		});
		expect(result).toBeNull();
	});

	it("returns err when the registry has no sections", async () => {
		const result = await setSection(defaultSettings(), {
			io: fakeIo({}),
			stream: fakeStream().stream,
			sections: [],
		});
		expect(result).toMatchObject({ ok: false, error: { message: "No settings sections are registered" } });
	});
});

describe("setSection — scalability seam (a fake section needs no wizard change)", () => {
	it("drives a foreign section through read → seed → write unchanged", async () => {
		let writtenVals: Record<string, string> | null = null;
		const fake: ConfigSection = {
			id: "misc",
			label: "Miscellaneous",
			fields: [
				{ key: "title", label: "title", kind: "text", required: true },
				{ key: "enabled", label: "enabled", kind: "confirm" },
			],
			read: () => ({ title: "old", enabled: "false" }),
			write: (_s, vals) => {
				writtenVals = vals;
				return defaultSettings();
			},
		};
		const io = fakeIo({ select: ["misc"], text: ["new"], confirm: [true] });

		const result = await setSection(defaultSettings(), {
			io,
			stream: fakeStream().stream,
			sections: [fake],
		});

		expect(result).toMatchObject({ ok: true });
		// confirm was seeded to false then answered true → reduced to "true".
		expect(writtenVals).toEqual({ title: "new", enabled: "true" });
	});
});
