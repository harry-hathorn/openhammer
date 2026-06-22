/**
 * The `grep` tool (spec 07).
 *
 * Ports pi's `grep` execute logic, stripped of all pi-package/TUI/operations
 * coupling: `ensureTool("rg", true)` (→ `isToolAvailable("rg")` presence check —
 * no download, no Node fallback), `GrepOperations` (→ direct `fs` reads for
 * context lines), `typebox` (→ plain JSON-Schema literal), and the `AbortSignal`
 * plumbing (unreachable in v1 — `ToolModule.execute` carries no signal, mirroring
 * `bash`). Every render/TUI helper is gone.
 *
 * Spawns `rg --json …` under `rootDir`, parses NDJSON `match` events until the
 * match cap (then kills the child so a huge result set never streams in full),
 * formats `path:line: text` rows (or `path-line-` context blocks), and byte-caps
 * the joined output via `truncateHead`. pi throws on missing-rg / non-(0|1) exit;
 * here those become `err(...)` — the MCP `CallTool` handler (spec 12) is the single
 * narrowing point. Like `bash`, grep manages its own streaming and does **not**
 * use `io.ts`; the `try/catch`-free body composes via `Result` (the spawn lifecycle
 * already resolves to a `Result`, narrowed at the `await`).
 */
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, relative } from "node:path";
import { createInterface } from "node:readline";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { isToolAvailable } from "./bin.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok, type Result } from "./result.ts";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine } from "./truncate.ts";

const DEFAULT_LIMIT = 100;
const RG_MISSING = "ripgrep (rg) is not installed. Install ripgrep to use the grep tool.";

/** A parsed `--json` match event: file + 1-indexed line + the matching line text. */
interface Match {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

/**
 * Spawn `rg` and stream NDJSON, collecting `match` events until `effectiveLimit`
 * is hit (then kill the child). rg exits **1** on no-match, which is *not* an
 * error — only codes other than 0/1 fail. Mirrors pi's parse + limit-kill with
 * the abort plumbing stripped. The child's own lifecycle resolves to a `Result`,
 * so `execute` can `await` + short-circuit with no try/catch.
 */
function runRipgrep(
	rgArgs: string[],
	effectiveLimit: number,
): Promise<Result<{ matches: Match[]; matchCount: number; matchLimitReached: boolean }, Error>> {
	return new Promise((resolve) => {
		const child = spawn("rg", rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderr = "";
		let matchCount = 0;
		let matchLimitReached = false;
		let settled = false;
		let killedDueToLimit = false;
		const matches: Match[] = [];

		const settle = (r: Result<{ matches: Match[]; matchCount: number; matchLimitReached: boolean }, Error>): void => {
			if (!settled) {
				settled = true;
				resolve(r);
			}
		};
		// Killing rg once the match cap is hit makes `close` fire with `code === null`
		// (SIGTERM) — that is *not* an error, so track it and skip the exit-code check.
		const stopChild = (): void => {
			if (!child.killed) {
				killedDueToLimit = true;
				child.kill();
			}
		};

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			if (!line.trim() || matchCount >= effectiveLimit) return;
			let event: unknown;
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (typeof event !== "object" || event === null) return;
			const ev = event as { type?: unknown; data?: unknown };
			if (ev.type !== "match") return;
			matchCount++;
			const data = ev.data;
			if (typeof data === "object" && data !== null) {
				const d = data as { path?: { text?: unknown }; line_number?: unknown; lines?: { text?: unknown } };
				const filePath = d.path?.text;
				const lineNumber = d.line_number;
				const lineText = d.lines?.text;
				if (typeof filePath === "string" && typeof lineNumber === "number") {
					matches.push({ filePath, lineNumber, lineText: typeof lineText === "string" ? lineText : undefined });
				}
			}
			if (matchCount >= effectiveLimit) {
				matchLimitReached = true;
				stopChild();
			}
		});

		child.on("error", (error) => {
			rl.close();
			settle(err(new Error(`Failed to run ripgrep: ${error.message}`)));
		});

		child.on("close", (code) => {
			rl.close();
			// rg exits 1 on no-match (NOT an error); only codes other than 0/1 fail.
			// A limit-kill arrives as code === null (signal) — not an error either.
			if (!killedDueToLimit && code !== 0 && code !== 1) {
				const msg = stderr.trim() || `ripgrep exited with code ${code}`;
				settle(err(new Error(msg)));
				return;
			}
			settle(ok({ matches, matchCount, matchLimitReached }));
		});
	});
}

export const grepTool: ToolModule = {
	name: "grep",
	description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
	inputSchema: {
		type: "object",
		properties: {
			pattern: { type: "string", description: "Search pattern (regex or literal string)" },
			path: { type: "string", description: "Directory or file to search (default: current directory)" },
			glob: { type: "string", description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" },
			ignoreCase: { type: "boolean", description: "Case-insensitive search (default: false)" },
			literal: { type: "boolean", description: "Treat pattern as literal string instead of regex (default: false)" },
			context: { type: "number", description: "Number of lines to show before and after each match (default: 0)" },
			limit: { type: "number", description: "Maximum number of matches to return (default: 100)" },
		},
		required: ["pattern"],
	},
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const pattern = args.pattern;
		if (typeof pattern !== "string") {
			return err(new Error("grep requires a string 'pattern' argument"));
		}
		const searchDir = typeof args.path === "string" ? args.path : undefined;
		const glob = typeof args.glob === "string" ? args.glob : undefined;
		const ignoreCase = args.ignoreCase === true;
		const literal = args.literal === true;
		const context = typeof args.context === "number" ? args.context : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;

		if (!isToolAvailable("rg")) {
			return err(new Error(RG_MISSING));
		}

		const searchPath = resolveToCwd(searchDir || ".", rootDir);
		let isDirectory: boolean;
		try {
			isDirectory = statSync(searchPath).isDirectory();
		} catch {
			return err(new Error(`Path not found: ${searchPath}`));
		}

		const contextValue = context && context > 0 ? context : 0;
		const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

		// Build rg args (verbatim from pi): "--" before the user-controlled pattern
		// so a pattern like "-foo" can't become a flag (arg-array spawn, never a shell string).
		const rgArgs: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
		if (ignoreCase) rgArgs.push("--ignore-case");
		if (literal) rgArgs.push("--fixed-strings");
		if (glob) rgArgs.push("--glob", glob);
		rgArgs.push("--", pattern, searchPath);

		const searchRes = await runRipgrep(rgArgs, effectiveLimit);
		if (!searchRes.ok) {
			return searchRes;
		}
		const { matches, matchCount, matchLimitReached } = searchRes.value;

		if (matchCount === 0) {
			return ok({ content: [{ type: "text", text: "No matches found" }] });
		}

		// Match path → relative (POSIX "/") when searching a dir, else basename.
		const formatPath = (filePath: string): string => {
			if (isDirectory) {
				const rel = relative(searchPath, filePath);
				if (rel && !rel.startsWith("..")) {
					return rel.replace(/\\/g, "/");
				}
			}
			return basename(filePath);
		};

		// Per-file line cache for context blocks (read once, reused across matches).
		const fileCache = new Map<string, string[]>();
		const getFileLines = (filePath: string): string[] => {
			let lines = fileCache.get(filePath);
			if (!lines) {
				try {
					const content = readFileSync(filePath, "utf-8");
					lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
				} catch {
					lines = [];
				}
				fileCache.set(filePath, lines);
			}
			return lines;
		};

		let linesTruncated = false;
		// Context block: match line `path:n:` + context lines `path-n-` for ±contextValue.
		const formatBlock = (filePath: string, lineNumber: number): string[] => {
			const relPath = formatPath(filePath);
			const lines = getFileLines(filePath);
			if (!lines.length) return [`${relPath}:${lineNumber}: (unable to read file)`];
			const block: string[] = [];
			const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
			const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
			for (let current = start; current <= end; current++) {
				const lineText = lines[current - 1] ?? "";
				const sanitized = lineText.replace(/\r/g, "");
				const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
				if (wasTruncated) linesTruncated = true;
				if (current === lineNumber) block.push(`${relPath}:${current}: ${truncatedText}`);
				else block.push(`${relPath}-${current}- ${truncatedText}`);
			}
			return block;
		};

		// Format matches after streaming finishes (context reads hit the fs here).
		const outputLines: string[] = [];
		for (const match of matches) {
			if (contextValue === 0 && match.lineText !== undefined) {
				const relPath = formatPath(match.filePath);
				const sanitized = match.lineText.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
				const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
				if (wasTruncated) linesTruncated = true;
				outputLines.push(`${relPath}:${match.lineNumber}: ${truncatedText}`);
			} else {
				outputLines.push(...formatBlock(match.filePath, match.lineNumber));
			}
		}

		// Byte cap only — the match limit already bounds rows (no line cap here).
		const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;
		const notices: string[] = [];
		if (matchLimitReached) {
			notices.push(
				`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
			);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (linesTruncated) {
			notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		}
		if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

		const toolOk: ToolOk = { content: [{ type: "text", text: output }] };
		return ok(toolOk);
	},
};
