// QMP framing — the pure line protocol, promoted from the vm-spike's in-client buffer
// (scripts/vm-spike/qmp.ts): QMP frames are newline-delimited JSON. This module knows bytes
// and lines only — no sockets, no command/response map. Bytes (not decoded text) are
// buffered across chunks, so a frame split at any offset decodes identically to arriving
// whole; that includes splits inside a multi-byte UTF-8 code point (QMP is ASCII JSON in
// practice, but a 0x0A never occurs inside a multi-byte sequence, so splitting in byte
// space is correct regardless).

/** One decoded inbound line: the parsed JSON plus the raw text (the greeting is recorded verbatim). */
export type QmpDecodedLine =
	| { readonly ok: true; readonly line: string; readonly value: unknown }
	| { readonly ok: false; readonly error: Error };

/** The outbound frame: compact JSON with `execute`/`arguments`/`id`, terminated by the newline. */
export const encodeQmpCommand = (command: string, args: Record<string, unknown>, id: number): string =>
	`${JSON.stringify({ execute: command, arguments: args, id })}\n`;

const NEWLINE = 0x0a;
const EMPTY = new Uint8Array(0);

const concatBytes = (head: Uint8Array, tail: Uint8Array): Uint8Array => {
	const out = new Uint8Array(head.length + tail.length);
	out.set(head, 0);
	out.set(tail, head.length);
	return out;
};

/**
 * Incremental decoder for the inbound direction: feed each chunk as it arrives, collect
 * every line the chunk completed. A line that does not parse as JSON poisons the stream —
 * a single failure frame comes back and everything after it is dropped (the client tears
 * the connection down, exactly as the spike did with its invalid-frame teardown).
 */
export class QmpDecoder {
	private tail: Uint8Array = EMPTY;
	private poisoned = false;
	private readonly decoder = new TextDecoder("utf-8");

	push(chunk: Uint8Array): ReadonlyArray<QmpDecodedLine> {
		if (this.poisoned) {
			return [];
		}
		const buffer = concatBytes(this.tail, chunk);
		this.tail = EMPTY;
		const lines: Array<QmpDecodedLine> = [];
		let start = 0;
		for (let i = 0; i < buffer.length; i++) {
			if (buffer[i] !== NEWLINE) {
				continue;
			}
			const line = this.decoder.decode(buffer.subarray(start, i)).trim();
			start = i + 1;
			if (line === "") {
				continue; // blank filler lines are noise
			}
			let value: unknown;
			try {
				value = JSON.parse(line);
			} catch {
				this.poisoned = true;
				lines.push({ ok: false, error: new Error(`invalid QMP frame: ${line}`) });
				return lines;
			}
			lines.push({ ok: true, line, value });
		}
		this.tail = buffer.slice(start);
		return lines;
	}
}
