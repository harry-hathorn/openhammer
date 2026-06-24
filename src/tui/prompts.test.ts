import { describe, expect, it } from "vitest";
import { BANNER } from "./banner.ts";
import {
	askConfirm,
	askSecret,
	askSelect,
	askText,
	flagIo,
	type PromptIo,
	type SelectOption,
	withSession,
} from "./prompts.ts";

/**
 * A recording fake `PromptIo` — no TTY, no clack. `returns` controls each
 * primitive's resolved value (`null` simulates a cancel). Every call is
 * captured in `calls` so the adapters' forwarding is asserted directly.
 */
function fakeIo(
	returns: { select?: string | null; text?: string | null; password?: string | null; confirm?: boolean | null } = {},
): { io: PromptIo; calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = {
		select: [],
		text: [],
		password: [],
		confirm: [],
		intro: [],
		outro: [],
	};
	const io: PromptIo = {
		select: async (o) => {
			calls.select.push(o);
			return returns.select ?? null;
		},
		text: async (o) => {
			calls.text.push(o);
			return returns.text ?? null;
		},
		password: async (o) => {
			calls.password.push(o);
			return returns.password ?? null;
		},
		confirm: async (o) => {
			calls.confirm.push(o);
			return returns.confirm ?? null;
		},
		intro: (t) => {
			calls.intro.push(t);
		},
		outro: (m) => {
			calls.outro.push(m);
		},
	};
	return { io, calls };
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

describe("prompts — askSelect", () => {
	it("forwards options to io.select and returns the chosen value", async () => {
		const options: SelectOption[] = [
			{ value: "ngrok", label: "ngrok" },
			{ value: "cloudflare", label: "Cloudflare" },
		];
		const { io, calls } = fakeIo({ select: "ngrok" });
		await expect(askSelect({ message: "Channel?", options }, io)).resolves.toBe("ngrok");
		expect(calls.select).toEqual([{ message: "Channel?", options, initialValue: undefined }]);
	});

	it("returns null when the user cancels", async () => {
		const { io } = fakeIo({ select: null });
		await expect(askSelect({ message: "x", options: [{ value: "a", label: "A" }] }, io)).resolves.toBeNull();
	});
});

describe("prompts — askText", () => {
	it("maps the label to a message and forwards to io.text", async () => {
		const { io, calls } = fakeIo({ text: "hello" });
		await expect(askText("Your name", io)).resolves.toBe("hello");
		expect(calls.text).toEqual([{ message: "Your name" }]);
	});

	it("returns null when the user cancels", async () => {
		const { io } = fakeIo({ text: null });
		await expect(askText("x", io)).resolves.toBeNull();
	});
});

describe("prompts — askSecret", () => {
	it("maps the label to a message and forwards to io.password", async () => {
		const { io, calls } = fakeIo({ password: "shh" });
		await expect(askSecret("Token", io)).resolves.toBe("shh");
		expect(calls.password).toEqual([{ message: "Token" }]);
	});

	it("returns null when the user cancels", async () => {
		const { io } = fakeIo({ password: null });
		await expect(askSecret("x", io)).resolves.toBeNull();
	});
});

describe("prompts — askConfirm", () => {
	it("maps the label to a message and forwards to io.confirm", async () => {
		const { io, calls } = fakeIo({ confirm: true });
		await expect(askConfirm("Continue?", io)).resolves.toBe(true);
		expect(calls.confirm).toEqual([{ message: "Continue?" }]);
	});

	it("returns null when the user cancels", async () => {
		const { io } = fakeIo({ confirm: null });
		await expect(askConfirm("x", io)).resolves.toBeNull();
	});
});

describe("prompts — withSession", () => {
	it("prints the banner, intros with the title, runs fn, then outros", async () => {
		const { io, calls } = fakeIo();
		const { stream, written } = fakeStream();
		const result = await withSession("Add a channel", async () => "done", { io, stream });
		expect(result).toBe("done");
		// banner printed byte-for-byte (with its trailing newline) before intro
		expect(written()).toBe(`${BANNER}\n`);
		expect(calls.intro).toEqual(["Add a channel"]);
		expect(calls.outro).toEqual([undefined]);
	});

	it("runs outro even when fn returns a cancelled (null) result", async () => {
		const { io, calls } = fakeIo();
		const { stream } = fakeStream();
		await expect(withSession("x", async () => null, { io, stream })).resolves.toBeNull();
		expect(calls.outro).toHaveLength(1);
	});

	it("runs outro (cleanup) even when fn throws, then rethrows", async () => {
		const { io, calls } = fakeIo();
		const { stream } = fakeStream();
		await expect(
			withSession(
				"x",
				async () => {
					throw new Error("boom");
				},
				{ io, stream },
			),
		).rejects.toThrow("boom");
		expect(calls.outro).toHaveLength(1);
	});
});

describe("prompts — flagIo (non-interactive seam, spec 20g)", () => {
	it("resolves each primitive by its message (the flag value)", async () => {
		const io = flagIo({ "Channel type": "ngrok", "ngrok authtoken": "T0KEN" });
		await expect(io.select({ message: "Channel type", options: [] })).resolves.toBe("ngrok");
		await expect(io.password({ message: "ngrok authtoken" })).resolves.toBe("T0KEN");
	});

	it("`select` returns null when the message is absent (picker not supplied)", async () => {
		const io = flagIo({});
		await expect(io.select({ message: "Channel type", options: [] })).resolves.toBeNull();
	});

	it("`password` returns null when the message is absent (a required secret missing its flag)", async () => {
		const io = flagIo({});
		await expect(io.password({ message: "ngrok authtoken" })).resolves.toBeNull();
	});

	it("`text` falls back to the seeded default so an unspecified field is left unchanged (not cancel)", async () => {
		const io = flagIo({ "Allowed clients": "claude-code" });
		// The target field resolves to its flag value…
		await expect(io.text({ message: "Allowed clients", defaultValue: "old" })).resolves.toBe("claude-code");
		// …an unspecified field keeps its seeded current value (the default), not null.
		await expect(io.text({ message: "Other field", defaultValue: "current" })).resolves.toBe("current");
		await expect(io.text({ message: "No default" })).resolves.toBe("");
	});

	it('`confirm` reads `"true"`/`"false"` from the answers, else the seeded initialValue', async () => {
		const io = flagIo({ "Make default": "true" });
		await expect(io.confirm({ message: "Make default" })).resolves.toBe(true);
		const io2 = flagIo({ "Make default": "false" });
		await expect(io2.confirm({ message: "Make default" })).resolves.toBe(false);
		const io3 = flagIo({});
		await expect(io3.confirm({ message: "x", initialValue: true })).resolves.toBe(true);
		await expect(io3.confirm({ message: "x" })).resolves.toBeNull();
	});

	it("intro/outro are no-ops (no banner, no clack framing)", async () => {
		const io = flagIo({});
		expect(() => io.intro("x")).not.toThrow();
		expect(() => io.outro()).not.toThrow();
	});
});
