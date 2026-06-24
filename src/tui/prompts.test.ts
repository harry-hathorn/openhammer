import type { Terminal } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { BANNER } from "./banner.ts";
import {
	askConfirm,
	askSecret,
	askSelect,
	askText,
	createDefaultIo,
	flagIo,
	MaskedInput,
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

/**
 * A fake pi-tui `Terminal` — the `prompt-loop.test.ts` shape, reproduced inline
 * (the 19f per-file-fakes convention). Implements the full `Terminal` interface
 * honestly (no `as`): cursor/clear/title/progress ops are inert; what matters is
 * `start` (raw-mode entry), `stop` (restore), and `send` (drive a keystroke into
 * the TUI's input handler).
 */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	private inputHandler: ((data: string) => void) | undefined;

	start(onInput: (data: string) => void): void {
		this.inputHandler = onInput;
	}

	stop(): void {
		this.inputHandler = undefined; // detach — no keys arrive after restore
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(): void {}

	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}

	/** Simulate a keypress reaching the TUI's input handler. */
	send(data: string): void {
		this.inputHandler?.(data);
	}
}

/** A discarding `BannerStream` sink so the hermetic trio writes nothing to stdout. */
const silentStream = { write: (): boolean => true };

/** `createDefaultIo` wired to a fake terminal — drive real components via `runPrompt`. */
function ioWith(terminal: FakeTerminal) {
	return createDefaultIo({ terminal, stdout: silentStream });
}

describe("MaskedInput — masking (the only new render logic)", () => {
	it("shows one dot per glyph and never leaks the value", () => {
		const input = new MaskedInput();
		input.setValue("hunter2");
		const [line] = input.render(80);
		expect(line).toContain("•".repeat("hunter2".length));
		// The secret itself must not appear anywhere in the rendered frame.
		expect(input.render(80).join("")).not.toContain("hunter2");
	});

	it("renders just the caret when the value is empty", () => {
		const input = new MaskedInput();
		const [line] = input.render(80);
		expect(line).toContain("> ");
		expect(line).not.toContain("•");
	});

	it("caps the dot count to the available width (no line overflow)", () => {
		const input = new MaskedInput();
		input.setValue("x".repeat(100)); // far wider than a 20-col terminal
		const [line] = input.render(20); // 20 cols → "> " (2) leaves 18, minus 1 for caret = 17 dots
		expect(line).toContain("•".repeat(17));
		expect(input.render(20).join("")).not.toContain("x".repeat(2)); // the value itself never renders
	});

	it("falls back to the bare prompt when the terminal is too narrow", () => {
		const input = new MaskedInput();
		input.setValue("secret");
		expect(input.render(1)).toEqual(["> "]); // 1 col → no room for the prompt even
	});
});

describe("createDefaultIo — pi-tui wiring via runPrompt", () => {
	it("select: Enter confirms the first option's value", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.select({
			message: "Pick",
			options: [
				{ value: "ngrok", label: "ngrok" },
				{ value: "cloudflare", label: "cloudflare" },
			],
		});
		term.send("\r"); // Enter → onSelect(first)
		await expect(promise).resolves.toBe("ngrok");
	});

	it("select: Down then Enter confirms the second option", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.select({
			message: "Pick",
			options: [
				{ value: "ngrok", label: "ngrok" },
				{ value: "cloudflare", label: "cloudflare" },
			],
		});
		term.send("\x1b[B"); // Down
		term.send("\r"); // Enter
		await expect(promise).resolves.toBe("cloudflare");
	});

	it("select: Escape cancels → null", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.select({ message: "Pick", options: [{ value: "a", label: "A" }] });
		term.send("\x1b"); // Escape → onCancel
		await expect(promise).resolves.toBeNull();
	});

	it("confirm: Enter (Yes) → true", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.confirm({ message: "Continue?" });
		term.send("\r");
		await expect(promise).resolves.toBe(true);
	});

	it("confirm: Down then Enter (No) → false", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.confirm({ message: "Continue?" });
		term.send("\x1b[B"); // Down → "No"
		term.send("\r");
		await expect(promise).resolves.toBe(false);
	});

	it("confirm: Escape cancels → null (not false)", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.confirm({ message: "Continue?" });
		term.send("\x1b");
		await expect(promise).resolves.toBeNull();
	});

	it("text: typing then Enter submits the value", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.text({ message: "Name" });
		for (const ch of "ada") {
			term.send(ch);
		}
		term.send("\r");
		await expect(promise).resolves.toBe("ada");
	});

	it("password: typing then Enter submits the value (round-trip)", async () => {
		const term = new FakeTerminal();
		const io = ioWith(term);
		const promise = io.password({ message: "Token" });
		for (const ch of "s3cr3t") {
			term.send(ch);
		}
		term.send("\r");
		await expect(promise).resolves.toBe("s3cr3t");
	});
});
