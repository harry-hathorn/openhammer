import { describe, expect, it } from "vitest";
import { BANNER } from "./banner.ts";
import type { ConfigField } from "./schema.ts";
import { reduceFields, runWizard, type WizardIo } from "./wizard.ts";

/**
 * A recording fake {@link WizardIo} — no TTY, no clack. Each primitive shifts its
 * next answer from a per-kind array (mirrors prompts.test.ts's per-method shape,
 * so every method returns only its own type — no casts); `null` simulates a
 * cancel. Every prompt call is recorded so dispatch + default-threading are
 * asserted directly.
 */
interface PromptCall {
	method: "text" | "password" | "select" | "confirm";
	message: string;
	defaultValue?: string;
	initialValue?: string | boolean;
	options?: { value: string; label?: string; hint?: string }[];
}

function makeFakeIo(
	returns: {
		select?: (string | null)[];
		text?: (string | null)[];
		password?: (string | null)[];
		confirm?: (boolean | null)[];
	} = {},
): { io: WizardIo; prompts: PromptCall[]; intros: (string | undefined)[]; outros: (string | undefined)[] } {
	const prompts: PromptCall[] = [];
	const intros: (string | undefined)[] = [];
	const outros: (string | undefined)[] = [];
	const take = <T>(arr: T[] | undefined): T | null => {
		if (!arr || arr.length === 0) return null;
		const v = arr.shift();
		return v === undefined ? null : v;
	};
	const io: WizardIo = {
		async select(o) {
			prompts.push({ method: "select", message: o.message, initialValue: o.initialValue, options: o.options });
			return take(returns.select);
		},
		async text(o) {
			prompts.push({ method: "text", message: o.message, defaultValue: o.defaultValue });
			return take(returns.text);
		},
		async password(o) {
			prompts.push({ method: "password", message: o.message });
			return take(returns.password);
		},
		async confirm(o) {
			prompts.push({ method: "confirm", message: o.message, initialValue: o.initialValue });
			return take(returns.confirm);
		},
		intro: (t) => {
			intros.push(t);
		},
		outro: (m) => {
			outros.push(m);
		},
	};
	return { io, prompts, intros, outros };
}

/** A recording BannerStream — captures bytes exactly like banner.test.ts. */
function fakeStream(): { stream: { write(chunk: string | Uint8Array): boolean }; written: () => string } {
	let out = "";
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		},
	};
	return { stream, written: () => out };
}

describe("reduceFields — pure state machine", () => {
	it("passes through non-empty answers keyed by field.key", () => {
		const fields: ConfigField[] = [
			{ key: "name", label: "Name", kind: "text" },
			{ key: "mode", label: "Mode", kind: "select", options: [{ value: "a", label: "A" }] },
		];
		expect(reduceFields(fields, { name: "pi", mode: "a" })).toEqual({ name: "pi", mode: "a" });
	});

	it("coerces confirm booleans to true/false strings", () => {
		const fields: ConfigField[] = [{ key: "tls", label: "TLS?", kind: "confirm" }];
		expect(reduceFields(fields, { tls: true })).toEqual({ tls: "true" });
		expect(reduceFields(fields, { tls: false })).toEqual({ tls: "false" });
	});

	it("uses confirm.default when no answer is present", () => {
		const fields: ConfigField[] = [{ key: "tls", label: "TLS?", kind: "confirm", default: true }];
		expect(reduceFields(fields, {})).toEqual({ tls: "true" });
	});

	it("trims whitespace from text/secret answers", () => {
		const fields: ConfigField[] = [{ key: "name", label: "Name", kind: "text" }];
		expect(reduceFields(fields, { name: "  pi  " })).toEqual({ name: "pi" });
	});

	it("falls back to default for a blank answer; leaves an optional blank as empty", () => {
		const fields: ConfigField[] = [
			{ key: "region", label: "Region", kind: "text", default: "us-east" },
			{ key: "note", label: "Note", kind: "text" },
		];
		expect(reduceFields(fields, { region: "   ", note: "" })).toEqual({ region: "us-east", note: "" });
	});

	it("returns null when a required field is blank with no default", () => {
		const fields: ConfigField[] = [{ key: "token", label: "Token", kind: "secret", required: true }];
		expect(reduceFields(fields, { token: "" })).toBeNull();
	});

	it("does not treat a required field with a default as blank", () => {
		const fields: ConfigField[] = [{ key: "region", label: "Region", kind: "text", required: true, default: "us" }];
		expect(reduceFields(fields, { region: "" })).toEqual({ region: "us" });
	});
});

describe("runWizard — rendering layer", () => {
	it("dispatches each kind to its primitive and threads defaults", async () => {
		const fields: ConfigField[] = [
			{ key: "name", label: "Name", kind: "text", default: "anon" },
			{ key: "token", label: "Token", kind: "secret" },
			{
				key: "mode",
				label: "Mode",
				kind: "select",
				options: [
					{ value: "a", label: "A" },
					{ value: "b", label: "B" },
				],
				default: "b",
			},
			{ key: "tls", label: "TLS?", kind: "confirm", default: true },
		];
		const { io, prompts } = makeFakeIo({ text: ["pi"], password: ["shh"], select: ["a"], confirm: [false] });
		await expect(runWizard("Add a channel", fields, io, { stream: fakeStream().stream })).resolves.toEqual({
			name: "pi",
			token: "shh",
			mode: "a",
			tls: "false",
		});
		expect(prompts.map((p) => p.method)).toEqual(["text", "password", "select", "confirm"]);
		expect(prompts.map((p) => p.message)).toEqual(["Name", "Token", "Mode", "TLS?"]);
		// field defaults threaded into the prompt options
		expect(prompts[0]?.defaultValue).toBe("anon");
		expect(prompts[2]?.initialValue).toBe("b");
		expect(prompts[3]?.initialValue).toBe(true);
	});

	it("returns null and stops walking on the first cancel", async () => {
		const fields: ConfigField[] = [
			{ key: "a", label: "A", kind: "text" },
			{ key: "b", label: "B", kind: "text" },
			{ key: "c", label: "C", kind: "text" },
		];
		const { io, prompts } = makeFakeIo({ text: ["x", null, "y"] });
		await expect(runWizard("t", fields, io, { stream: fakeStream().stream })).resolves.toBeNull();
		expect(prompts).toHaveLength(2); // the 3rd field is never asked
	});

	it("returns null when a required field is left empty", async () => {
		const fields: ConfigField[] = [{ key: "token", label: "Token", kind: "secret", required: true }];
		const { io } = makeFakeIo({ password: [""] });
		await expect(runWizard("t", fields, io, { stream: fakeStream().stream })).resolves.toBeNull();
	});

	it("frames the run with the banner + intro(title) + outro", async () => {
		const fields: ConfigField[] = [{ key: "x", label: "X", kind: "text" }];
		const { io, intros, outros } = makeFakeIo({ text: ["v"] });
		const { stream, written } = fakeStream();
		await runWizard("Add a channel", fields, io, { stream });
		expect(written()).toBe(`${BANNER}\n`);
		expect(intros).toEqual(["Add a channel"]);
		expect(outros).toHaveLength(1);
	});
});
