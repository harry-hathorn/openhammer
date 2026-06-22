/**
 * The `find` tool (spec 08).
 *
 * Ports pi's `find` execute logic, stripped of all pi-package/TUI/operations
 * coupling: `ensureTool("fd", true)` (→ `isToolAvailable("fd")` presence check —
 * no download, no Node fallback), `FindOperations` (→ direct `fd` spawn),
 * `typebox` (→ plain JSON-Schema literal), and the `AbortSignal` plumbing
 * (unreachable in v1 — `ToolModule.execute` carries no signal, mirroring
 * `bash`/`grep`). Every render/TUI helper is gone.
 *
 * Spawns `fd --glob … <searchPath>`, collects stdout path lines, and relativizes
 * each against the search root (fd emits absolute paths for an absolute search
 * root; directory entries keep their trailing `/`; separators normalize to
 * POSIX). `--max-results` bounds the result set at the fd side — there is no
 * client-side kill (unlike `grep`, whose match cap kills mid-stream) — so the
 * close handler is plain. fd exits **0** even on no-match (unlike rg's exit 1),
 * so an empty result is signalled by empty output, not a non-zero exit; only a
 * non-zero exit with **no** output is an error (with output it's a partial
 * success). pi throws on missing-fd / failing exit; here those become `err(...)`.
 * Like `grep`, find manages its own streaming and does **not** use `io.ts`; the
 * try/catch-free body composes via `Result` (the spawn lifecycle already
 * resolves to a `Result`, narrowed at the `await`).
 */
import { spawn } from "node:child_process";
import { relative, sep } from "node:path";
import { createInterface } from "node:readline";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import { isToolAvailable } from "./bin.ts";
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
 * Spawn `fd` with the given args and collect stdout path lines. The child's own
 * lifecycle resolves to a `Result`, so `execute` can `await` + short-circuit
 * with no try/catch (the Result-spine convention; `grep` resolves the same way).
 */
function runFd(fdArgs: string[]): Promise<Result<{ lines: string[] }, Error>> {
	return new Promise((resolve) => {
		const child = spawn("fd", fdArgs, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderr = "";
		let settled = false;
		const lines: string[] = [];

		const settle = (r: Result<{ lines: string[] }, Error>): void => {
			if (!settled) {
				settled = true;
				resolve(r);
			}
		};

		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		rl.on("line", (line) => {
			lines.push(line);
		});

		child.on("error", (error) => {
			rl.close();
			settle(err(new Error(`Failed to run fd: ${error.message}`)));
		});

		child.on("close", (code) => {
			rl.close();
			const output = lines.join("\n");
			// fd exits 0 even on no-match; non-zero only on real failure. A non-zero
			// exit with no output is an error (surface stderr or a code message); with
			// output it's a partial success — fall through and relativize what we have.
			if (code !== 0 && !output) {
				const msg = stderr.trim() || `fd exited with code ${code}`;
				settle(err(new Error(msg)));
				return;
			}
			settle(ok({ lines }));
		});
	});
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
	async execute(args, rootDir) {
		// Validate external args at the boundary (no zod; hand-narrowed).
		const pattern = args.pattern;
		if (typeof pattern !== "string") {
			return err(new Error("find requires a string 'pattern' argument"));
		}
		const searchDir = typeof args.path === "string" ? args.path : undefined;
		const limit = typeof args.limit === "number" ? args.limit : undefined;

		if (!isToolAvailable("fd")) {
			return err(new Error(FD_MISSING));
		}

		const searchPath = resolveToCwd(searchDir || ".", rootDir);
		const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

		// Build fd args (verbatim from pi). --no-require-git applies hierarchical
		// .gitignore semantics whether or not the search path is inside a git repo,
		// without leaking sibling-directory rules the way --ignore-file (a global
		// source) would.
		const fdArgs: string[] = [
			"--glob",
			"--color=never",
			"--hidden",
			"--no-require-git",
			"--max-results",
			String(effectiveLimit),
		];

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

		const searchRes = await runFd(fdArgs);
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
