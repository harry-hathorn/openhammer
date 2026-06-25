import {
	type Component,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type Terminal,
} from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { type PromptMounter, runPrompt, runSpinner } from "./prompt-loop.ts";

/**
 * A passthrough `SelectListTheme` so a real `SelectList` renders without pulling
 * in the pi-tui color/theme layer — every theme fn is identity. The prompt
 * adapter does not depend on theming; 21b supplies the production theme.
 */
const passthroughTheme: SelectListTheme = {
	selectedPrefix: (text) => text,
	selectedText: (text) => text,
	description: (text) => text,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

/**
 * A fake pi-tui `Terminal` — the `render.test.ts` shape, reproduced inline (the
 * 19f "fakes per file" convention). Implements the full `Terminal` interface
 * honestly (no `as` cast): the cursor/clear/title/progress ops are inert; what
 * matters is `start` (raw-mode entry), `stop` (restore), `write` (rendered
 * output), and the `send`/`resize` drivers that simulate keys + resizing.
 */
class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	readonly writes: string[] = [];
	started = false;
	stopped = false;
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.started = true;
		this.stopped = false;
	}

	stop(): void {
		// Mirror ProcessTerminal.stop(): detach handlers so no keys arrive after
		// restore (the stdin "data" listener is removed in real stop()).
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
		this.stopped = true;
		this.started = false;
	}

	drainInput(): Promise<void> {
		return Promise.resolve();
	}

	write(data: string): void {
		this.writes.push(data);
	}

	// Inert cursor/clear/title/progress ops (fewer params than the interface
	// declares is fine — the adapter only reads writes + drives start/send/stop).
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

	/** Simulate a terminal resize (and report the new size to the TUI). */
	resize(columns: number, rows: number): void {
		this.columns = columns;
		this.rows = rows;
		this.resizeHandler?.();
	}

	/** All bytes written so far, joined (handy for substring asserts on frames). */
	output(): string {
		return this.writes.join("");
	}
}

/**
 * A minimal `Component` for testing the adapter's mechanics in isolation: on a
 * "confirm" key (`\r`) it fires the constructor's callback, on a "cancel" key
 * (`\x1b`/`\x03`) it fires `onCancel`. Renders one line so a render landed can
 * be asserted. Keeps the loop/callback/teardown behavior testable without a
 * real pi-tui interactive component.
 */
class FakePromptComponent implements Component {
	private readonly onConfirm: () => void;
	private readonly onCancel: () => void;
	private readonly line: string;

	constructor(onConfirm: () => void, onCancel: () => void, line = "fake prompt") {
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
		this.line = line;
	}

	handleInput(data: string): void {
		if (data === "\r") {
			this.onConfirm();
		} else if (data === "\x1b" || data === "\x03") {
			this.onCancel();
		}
	}

	render(): string[] {
		return [this.line];
	}

	invalidate(): void {}
}

/** Two-item picker fixture reused across the SelectList integration tests. */
const pickerItems: SelectItem[] = [
	{ value: "ngrok", label: "ngrok" },
	{ value: "cloudflare", label: "cloudflare" },
];

/** Mount a real SelectList wired through `runPrompt`. */
function mountSelectList(resolve: (value: string | null) => void): SelectList {
	const list = new SelectList(pickerItems, 10, passthroughTheme);
	list.onSelect = (item) => resolve(item.value);
	list.onCancel = () => resolve(null);
	return list;
}

/**
 * Flush pi-tui's async render scheduling (the `render.test.ts` helper). A render
 * is `requestRender` → `setTimeout` coalesced to ≥16ms (`MIN_RENDER_INTERVAL_MS`),
 * so wait past that throttle before asserting a frame landed.
 */
async function flush(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 25));
}

describe("runPrompt — lifecycle + teardown", () => {
	it("resolves the value the component passes to resolve, then restores the terminal", async () => {
		const term = new FakeTerminal();
		const mount: PromptMounter<string> = (resolve) =>
			new FakePromptComponent(
				() => resolve("done"),
				() => resolve(null),
			);

		const promise = runPrompt(mount, { terminal: term });
		// The body up to `await completion` is synchronous: raw mode entered, no restore yet.
		expect(term.started).toBe(true);
		expect(term.stopped).toBe(false);

		term.send("\r"); // confirm → resolve("done")

		expect(await promise).toBe("done");
		expect(term.stopped).toBe(true); // finally → tui.stop() restored the terminal
	});

	it("renders the mounted component (the loop drew at least one frame)", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt(
			(resolve) =>
				new FakePromptComponent(
					() => resolve("ok"),
					() => resolve(null),
					"rendered-line",
				),
			{ terminal: term },
		);
		await flush(); // let the start() requestRender land

		expect(term.output()).toContain("rendered-line");

		term.send("\r"); // complete so the loop tears down cleanly
		await promise;
		expect(term.stopped).toBe(true);
	});

	it("renders the `header` above the component (so a bare Input isn't a blank modal)", async () => {
		// The issue-client label / wizard field labels must appear in the modal —
		// otherwise a bare Input (`> `) with no visible question looks blank.
		const term = new FakeTerminal();
		const promise = runPrompt(
			(resolve) =>
				new FakePromptComponent(
					() => resolve("ok"),
					() => resolve(null),
				),
			{ terminal: term, header: "Label (optional)" },
		);
		await flush();
		expect(term.output()).toContain("Label (optional)"); // header rendered
		expect(term.output()).toContain("fake prompt"); // component rendered below it

		term.send("\r");
		await promise;
	});

	it("stop() is called exactly once (idempotent teardown — no double-restore)", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt(
			(resolve) =>
				new FakePromptComponent(
					() => resolve("ok"),
					() => resolve(null),
				),
			{ terminal: term },
		);
		term.send("\r");
		await promise;
		expect(term.stopped).toBe(true);
		// A settled prompt is fully torn down; nothing further happens.
		expect(term.started).toBe(false);
	});
});

describe("runPrompt — cancel restores the terminal (no raw-mode leak)", () => {
	it("Ctrl-C (\\x03) cancels → null + terminal restored", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(mountSelectList, { terminal: term });
		expect(term.started).toBe(true);

		term.send("\x03"); // Ctrl-C → SelectList.onCancel

		expect(await promise).toBeNull();
		expect(term.stopped).toBe(true);
	});

	it("Escape (\\x1b) cancels → null + terminal restored", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(mountSelectList, { terminal: term });

		term.send("\x1b"); // Escape → SelectList.onCancel

		expect(await promise).toBeNull();
		expect(term.stopped).toBe(true);
	});
});

describe("runPrompt — error paths", () => {
	it("a mount that throws rejects and never enters raw mode (no stop)", async () => {
		const term = new FakeTerminal();
		const err = new Error("mount boom");
		const promise = runPrompt<string>(
			() => {
				throw err;
			},
			{ terminal: term },
		);

		await expect(promise).rejects.toBe(err);
		expect(term.started).toBe(false); // start() never reached
		expect(term.stopped).toBe(false); // finally skipped stop() (started === false)
	});

	it("resolves once even if the component fires resolve twice (settled guard)", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(
			(resolve) => {
				// A misbehaving component that resolves on confirm AND immediately again.
				return new FakePromptComponent(
					() => {
						resolve("first");
						resolve("second");
					},
					() => resolve(null),
				);
			},
			{ terminal: term },
		);

		term.send("\r");

		expect(await promise).toBe("first"); // second call is a no-op
		expect(term.stopped).toBe(true);
	});
});

describe("runPrompt — real pi-tui components (integration)", () => {
	it("drives a real SelectList: Enter confirms the first item's value", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(mountSelectList, { terminal: term });

		term.send("\r"); // Enter (tui.select.confirm) → onSelect(first)

		expect(await promise).toBe("ngrok");
		expect(term.stopped).toBe(true);
	});

	it("drives a real SelectList: Down then Enter confirms the second item", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(mountSelectList, { terminal: term });

		term.send("\x1b[B"); // Down arrow → selectedIndex 1
		term.send("\r"); // Enter → onSelect(second)

		expect(await promise).toBe("cloudflare");
		expect(term.stopped).toBe(true);
	});

	it("drives a real Input: typing then Enter submits the accumulated value", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(
			(resolve) => {
				const input = new Input();
				input.onSubmit = (value) => resolve(value);
				input.onEscape = () => resolve(null);
				return input;
			},
			{ terminal: term },
		);

		for (const ch of "hello") {
			term.send(ch);
		}
		term.send("\r"); // Enter (tui.input.submit) → onSubmit("hello")

		expect(await promise).toBe("hello");
		expect(term.stopped).toBe(true);
	});

	it("drives a real Input: Escape cancels → null", async () => {
		const term = new FakeTerminal();
		const promise = runPrompt<string>(
			(resolve) => {
				const input = new Input();
				input.onSubmit = (value) => resolve(value);
				input.onEscape = () => resolve(null);
				return input;
			},
			{ terminal: term },
		);

		for (const ch of "nope") {
			term.send(ch);
		}
		term.send("\x1b"); // Escape → onEscape

		expect(await promise).toBeNull();
		expect(term.stopped).toBe(true);
	});
});

/**
 * The spinner's `Result`-shaped test result + formatter — mirrors the channel
 * wizard's probe contract (`Result<T, Error>` → `✓`/`✗`) without importing the
 * domain module, keeping `runSpinner`'s tests domain-free like the helper itself.
 */
type ProbeOutcome = { ok: true; value: string } | { ok: false; message: string };
const probeFormatter =
	(label: string) =>
	(r: ProbeOutcome): string =>
		r.ok ? `✓ ${label}` : `✗ ${r.message}`;

describe("runSpinner — probe spinner (spec 21c — the ora replacement)", () => {
	it("returns fn's result unchanged and restores the terminal", async () => {
		const term = new FakeTerminal();
		const result = await runSpinner<ProbeOutcome>(
			"Validating nginx…",
			async () => ({ ok: true, value: "up" }),
			probeFormatter("Validating nginx…"),
			{ terminal: term },
		);

		expect(result).toEqual({ ok: true, value: "up" });
		expect(term.stopped).toBe(true); // finally → tui.stop() restored the terminal
		expect(term.started).toBe(false); // stop() reset the started flag
	});

	it("paints the spinner label while the probe runs (the loader animated)", async () => {
		const term = new FakeTerminal();
		let midRunOutput = "";
		await runSpinner<ProbeOutcome>(
			"Validating nginx…",
			async () => {
				// Hold long enough for the first coalesced render (~16ms) to paint the
				// spinner label before the probe resolves.
				await new Promise((resolve) => setTimeout(resolve, 30));
				midRunOutput = term.output();
				return { ok: true, value: "up" };
			},
			probeFormatter("Validating nginx…"),
			{ terminal: term },
		);

		expect(midRunOutput).toContain("Validating nginx…"); // label was on screen mid-probe
		expect(term.stopped).toBe(true);
	});

	it("overwrites the spinner with the ✓ status line on success", async () => {
		const term = new FakeTerminal();
		await runSpinner<ProbeOutcome>(
			"Validating nginx…",
			async () => ({ ok: true, value: "up" }),
			probeFormatter("Validating nginx…"),
			{ terminal: term },
		);

		expect(term.output()).toContain("✓ Validating nginx…");
		expect(term.stopped).toBe(true);
	});

	it("overwrites the spinner with the ✗ status line on failure", async () => {
		const term = new FakeTerminal();
		await runSpinner<ProbeOutcome>(
			"Validating nginx…",
			async () => ({ ok: false, message: "publicUrl /health returned 502" }),
			probeFormatter("Validating nginx…"),
			{ terminal: term },
		);

		expect(term.output()).toContain("✗ publicUrl /health returned 502");
		expect(term.stopped).toBe(true);
	});

	it("restores the terminal even if fn throws (no raw-mode leak)", async () => {
		const term = new FakeTerminal();
		const boom = new Error("probe exploded");
		await expect(
			runSpinner<ProbeOutcome>(
				"Validating nginx…",
				async () => {
					throw boom;
				},
				probeFormatter("Validating nginx…"),
				{ terminal: term },
			),
		).rejects.toBe(boom);

		expect(term.stopped).toBe(true); // finally restored the terminal before rethrowing
	});
});
