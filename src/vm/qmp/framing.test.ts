import { describe, expect, it } from "vitest";
import { encodeQmpCommand, type QmpDecodedLine, QmpDecoder } from "./framing.ts";

const encoder = new TextEncoder();

/** A QEMU-shaped exchange: greeting, return, error, event (one é to make it non-ASCII). */
const SAMPLE_LINES = [
	'{"QMP": {"version": {"qemu": {"micro": 0, "minor": 2, "major": 9}, "package": ""}, "capabilities": ["qmp_capabilities"]}}',
	'{"return": {"status": "running", "running": true}}',
	'{"error": {"class": "CommandNotFound", "desc": "café: found no command"}}',
	'{"timestamp": {"seconds": 1699, "microseconds": 999}, "event": "RESET", "data": {}}',
];

const SAMPLE_BYTES = encoder.encode(SAMPLE_LINES.map((line) => `${line}\n`).join(""));

/** Assert the decoded lines are exactly the sample exchange (JSON.parse as an independent oracle). */
function expectSample(lines: ReadonlyArray<QmpDecodedLine>): void {
	expect(lines.map((decoded) => decoded.ok)).toEqual(SAMPLE_LINES.map(() => true));
	const texts = lines.map((decoded) => (decoded.ok ? decoded.line : decoded.error.message));
	const values = lines.map((decoded) => (decoded.ok ? decoded.value : decoded.error));
	expect(texts).toEqual(SAMPLE_LINES);
	expect(values).toEqual(SAMPLE_LINES.map((line) => JSON.parse(line)));
}

/** Push the sample split into two chunks at byte offset `at` and return everything that decoded. */
function decodeSplit(at: number): ReadonlyArray<QmpDecodedLine> {
	const decoder = new QmpDecoder();
	const first = decoder.push(SAMPLE_BYTES.subarray(0, at));
	return [...first, ...decoder.push(SAMPLE_BYTES.subarray(at))];
}

describe("QmpDecoder", () => {
	it("decodes a whole exchange delivered in one chunk", () => {
		expectSample(new QmpDecoder().push(SAMPLE_BYTES));
	});

	it("decodes identically at every single-chunk split offset (exhaustive, bytes not chars)", () => {
		// QMP is ASCII JSON in practice; the loop still walks the multi-byte é in line 3, so a
		// split mid-code point is covered like any other — byte buffering makes it a non-event.
		for (let at = 0; at <= SAMPLE_BYTES.length; at++) {
			expectSample(decodeSplit(at));
		}
	});

	it("carries a partial tail across chunks and completes it when the newline arrives", () => {
		const decoder = new QmpDecoder();
		const first = encoder.encode('{"return": {"status":');
		expect(decoder.push(first)).toEqual([]);
		const rest = decoder.push(encoder.encode(' "running"}}\n'));
		expect(rest).toHaveLength(1);
		const decoded = rest[0];
		expect(decoded?.ok).toBe(true);
		if (decoded?.ok) {
			expect(decoded.line).toBe('{"return": {"status": "running"}}');
			expect(decoded.value).toEqual({ return: { status: "running" } });
		}
	});

	it("emits complete frames while carrying the partial next frame in the same chunk", () => {
		const decoder = new QmpDecoder();
		const emitted = decoder.push(encoder.encode('{"return": 1}\n{"return": 2'));
		expect(emitted).toHaveLength(1);
		const done = decoder.push(encoder.encode("}\n"));
		expect(done).toHaveLength(1);
		const decoded = done[0];
		expect(decoded?.ok).toBe(true);
		if (decoded?.ok) {
			expect(decoded.value).toEqual({ return: 2 });
		}
	});

	it("splits inside a multi-byte UTF-8 code point without corrupting the line", () => {
		const line = encoder.encode('{"return": {"note": "café ☕"}}\n');
		// é is 0xC3 0xA9: split exactly between the lead byte and its continuation.
		const split = line.findIndex((byte, index) => index > 0 && byte >= 0x80 && line[index - 1] >= 0xc0);
		expect(split).toBeGreaterThan(1);
		const decoder = new QmpDecoder();
		decoder.push(line.subarray(0, split));
		const decoded = decoder.push(line.subarray(split))[0];
		expect(decoded?.ok).toBe(true);
		if (decoded?.ok) {
			expect(decoded.value).toEqual({ return: { note: "café ☕" } });
		}
	});

	it("skips blank lines between frames", () => {
		const decoder = new QmpDecoder();
		const emitted = decoder.push(encoder.encode('\n{"return": 1}\n\n \n{"return": 2}\n\n'));
		expect(emitted.map((decoded) => (decoded.ok ? decoded.value : decoded.error))).toEqual([
			{ return: 1 },
			{ return: 2 },
		]);
	});

	it("fails on an invalid JSON line and drops everything after it (poisoned stream)", () => {
		const decoder = new QmpDecoder();
		const emitted = decoder.push(encoder.encode('not json\n{"return": 1}\n'));
		expect(emitted).toHaveLength(1);
		const failure = emitted[0];
		expect(failure?.ok).toBe(false);
		if (!failure?.ok) {
			expect(failure.error).toBeInstanceOf(Error);
			expect(failure.error.message).toBe("invalid QMP frame: not json");
		}
		// The stream is dead: further pushes decode nothing.
		expect(decoder.push(encoder.encode('{"return": 2}\n'))).toEqual([]);
	});

	it("decodes non-object JSON lines as ordinary frames (filtering is the client's job)", () => {
		const decoder = new QmpDecoder();
		const emitted = decoder.push(encoder.encode('123\nnull\n{"return": 1}\n'));
		expect(emitted.map((decoded) => (decoded.ok ? decoded.value : decoded.error))).toEqual([
			123,
			null,
			{ return: 1 },
		]);
	});
});

describe("encodeQmpCommand", () => {
	it("encodes a command as compact JSON with execute/arguments/id, newline-terminated", () => {
		expect(encodeQmpCommand("query-status", {}, 1)).toBe('{"execute":"query-status","arguments":{},"id":1}\n');
	});

	it("carries arguments through and round-trips", () => {
		const frame = encodeQmpCommand("send-key", { keys: [{ type: "qcode", data: "ret" }] }, 7);
		expect(frame.endsWith("\n")).toBe(true);
		expect(JSON.parse(frame)).toEqual({
			execute: "send-key",
			arguments: { keys: [{ type: "qcode", data: "ret" }] },
			id: 7,
		});
	});
});
