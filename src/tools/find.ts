/**
 * The `find` tool (spec 08; execution via the backend seam, spec 23).
 *
 * Ports pi's `find` execute logic, stripped of all pi-package/TUI/operations
 * coupling: `ensureTool("fd", true)` (→ `ctx.backend.probe("fd")` presence
 * check — no download, no Node fallback), `FindOperations` (→
 * `ctx.backend.runArgv` — the argument-array spawn, never `runShell`, so the
 * user-controlled pattern never rides a shell string), `typebox` (→ plain
 * JSON-Schema literal), and the `AbortSignal` plumbing (unreachable in v1 —
 * `ToolModule.execute` carries no signal, mirroring `bash`/`grep`). Every
 * render/TUI helper is gone. The old module-level
 * `--no-require-git` capability cache now lives in the backend instance
 * (`probeFlag`), so a fresh backend re-probes instead of trusting a stale
 * process-wide memo.
 *
 * Runs `fd --glob … <searchPath>`, collects stdout path lines, and relativizes
 * each against the search root (fd emits absolute paths for an absolute search
 * root; directory entries keep their trailing `/`; separators normalize to
 * POSIX). `--max-results` bounds the result set at the fd side — there is no
 * client-side kill (unlike `grep`, whose match cap aborts mid-stream) — so no
 * `signal` rides this spawn. fd exits **0** even on no-match (unlike rg's exit
 * 1), so an empty result is signalled by empty output, not a non-zero exit;
 * only a non-zero exit with **no** output is an error (with output it's a
 * partial success). pi throws on missing-fd / failing exit; here those become
 * `err(...)`; the one genuine-throw path (spawn error) is narrowed inside
 * `runFd`, where the old `child.on("error")` handler used to live.
 */
import { relative, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import type { ShellResult, ToolBackend } from "./backend.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok, type Result } from "./result.ts";
import { DEFAULT_MAX_BYTES, formatSize, truncateHead } from "./truncate.ts";

const DEFAULT_LIMIT = 1000;
const FD_MISSING = "fd is not installed. Install fd to use the find tool.";

/** Convert an OS-native path to POSIX forward-slash separators. */
function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

/**
 * Run `fd` through the backend and collect stdout path lines. Line parsing is
 * owned here (the backend stays dumb): chunks decode incrementally
 * (`StringDecoder`, so a multi-byte UTF-8 filename split across pipe chunks
 * survives) and split on newlines, with the partial tail carried between
 * chunks — the same framing `readline` gave the old local spawn.
 */
async function runFd(backend: ToolBackend, fdArgs: string[]): Promise<Result<{ lines: string[] }, Error>> {
	let stderr = "";
	const decoder = new StringDecoder("utf-8");
	let pending = "";
	const lines: string[] = [];

	let result: ShellResult;
	try {
		result = await backend.runArgv("fd", fdArgs, {
			onStdout: (chunk) => {
				pending += decoder.write(chunk);
				const complete = pending.split("\n");
				pending = complete.pop() ?? "";
				for (const line of complete) lines.push(line);
			},
			onStderr: (chunk) => {
				stderr += chunk.toString();
			},
		});
	} catch (error) {
		// Spawn error (the backend's one rejection, e.g. fd missing from PATH).
		return err(new Error(`Failed to run fd: ${error instanceof Error ? error.message : String(error)}`));
	}
	// The streams are drained by now (runArgv resolves on close): flush any
	// trailing partial line, exactly as readline emitted the tail at stream end.
	pending += decoder.end();
	if (pending) lines.push(pending);

	const output = lines.join("\n");
	// fd exits 0 even on no-match; non-zero only on real failure. A non-zero
	// exit with no output is an error (surface stderr or a code message); with
	// output it's a partial success — fall through and relativize what we have.
	if (result.exitCode !== 0 && !output) {
		const msg = stderr.trim() || `fd exited with code ${result.exitCode}`;
		return err(new Error(msg));
	}
	return ok({ lines });
}

export const findTool: ToolModule = {
	name: "find",
	description: `Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} results or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first).`,
	inputSchema: {
		type: "object",
		properties: {
			pattern: {
				type: "string",
				description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
			},
			path: { type: "string", description: "Directory to search in (default: current directory)" },
			limit: { type: "number", description: "Maximum number of results (default: 1000)" },
		},
		required: ["pattern"],
	},
	async execute(args, ctx) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const pattern = args.pattern;
		if (typeof pattern !== "string") {
			return err(new Error("find requires a string 'pattern' argument"));
		}
		const searchDir = typeof args.path === "string" ? args.path : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;

		if (!ctx.backend.probe("fd")) {
			return err(new Error(FD_MISSING));
		}

		const searchPath = resolveToCwd(searchDir || ".", ctx.rootDir);
		const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

		// Build fd args (verbatim from pi). --no-require-git applies hierarchical
		// .gitignore semantics whether or not the search path is inside a git repo,
		// without leaking sibling-directory rules the way --ignore-file (a global
		// source) would. Older fd builds (Debian bookworm's 8.6.0) lack the flag, so
		// include it only when the build supports it (probed once per backend
		// instance — the per-instance cache replaced the old module-level memo).
		const fdArgs: string[] = ["--glob", "--color=never", "--hidden"];
		if (ctx.backend.probeFlag("fd", "--no-require-git")) {
			fdArgs.push("--no-require-git");
		}
		fdArgs.push("--max-results", String(effectiveLimit));

		// fd --glob matches against the basename unless --full-path is set; in
		// --full-path mode it matches the whole candidate path, so a path-containing
		// pattern like 'src/**/*.spec.ts' needs a leading '**/' to match anything.
		// "--" before the user-controlled pattern so a pattern like "-foo" can't
		// become a flag (arg-array spawn, never a shell string).
		let effectivePattern = pattern;
		if (pattern.includes("/")) {
			fdArgs.push("--full-path");
			if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
				effectivePattern = `**/${pattern}`;
			}
		}
		fdArgs.push("--", effectivePattern, searchPath);

		const searchRes = await runFd(ctx.backend, fdArgs);
		if (!searchRes.ok) {
			return searchRes;
		}

		// Relativize each fd line against the search root: slice the absolute prefix
		// (fd emits absolute paths for an absolute search root) or fall back to a
		// relative resolve; preserve a trailing '/' on directory entries; POSIX '/'.
		const relativized: string[] = [];
		for (const rawLine of searchRes.value.lines) {
			const line = rawLine.replace(/\r$/, "").trim();
			if (!line) continue;
			const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
			let relativePath = line;
			if (line.startsWith(searchPath)) {
				relativePath = line.slice(searchPath.length + 1);
			} else {
				relativePath = relative(searchPath, line);
			}
			if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
			relativized.push(toPosixPath(relativePath));
		}

		if (relativized.length === 0) {
			return ok({ content: [{ type: "text", text: "No files found matching pattern" }] });
		}

		// `--max-results` already bounded the rows at the fd side; byte-cap the joined
		// output only (no line cap here, mirroring pi/grep).
		const resultLimitReached = relativized.length >= effectiveLimit;
		const truncation = truncateHead(relativized.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
		let output = truncation.content;
		const notices: string[] = [];
		if (resultLimitReached) {
			notices.push(
				`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
			);
		}
		if (truncation.truncated) {
			notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		}
		if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;

		const toolOk: ToolOk = { content: [{ type: "text", text: output }] };
		return ok(toolOk);
	},
};
