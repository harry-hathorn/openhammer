/**
 * Verbatim port from pi (`packages/coding-agent/src/core/tools/output-accumulator.ts`).
 *
 * Incrementally tracks streaming process output (the `bash` tool, and any future
 * spawn-based tool) with **bounded memory**: a streaming UTF-8 decoder consumes
 * raw `Buffer` chunks, only a decoded tail is retained for display snapshots, and
 * once the output crosses a line/byte limit the full stream is tee'd to a temp
 * file so nothing is lost. `snapshot()` returns the tail (tail-truncated) plus,
 * when persisted, the `fullOutputPath` that the caller surfaces in a
 * `Full output: <path>` footer. `bash` keeps the tail (errors/results land at the
 * end); `read` does not use this — it reads whole files and keeps the head.
 *
 * One deliberate change from pi: the default `tempFilePrefix` is `"openhammer"`
 * (was `"pi-output"`) so persisted temp files are attributable to this server.
 * Spec 23 adds `tempFilePath`: `bash` routes its overflow through
 * `backend.overflowPath("openhammer")` (identical path shape locally — prefix +
 * 8 hex + `.log` under the tmpdir — a guest path in VM mode, spec 25); when no
 * path is provided the internal mint from `tempFilePrefix` remains the fallback.
 * Spec 25 adds `spill`: `"host"` (the default) is the behavior above;
 * `"external"` says the CALLER owns the full-output copy elsewhere — VM-mode
 * `bash` passes it because the runShell wrapper's guest-side `tee` already owns
 * the full output at the provided `tempFilePath`. External never touches the
 * host fs (no `createWriteStream`, no mint) and `snapshot()` still reports the
 * provided path once truncated, so the `Full output:` footer names where the
 * client fetches the full output (`read` resolves the guest path).
 */

import { randomBytes } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
	/** Exact path for the overflow temp file (spec 23: `backend.overflowPath`). When omitted, one is minted from `tempFilePrefix` under the OS tmpdir. Used verbatim — the file is still created lazily, only if the output spills. Under `spill: "external"` it names the caller's copy, never a host file. */
	tempFilePath?: string;
	/**
	 * Who owns the full-output copy once the stream truncates. `"host"` (the
	 * default — today's behavior) spills to a host temp file at `tempFilePath`
	 * (or a minted one). `"external"` (spec 25, VM mode): the caller owns the
	 * copy elsewhere — the guest-side `tee` at `tempFilePath` — so no host file
	 * is ever created or minted, and `snapshot().fullOutputPath` reports the
	 * provided `tempFilePath` (a GUEST path, meaningful to the client via
	 * `read`) once truncated.
	 */
	spill?: "host" | "external";
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	/** Host spill: the spill file's path once one exists. External spill: the provided path of the caller-owned copy, once truncated (never a host file). Undefined otherwise. */
	fullOutputPath?: string;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps only a decoded
 * tail for display snapshots, and opens a temp file when the full output needs
 * to be preserved.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempFilePrefix: string;
	private readonly providedTempFilePath: string | undefined;
	private readonly spill: "host" | "external";
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailStartsAtLineBoundary = true;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private currentLineBytes = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1);
		this.tempFilePrefix = options.tempFilePrefix ?? "openhammer";
		this.providedTempFilePath = options.tempFilePath;
		this.spill = options.spill ?? "host";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.spill === "external") {
			// The caller owns the full-output copy (vm mode: the guest-side tee),
			// so there is no host spill to seed — nothing is retained beyond the
			// decoded tail (still bounded by the trim), and the host fs is never
			// touched.
			return;
		}
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile();
			this.tempFileStream?.write(data);
		} else if (data.length > 0) {
			this.rawChunks.push(data);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.spill === "host" && this.shouldUseTempFile()) {
			this.ensureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes;
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null;
		const truncation: TruncationResult = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		};

		if (this.spill === "host" && options.persistIfTruncated && truncation.truncated) {
			this.ensureTempFile();
		}
		// Host: the spill file's path once one exists. External: the caller-provided
		// path of the copy the CALLER owns (never created host-side here), reported
		// once truncated so the footer can name it.
		const externalCopyPath =
			this.spill === "external" && truncation.truncated ? this.providedTempFilePath : undefined;

		return {
			content: truncation.content,
			truncation,
			fullOutputPath: this.tempFilePath ?? externalCopyPath,
		};
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			return;
		}

		const stream = this.tempFileStream;
		this.tempFileStream = undefined;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish);
				reject(error);
			};
			const onFinish = () => {
				stream.off("error", onError);
				resolve();
			};
			stream.once("error", onError);
			stream.once("finish", onFinish);
			stream.end();
		});
	}

	getLastLineBytes(): number {
		return this.currentLineBytes;
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		const bytes = byteLength(text);
		this.totalDecodedBytes += bytes;
		this.tailText += text;
		this.tailBytes += bytes;
		if (this.tailBytes > this.maxRollingBytes * 2) {
			this.trimTail();
		}

		let newlines = 0;
		let lastNewline = -1;
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++;
			lastNewline = i;
		}
		if (newlines === 0) {
			this.currentLineBytes += bytes;
			this.hasOpenLine = true;
		} else {
			this.completedLines += newlines;
			const tail = text.slice(lastNewline + 1);
			this.currentLineBytes = byteLength(tail);
			this.hasOpenLine = tail.length > 0;
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8");
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length;
			return;
		}

		let start = buffer.length - this.maxRollingBytes;
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
			start++;
		}

		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a;
		this.tailText = buffer.subarray(start).toString("utf-8");
		this.tailBytes = byteLength(this.tailText);
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) {
			return this.tailText;
		}

		const firstNewline = this.tailText.indexOf("\n");
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1);
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) {
			return;
		}
		this.tempFilePath = this.providedTempFilePath ?? defaultTempFilePath(this.tempFilePrefix);
		this.tempFileStream = createWriteStream(this.tempFilePath);
		for (const chunk of this.rawChunks) {
			this.tempFileStream.write(chunk);
		}
		this.rawChunks = [];
	}
}
