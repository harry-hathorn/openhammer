// QMP send-key grammar — the production port of Oligarchy's src/qemu/keys.ts (spec 24),
// promoted from the spec-22 vm-spike copy that unlocked real LUKS (33 chords, zero drops):
// text as typed, named keys like <ENTER>/<BKSP>/<TAB>, modifier chords <C-x>/<A-x>/<S-x>/<M-x>,
// the shifted-char table, and qcode passthrough — every token parses to a chord of QEMU qcode
// names. Ported table-for-table and case-for-case; the only adaptations are the error channel
// (Effect's Result → this repo's { ok: true; value } | { ok: false; error } union), a local
// sleep (below), and a structural transport seam instead of the spike's QmpClient import.

export type Chord = ReadonlyArray<string>;

/** One chord's parse outcome (Oligarchy: `Result<Chord, KeysError>`). */
type ChordResult = { readonly ok: true; readonly value: Chord } | { readonly ok: false; readonly error: Error };

/** A whole key string's parse outcome (Oligarchy: `Result<ReadonlyArray<Chord>, KeysError>`). */
export type ParsedKeys =
	| { readonly ok: true; readonly value: ReadonlyArray<Chord> }
	| { readonly ok: false; readonly error: Error };

const NAMED: Readonly<Record<string, string>> = {
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

const SHIFTED: Readonly<Record<string, string>> = {
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

const UNSHIFTED: Readonly<Record<string, string>> = {
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

const MODIFIERS: Readonly<Record<string, string>> = {
	C: "ctrl",
	CTRL: "ctrl",
	CONTROL: "ctrl",
	A: "alt",
	ALT: "alt",
	S: "shift",
	SHIFT: "shift",
	M: "meta_l",
	META: "meta_l",
};

/** The shared failure member — assignable into both result shapes. */
type KeysFailure = { readonly ok: false; readonly error: Error };

const fail = (message: string): KeysFailure => ({ ok: false, error: new Error(message) });

const charChord = (char: string): ChordResult => {
	if (char >= "a" && char <= "z") {
		return { ok: true, value: [char] };
	}
	if (char >= "A" && char <= "Z") {
		return { ok: true, value: ["shift", char.toLowerCase()] };
	}
	if (char >= "0" && char <= "9") {
		return { ok: true, value: [char] };
	}
	const plain = UNSHIFTED[char];
	if (plain !== undefined) {
		return { ok: true, value: [plain] };
	}
	const shifted = SHIFTED[char];
	if (shifted !== undefined) {
		return { ok: true, value: ["shift", shifted] };
	}
	return fail(`qemu: unsupported character "${char}"`);
};

const keyName = (name: string): ChordResult => {
	const named = NAMED[name.toUpperCase()];
	if (named !== undefined) {
		return { ok: true, value: [named] };
	}
	if (Array.from(name).length === 1) {
		return charChord(name);
	}
	// Accept any documented qcode token (f1..f24, kp_*, caps_lock, ...) rather than maintain the
	// full list here. Qcodes are lowercase [a-z0-9_]; rejecting anything else keeps a stray "f}"
	// out of the QMP stream.
	const lower = name.toLowerCase();
	if (/^[a-z0-9_]+$/.test(lower) && (lower === "unmapped" || lower.includes("_") || lower.startsWith("f"))) {
		return { ok: true, value: [lower] };
	}
	return fail(`qemu: unknown key "${name}"`);
};

const angleChord = (inner: string): ChordResult => {
	if (inner === "") {
		return fail("qemu: empty key sequence");
	}
	const parts = inner.split("-");
	// The minus key is itself the separator: "C--" splits to ["C", "", ""], so a trailing pair of
	// empty parts is the "-" key, not an empty modifier and an empty key.
	const minusKey = parts.length >= 2 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "";
	const chord: Array<string> = [];
	for (const part of parts.slice(0, minusKey ? -2 : -1)) {
		const modifier = MODIFIERS[part.toUpperCase()];
		if (modifier === undefined) {
			return fail(`qemu: unknown modifier "${part}"`);
		}
		chord.push(modifier);
	}
	const name = minusKey ? "-" : parts[parts.length - 1];
	// <GT> is shift+dot on a US keyboard.
	if (name.toUpperCase() === "GT") {
		return { ok: true, value: [...chord, "shift", "dot"] };
	}
	const named = keyName(name);
	return named.ok ? { ok: true, value: [...chord, ...named.value] } : named;
};

export const parseKeys = (keys: string, encoding = "oligarchy"): ParsedKeys => {
	if (encoding !== "" && encoding.toLowerCase() !== "oligarchy") {
		return fail(`qemu: unknown key encoding "${encoding}"`);
	}
	const out: Array<Chord> = [];
	const chars = Array.from(keys);
	for (let i = 0; i < chars.length; i++) {
		const char = chars[i];
		let chord: ChordResult;
		if (char === "<") {
			const end = chars.indexOf(">", i + 1);
			if (end < 0) {
				return fail("qemu: unterminated key sequence");
			}
			chord = angleChord(chars.slice(i + 1, end).join(""));
			i = end;
		} else {
			chord = charChord(char);
		}
		if (!chord.ok) {
			return chord;
		}
		out.push(chord.value);
	}
	return { ok: true, value: out };
};

// The spike imports sleep from its runtime.ts; src/ has no shared runtime module yet and each
// current caller carries a local copy (e.g. src/tui/dashboard/server-control.ts), so this is a
// local three-liner until one earns a shared home.
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// QEMU's keyboard queue holds ~1024 input events and silently drops the rest. send-key acks
// immediately but the guest drains slowly, so a long string sent as fast as QMP acks overflows
// the queue and loses keys. Pace chords under the drain rate; measured against real QEMU,
// 60ms/chord keeps a 1000-char string lossless (Oligarchy's constant, kept verbatim).
export const KEY_CHORD_GAP_MS = 60;

/**
 * The minimal QMP surface sendText drives. The production QMP client (spec 24, `src/vm/qmp/`)
 * satisfies this interface structurally — its `execute(command, args?)` and
 * `humanMonitorCommand(commandLine)` match these signatures — so sendText accepts the real
 * client (or any test double) without importing it, keeping the grammar pure and socket-free.
 */
export interface SendKeyTransport {
	execute(command: string, args?: Record<string, unknown>): Promise<unknown>;
	humanMonitorCommand(commandLine: string): Promise<string>;
}

/** One QMP exchange as sent — recorded verbatim in the run log (gate 3 evidence). */
export interface SendKeyExchange {
	/** The QMP command name (`send-key`) or the HMP form's `human-monitor-command`. */
	readonly channel: "qmp-send-key" | "hmp-sendkey";
	readonly args: Record<string, unknown>;
}

export interface SendTextResult {
	readonly chords: ReadonlyArray<Chord>;
	readonly exchanges: ReadonlyArray<SendKeyExchange>;
}

export interface SendTextOptions {
	/** Per-chord pacing; defaults to KEY_CHORD_GAP_MS. */
	readonly chordGapMs?: number;
	/** Called with every exchange before it is sent — the run-log hook. */
	readonly onExchange?: (exchange: SendKeyExchange) => void;
	/** The one sanctioned variation (spec 22 fallback ladder): HMP `sendkey` instead. */
	readonly channel?: "qmp-send-key" | "hmp-sendkey";
}

/**
 * Type a LITERAL string into the guest followed by ENTER, one QMP send-key per chord with
 * per-chord pacing. The text is parsed per-character through charChord — NOT parseKeys — so a
 * "<" in the payload types as the shifted comma it is, never as a key-sequence bracket; the
 * trailing ENTER is the named `ret` chord. Every exchange is reported through `onExchange`.
 */
export async function sendText(
	transport: SendKeyTransport,
	text: string,
	options: SendTextOptions = {},
): Promise<SendTextResult> {
	const gap = options.chordGapMs ?? KEY_CHORD_GAP_MS;
	const chords: Array<Chord> = [];
	for (const char of Array.from(text)) {
		const chord = charChord(char);
		if (!chord.ok) {
			throw chord.error;
		}
		chords.push(chord.value);
	}
	chords.push(["ret"]); // ENTER
	const exchanges: SendKeyExchange[] = [];
	for (const [index, chord] of chords.entries()) {
		const exchange: SendKeyExchange =
			options.channel === "hmp-sendkey"
				? { channel: "hmp-sendkey", args: { "command-line": `sendkey ${chord.join("-")}` } }
				: { channel: "qmp-send-key", args: { keys: chord.map((code) => ({ type: "qcode", data: code })) } };
		exchanges.push(exchange);
		options.onExchange?.(exchange);
		if (exchange.channel === "hmp-sendkey") {
			await transport.humanMonitorCommand(String(exchange.args["command-line"]));
		} else {
			await transport.execute("send-key", exchange.args);
		}
		if (index + 1 < chords.length) {
			await sleep(gap);
		}
	}
	return { chords, exchanges };
}
