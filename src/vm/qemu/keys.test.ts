import { describe, expect, it } from "vitest";
import {
	type Chord,
	KEY_CHORD_GAP_MS,
	type ParsedKeys,
	parseKeys,
	type SendKeyExchange,
	type SendKeyTransport,
	sendText,
} from "./keys.ts";

/** Assert a parse succeeded and round-tripped to exactly these chords. */
function expectChords(parsed: ParsedKeys, expected: ReadonlyArray<Chord>): void {
	expect(parsed.ok).toBe(true);
	if (parsed.ok) {
		expect(parsed.value).toEqual(expected);
	}
}

/** Assert a parse failed with exactly this message. */
function expectError(parsed: ParsedKeys, message: string): void {
	expect(parsed.ok).toBe(false);
	if (!parsed.ok) {
		expect(parsed.error).toBeInstanceOf(Error);
		expect(parsed.error.message).toBe(message);
	}
}

/** A transport double recording every exchange it is asked to send. */
interface RecordedQmpCall {
	readonly command: string;
	readonly args: Record<string, unknown>;
}

function recordingTransport(): {
	transport: SendKeyTransport;
	qmpCalls: Array<RecordedQmpCall>;
	hmpCommands: Array<string>;
} {
	const qmpCalls: Array<RecordedQmpCall> = [];
	const hmpCommands: Array<string> = [];
	const transport: SendKeyTransport = {
		async execute(command: string, args?: Record<string, unknown>) {
			qmpCalls.push({ command, args: args ?? {} });
			return {};
		},
		async humanMonitorCommand(commandLine: string) {
			hmpCommands.push(commandLine);
			return "";
		},
	};
	return { transport, qmpCalls, hmpCommands };
}

describe("parseKeys", () => {
	describe("plain text", () => {
		it("maps lowercase letters and digits one-to-one", () => {
			expectChords(parseKeys("abc123"), [["a"], ["b"], ["c"], ["1"], ["2"], ["3"]]);
		});

		it("maps uppercase letters to shift chords", () => {
			expectChords(parseKeys("AbC"), [["shift", "a"], ["b"], ["shift", "c"]]);
		});

		it("parses a mixed sentence with a chord inside", () => {
			expectChords(parseKeys("hi<C-x> there"), [
				["h"],
				["i"],
				["ctrl", "x"],
				["spc"],
				["t"],
				["h"],
				["e"],
				["r"],
				["e"],
			]);
		});
	});

	describe("punctuation tables (every entry)", () => {
		it("maps every SHIFTED char to shift + its base key", () => {
			const shifted: Readonly<Record<string, string>> = {
				"!": "1",
				"@": "2",
				"#": "3",
				$: "4",
				"%": "5",
				"^": "6",
				"&": "7",
				"*": "8",
				"(": "9",
				")": "0",
				_: "minus",
				"+": "equal",
				"{": "bracket_left",
				"}": "bracket_right",
				":": "semicolon",
				'"': "apostrophe",
				"~": "grave_accent",
				"|": "backslash",
				"<": "comma",
				">": "dot",
				"?": "slash",
			};
			for (const [char, qcode] of Object.entries(shifted)) {
				// < and > are the grammar's brackets, so as plain typed text they never reach the
				// SHIFTED lookup: "x<" is an unterminated sequence and a bare > cannot sit inside
				// one. A literal < still round-trips wrapped as a single-char sequence; the > entry
				// is asserted through sendText's charChord list in the literal-brackets test below.
				if (char === "<" || char === ">") {
					continue;
				}
				expectChords(parseKeys(`x${char}`), [["x"], ["shift", qcode]]);
			}
			expectChords(parseKeys("<<>"), [["shift", "comma"]]);
		});

		it("maps every UNSHIFTED char to its bare key", () => {
			const unshifted: Readonly<Record<string, string>> = {
				" ": "spc",
				"\n": "ret",
				"\r": "ret",
				"\t": "tab",
				"-": "minus",
				"=": "equal",
				"[": "bracket_left",
				"]": "bracket_right",
				";": "semicolon",
				"'": "apostrophe",
				"`": "grave_accent",
				"\\": "backslash",
				",": "comma",
				".": "dot",
				"/": "slash",
			};
			for (const [char, qcode] of Object.entries(unshifted)) {
				expectChords(parseKeys(`x${char}`), [["x"], [qcode]]);
			}
		});
	});

	describe("whitespace", () => {
		it("maps space, newline, CR, and tab", () => {
			expectChords(parseKeys(" \n\r\t"), [["spc"], ["ret"], ["ret"], ["tab"]]);
		});
	});

	describe("named keys", () => {
		it("maps every documented alias (case-insensitive)", () => {
			const named: Readonly<Record<string, string>> = {
				ENTER: "ret",
				RETURN: "ret",
				CR: "ret",
				RET: "ret",
				ESC: "esc",
				ESCAPE: "esc",
				TAB: "tab",
				BS: "backspace",
				BACKSPACE: "backspace",
				DEL: "delete",
				DELETE: "delete",
				INS: "insert",
				INSERT: "insert",
				SPACE: "spc",
				SPC: "spc",
				UP: "up",
				DOWN: "down",
				LEFT: "left",
				RIGHT: "right",
				HOME: "home",
				END: "end",
				PGUP: "pgup",
				PAGEUP: "pgup",
				PGDN: "pgdn",
				PAGEDOWN: "pgdn",
				LT: "less",
				MENU: "menu",
				CAPSLOCK: "caps_lock",
				NUMLOCK: "num_lock",
				SCROLLLOCK: "scroll_lock",
				PRINT: "print",
				PAUSE: "pause",
				SYSREQ: "sysrq",
				CTRL: "ctrl",
				ALT: "alt",
				SHIFT: "shift",
				META_L: "meta_l",
			};
			for (const [name, qcode] of Object.entries(named)) {
				expectChords(parseKeys(`<${name}>`), [[qcode]]);
			}
			// Lowercase spelling resolves the same (keyName uppercases before lookup).
			expectChords(parseKeys("<enter>"), [["ret"]]);
		});

		it("parses a single character inside brackets through charChord", () => {
			expectChords(parseKeys("<a>"), [["a"]]);
			expectChords(parseKeys("<A>"), [["shift", "a"]]);
			expectChords(parseKeys("<?>"), [["shift", "slash"]]);
		});
	});

	describe("modifier chords", () => {
		it("maps every modifier spelling", () => {
			expectChords(parseKeys("<C-x>"), [["ctrl", "x"]]);
			expectChords(parseKeys("<CTRL-x>"), [["ctrl", "x"]]);
			expectChords(parseKeys("<CONTROL-x>"), [["ctrl", "x"]]);
			expectChords(parseKeys("<A-x>"), [["alt", "x"]]);
			expectChords(parseKeys("<ALT-x>"), [["alt", "x"]]);
			expectChords(parseKeys("<S-a>"), [["shift", "a"]]);
			expectChords(parseKeys("<SHIFT-a>"), [["shift", "a"]]);
			expectChords(parseKeys("<M-b>"), [["meta_l", "b"]]);
			expectChords(parseKeys("<META-b>"), [["meta_l", "b"]]);
		});

		it("stacks multiple modifiers (split parts) before the key", () => {
			expectChords(parseKeys("<C-S-x>"), [["ctrl", "shift", "x"]]);
			expectChords(parseKeys("<A-M-TAB>"), [["alt", "meta_l", "tab"]]);
			expectChords(parseKeys("<C-A-S-DEL>"), [["ctrl", "alt", "shift", "delete"]]);
		});

		it("splits the minus key correctly: C-- is ctrl+minus, not an empty modifier", () => {
			expectChords(parseKeys("<C-->"), [["ctrl", "minus"]]);
			// The bare typed dash is the plain minus key.
			expectChords(parseKeys("-"), [["minus"]]);
		});

		it("expands <GT> to shift+dot, stacking any modifiers first", () => {
			expectChords(parseKeys("<GT>"), [["shift", "dot"]]);
			expectChords(parseKeys("<C-GT>"), [["ctrl", "shift", "dot"]]);
		});
	});

	describe("qcode passthrough", () => {
		it("passes documented qcode tokens through, lowercased", () => {
			expectChords(parseKeys("<f5>"), [["f5"]]);
			expectChords(parseKeys("<F12>"), [["f12"]]);
			expectChords(parseKeys("<kp_enter>"), [["kp_enter"]]);
			expectChords(parseKeys("<KP_Enter>"), [["kp_enter"]]);
			expectChords(parseKeys("<unmapped>"), [["unmapped"]]);
		});

		it("rejects multi-letter tokens that are not qcodes", () => {
			expectError(parseKeys("<xyz>"), 'qemu: unknown key "xyz"');
		});
	});

	describe("errors", () => {
		it("fails on an unsupported character", () => {
			expectError(parseKeys("é"), 'qemu: unsupported character "é"');
		});

		it("fails on an unknown modifier", () => {
			expectError(parseKeys("<Q-x>"), 'qemu: unknown modifier "Q"');
		});

		it("fails on an unterminated key sequence", () => {
			expectError(parseKeys("a<C-x"), "qemu: unterminated key sequence");
		});

		it("fails on an empty key sequence", () => {
			expectError(parseKeys("<>"), "qemu: empty key sequence");
		});
	});

	describe("encoding guard", () => {
		it("rejects any non-oligarchy encoding", () => {
			expectError(parseKeys("a", "wrong"), 'qemu: unknown key encoding "wrong"');
		});

		it("accepts the default, explicit oligarchy (any case), and empty", () => {
			expectChords(parseKeys("a"), [["a"]]);
			expectChords(parseKeys("a", "oligarchy"), [["a"]]);
			expectChords(parseKeys("a", "OLIGARCHY"), [["a"]]);
			expectChords(parseKeys("a", ""), [["a"]]);
		});
	});
});

describe("sendText", () => {
	it("sends the exact QMP send-key sequence for a sample password plus ENTER", async () => {
		const { transport, qmpCalls, hmpCommands } = recordingTransport();
		const result = await sendText(transport, "s3cret!", { chordGapMs: 0 });
		expect(result.chords).toEqual([
			["s"],
			["3"],
			["c"],
			["r"],
			["e"],
			["t"],
			["shift", "1"],
			["ret"], // trailing ENTER
		]);
		expect(qmpCalls).toEqual([
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "s" }] } },
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "3" }] } },
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "c" }] } },
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "r" }] } },
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "e" }] } },
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "t" }] } },
			{
				command: "send-key",
				args: {
					keys: [
						{ type: "qcode", data: "shift" },
						{ type: "qcode", data: "1" },
					],
				},
			},
			{ command: "send-key", args: { keys: [{ type: "qcode", data: "ret" }] } },
		]);
		expect(hmpCommands).toEqual([]);
		expect(result.exchanges.map((exchange) => exchange.channel)).toEqual(
			Array.from({ length: 8 }, () => "qmp-send-key"),
		);
	});

	it("uses the HMP sendkey channel when requested", async () => {
		const { transport, qmpCalls, hmpCommands } = recordingTransport();
		const result = await sendText(transport, "H!", { channel: "hmp-sendkey", chordGapMs: 0 });
		expect(hmpCommands).toEqual(["sendkey shift-h", "sendkey shift-1", "sendkey ret"]);
		expect(qmpCalls).toEqual([]);
		expect(result.exchanges).toEqual([
			{ channel: "hmp-sendkey", args: { "command-line": "sendkey shift-h" } },
			{ channel: "hmp-sendkey", args: { "command-line": "sendkey shift-1" } },
			{ channel: "hmp-sendkey", args: { "command-line": "sendkey ret" } },
		]);
	});

	it("types < and > as literal shifted comma/dot, never as key-sequence brackets", async () => {
		const { transport, qmpCalls } = recordingTransport();
		const result = await sendText(transport, "x<y>z", { chordGapMs: 0 });
		// charChord per character: < is shift+comma, > is shift+dot — data, not grammar.
		expect(result.chords).toEqual([["x"], ["shift", "comma"], ["y"], ["shift", "dot"], ["z"], ["ret"]]);
		expect(qmpCalls.map((call) => call.args)).toEqual([
			{ keys: [{ type: "qcode", data: "x" }] },
			{
				keys: [
					{ type: "qcode", data: "shift" },
					{ type: "qcode", data: "comma" },
				],
			},
			{ keys: [{ type: "qcode", data: "y" }] },
			{
				keys: [
					{ type: "qcode", data: "shift" },
					{ type: "qcode", data: "dot" },
				],
			},
			{ keys: [{ type: "qcode", data: "z" }] },
			{ keys: [{ type: "qcode", data: "ret" }] },
		]);
		// The documented distinction: parseKeys WOULD treat the same characters as brackets.
		expectChords(parseKeys("x<y>z"), [["x"], ["y"], ["z"]]);
	});

	it("reports every exchange through onExchange before it is sent", async () => {
		const { transport } = recordingTransport();
		const seen: SendKeyExchange[] = [];
		const result = await sendText(transport, "ab", {
			chordGapMs: 0,
			onExchange: (exchange) => seen.push(exchange),
		});
		expect(seen).toHaveLength(3);
		expect(seen).toEqual(result.exchanges);
	});

	it("paces one gap between chords and none after the last (chordGapMs honored)", async () => {
		const { transport } = recordingTransport();
		const started = Date.now();
		await sendText(transport, "ab", { chordGapMs: 25 }); // 3 chords → 2 gaps → ≥50ms
		const elapsed = Date.now() - started;
		expect(elapsed).toBeGreaterThanOrEqual(50);
		expect(elapsed).toBeLessThan(5000);
	});

	it("defaults the gap to KEY_CHORD_GAP_MS (60)", async () => {
		const { transport } = recordingTransport();
		const started = Date.now();
		await sendText(transport, "a"); // 2 chords → 1 default gap
		// Small allowance for timer slack so the floor, not the clock, is what is asserted.
		expect(Date.now() - started).toBeGreaterThanOrEqual(KEY_CHORD_GAP_MS - 5);
	});

	it("throws on an unsupported character before sending anything", async () => {
		const { transport, qmpCalls, hmpCommands } = recordingTransport();
		await expect(sendText(transport, "é", { chordGapMs: 0 })).rejects.toThrow('qemu: unsupported character "é"');
		expect(qmpCalls).toEqual([]);
		expect(hmpCommands).toEqual([]);
	});

	it("publishes the measured chord gap as 60ms", () => {
		expect(KEY_CHORD_GAP_MS).toBe(60);
	});
});
