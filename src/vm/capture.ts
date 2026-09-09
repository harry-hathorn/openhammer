// Debug capture — spec 24's src/vm/capture.ts: capture-before-kill on any non-clean
// session end. Three evidence surfaces land in sessions/<id>/debug/ — the serial tail,
// QEMU's stderr tail, the last QMP exchanges — each capped at 1 MiB KEEPING THE END (the
// end of a stream is where the failure is; a head cap would keep the happy boot and lose
// the death). The returned manifest (name/bytes/truncated per file) is what spec 27's
// status line surfaces; nothing in here decides anything about the session.
//
// Error model: evidence, not control flow. Absent or unreadable sources are SKIPPED, never
// fatal — a capture that threw would mask the very teardown failure it exists to explain
// (no serial file means the boot died before QEMU wrote a byte; an empty stderr tail means
// QEMU said nothing; the report shows exactly what was captured). Only a debug dir that
// cannot be created or written rejects: a broken vm tree deserves one surfaced rejection
// in the service layer, not a per-file swallow.
//
// The QMP leg needs a wire log: 24b's client drops traffic by default, so it grew an
// optional `onExchange` hook (one fire per wire line, both directions — see qmp/client.ts).
// createExchangeRing below is the sink capture intends for it: the last ~200 lines, handed
// back here at teardown.
import { stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type QemuHandle, tailText } from "./qemu/process.ts";
import { ensureVmDir, type SessionPaths } from "./session.ts";

/** The per-file capture cap: 1 MiB, keeping the end (where the failure is). */
export const CAPTURE_CAP_BYTES = 1024 * 1024;

/** The exchange ring's capacity: the last ~200 QMP wire lines (≈200 × <1 KiB frames). */
export const QMP_RING_LINES = 200;

const NEWLINE = 0x0a;
const SERIAL_FILE = "serial-tail.log";
const STDERR_FILE = "qemu-stderr.log";
const QMP_FILE = "qmp-last.jsonl";

/** What a capture can gather at teardown — every source optional (absent = skipped). */
export interface CaptureSources {
	/** The session's serial log; its END is read at the cap (the file grows unbounded). */
	readonly serialLogPath?: string;
	/** QEMU's stderr tail — `QemuHandle.stderrTail()`'s 4 KiB, or any string. */
	readonly qemuStderrTail?: string;
	/** The last QMP wire lines in order (an exchange ring snapshot). */
	readonly qmpExchanges?: readonly string[];
}

/** One written capture file — the manifest a future status line (spec 27) surfaces. */
export interface CaptureFile {
	readonly name: string;
	readonly bytes: number;
	/** Source bytes were dropped (over-cap, or the whole-line alignment below the cut). */
	readonly truncated: boolean;
}

export interface CaptureResult {
	readonly dir: string;
	readonly files: readonly CaptureFile[];
}

/** Injectable seams (the injection-arg precedent: the production call shape stays clean). */
export interface CaptureDeps {
	/** Override the source-file tail read (default: qemu/process.ts's tailText). */
	readonly readTail?: (path: string, bytes: number) => Promise<string>;
}

/**
 * Keep the last `maxBytes` of `data`, whole-line aligned. BYTE-ORIENTED BY DESIGN: the cut
 * is made in byte space and can split a multi-byte UTF-8 sequence — serial and QMP are byte
 * streams, and a replacement character at the head of a tail costs less than the bytes a
 * code-point-aware cap would waste. When truncating, the start additionally advances to
 * just past the first newline at/after the cut so the tail begins on a whole line; that
 * only ever drops more bytes, so the result never exceeds maxBytes (and can even empty out
 * when no whole line fits the window — the honest reading of "whole lines, never over
 * cap"). An input with no newline after the cut (one giant line) truncates at the raw
 * byte: there is no boundary to align to.
 */
export function capKeepEnd(
	data: string | Buffer,
	maxBytes: number,
): { readonly data: Buffer; readonly truncated: boolean } {
	const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
	if (buffer.byteLength <= maxBytes) {
		return { data: buffer, truncated: false };
	}
	let start = buffer.byteLength - maxBytes;
	const newline = buffer.indexOf(NEWLINE, start);
	if (newline !== -1) {
		start = newline + 1;
	}
	return { data: buffer.subarray(start), truncated: true };
}

/**
 * Write the debug capture: up to three end-capped files inside `debugDir` (created 0700 if
 * missing — prepareSession normally already made it), one per PRESENT source, in a fixed
 * order (serial, stderr, QMP) that the manifest mirrors. Files are 0600: serial output can
 * carry guest secrets. Absent, empty, or unreadable sources are skipped without a trace.
 */
export async function writeDebugCapture(
	debugDir: string,
	sources: CaptureSources,
	deps: CaptureDeps = {},
): Promise<CaptureResult> {
	await ensureVmDir(debugDir);
	const readTail = deps.readTail ?? tailText;
	const files: CaptureFile[] = [];

	if (sources.serialLogPath !== undefined) {
		const info = await stat(sources.serialLogPath).catch(() => undefined);
		// Missing (boot died before QEMU opened it), not a file, or empty → skip.
		if (info?.isFile() && info.size > 0) {
			// The +1: reading one byte PAST the cap puts capKeepEnd's cut exactly on the
			// file's true cap boundary, so its newline alignment trims the real partial line
			// (a bare cap-sized read lands at exactly the cap and never aligns).
			const tail = await readTail(sources.serialLogPath, CAPTURE_CAP_BYTES + 1).catch(() => undefined);
			if (tail !== undefined && tail !== "") {
				const capped = capKeepEnd(tail, CAPTURE_CAP_BYTES);
				// truncated vs the FILE (not the tail read): a source bigger than what landed.
				files.push(await writeCapped(debugDir, SERIAL_FILE, capped.data, info.size > capped.data.byteLength));
			}
		}
	}
	if (sources.qemuStderrTail !== undefined && sources.qemuStderrTail !== "") {
		const capped = capKeepEnd(sources.qemuStderrTail, CAPTURE_CAP_BYTES);
		files.push(await writeCapped(debugDir, STDERR_FILE, capped.data, capped.truncated));
	}
	if (sources.qmpExchanges !== undefined && sources.qmpExchanges.length > 0) {
		// Each exchange is one wire line by the client-hook contract; the trailing newline
		// keeps the file a well-formed line-oriented artifact.
		const capped = capKeepEnd(`${sources.qmpExchanges.join("\n")}\n`, CAPTURE_CAP_BYTES);
		files.push(await writeCapped(debugDir, QMP_FILE, capped.data, capped.truncated));
	}
	return { dir: debugDir, files };
}

// Sequential on purpose: three writes, once per teardown — the manifest's order IS the
// write order, and there is nothing here worth parallelizing.
async function writeCapped(debugDir: string, name: string, data: Buffer, truncated: boolean): Promise<CaptureFile> {
	await writeFile(join(debugDir, name), data, { mode: 0o600 });
	return { name, bytes: data.byteLength, truncated };
}

/** The bounded QMP wire log: hand `onExchange` to connectQmp, read `lines()` at capture time. */
export interface ExchangeRing {
	readonly onExchange: (line: string) => void;
	readonly lines: () => string[];
}

/** Keep the last `capacity` wire lines, in order — capture's intended `onExchange` sink. */
export function createExchangeRing(capacity: number = QMP_RING_LINES): ExchangeRing {
	let kept: string[] = [];
	return {
		onExchange: (line: string): void => {
			kept.push(line);
			if (kept.length > capacity) {
				kept = kept.slice(kept.length - capacity);
			}
		},
		lines: (): string[] => [...kept],
	};
}

/**
 * The teardown convenience: session paths + (optionally) the live handle and the
 * exchange-ring snapshot → writeDebugCapture into `sessions/<id>/debug/`. Everything
 * heavier (deciding WHEN an end is non-clean, sequencing before the stop ladder) is the
 * service layer's, spec 27 — this stays a thin composition over 24d's types.
 */
export async function captureOnTeardown(
	sessionPaths: Pick<SessionPaths, "serialPath" | "debugDir">,
	handle?: Pick<QemuHandle, "stderrTail">,
	qmpExchanges?: readonly string[],
): Promise<CaptureResult> {
	return writeDebugCapture(sessionPaths.debugDir, {
		serialLogPath: sessionPaths.serialPath,
		qemuStderrTail: handle === undefined ? undefined : await handle.stderrTail(),
		qmpExchanges,
	});
}
