/**
 * The `edit` tool — exact-text replacement (spec 06, item 06b).
 *
 * Ports pi's `edit` `execute` + `validateEditInput` + `prepareEditArguments`,
 * stripped of everything UI/agent-coupled: `pi-tui`, render/preview, the
 * `EditOperations` interface seam, `withFileMutationQueue`, and the
 * `details` diff/patch generation (OpenHammer has no TUI → no `diff` dep). The
 * body is the faithful pi sequence: `resolveToCwd` → `access(R_OK|W_OK)` → read
 * UTF-8 → `stripBom` → `detectLineEnding` → `normalizeToLF` →
 * `applyEditsToNormalizedContent` → `restoreLineEndings` → write → report
 * `Successfully replaced ${edits.length} block(s) in ${path}.` (original arg path,
 * not the resolved absolute path — matches pi and `write`).
 *
 * One deliberate divergence from pi's shape: every expected failure returns
 * `err(new Error(...))`, never throws. pi's `validateEditInput` throws on an
 * empty/non-array `edits`; here it returns a `Result`, so `execute` composes it
 * with zero try/catch. `applyEditsToNormalizedContent` already returns a `Result`
 * (spec 06a). File I/O goes through `io.ts` Result-wrappers, so the body has zero
 * try/catch — the MCP `CallTool` handler (spec 12) is the single narrowing point.
 */
import { constants } from "node:fs";
import type { ToolModule, ToolOk } from "../mcp/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	normalizeToLF,
	restoreLineEndings,
	stripBom,
} from "./edit-diff.ts";
import { access, readFile, writeFile } from "./io.ts";
import { resolveToCwd } from "./path-utils.ts";
import { err, ok, type Result } from "./result.ts";

/** Normalized edit-tool input (after `prepareEditArguments` + `validateEditInput`). */
interface EditInput {
	path: string;
	edits: Edit[];
}

/**
 * Tolerate models that send `edits` as a JSON string (parse it into an array) and
 * the legacy `{oldText, newText}` form (fold into a single-element `edits` array).
 * Pure — never throws; ported verbatim from pi's `prepareEditArguments`.
 */
export function prepareEditArguments(input: unknown): Record<string, unknown> {
	if (!input || typeof input !== "object") {
		return input as Record<string, unknown>;
	}

	const args = { ...(input as Record<string, unknown>) };

	// Some models send edits as a JSON string instead of an array.
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) {
				args.edits = parsed;
			}
		} catch {
			// Not valid JSON — leave `edits` as the original string; validation rejects it.
		}
	}

	// Legacy {oldText, newText} → fold into edits[].
	if (typeof args.oldText === "string" && typeof args.newText === "string") {
		const edits = Array.isArray(args.edits) ? [...(args.edits as unknown[])] : [];
		edits.push({ oldText: args.oldText, newText: args.newText });
		delete args.oldText;
		delete args.newText;
		args.edits = edits;
	}

	return args;
}

/**
 * Validate external args at the boundary (no zod; hand-narrowed). `edits` must be a
 * non-empty array of `{oldText,newText}` strings, and `path` must be a string.
 * Returns a `Result` (never throws) so `execute` composes it without try/catch.
 */
export function validateEditInput(input: Record<string, unknown>): Result<EditInput, Error> {
	const rawEdits = input.edits;
	if (!Array.isArray(rawEdits) || rawEdits.length === 0) {
		return err(new Error("Edit tool input is invalid. edits must contain at least one replacement."));
	}

	const edits: Edit[] = [];
	for (const entry of rawEdits) {
		if (!entry || typeof entry !== "object") {
			return err(new Error("Each edit requires string 'oldText' and 'newText'."));
		}
		const record = entry as Record<string, unknown>;
		if (typeof record.oldText !== "string" || typeof record.newText !== "string") {
			return err(new Error("Each edit requires string 'oldText' and 'newText'."));
		}
		edits.push({ oldText: record.oldText, newText: record.newText });
	}

	const path = input.path;
	if (typeof path !== "string") {
		return err(new Error("edit requires a string 'path' argument"));
	}

	return ok({ path, edits });
}

/** Extract an `ErrnoException.code` ("ENOENT", "EACCES", …) if present, else null. */
function errnoCode(error: Error): string | null {
	if ("code" in error && typeof error.code === "string") {
		return error.code;
	}
	return null;
}

export const editTool: ToolModule = {
	name: "edit",
	description:
		"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
	inputSchema: {
		type: "object",
		properties: {
			path: { type: "string", description: "Path to the file to edit (relative or absolute)" },
			edits: {
				type: "array",
				description:
					"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
				items: {
					type: "object",
					properties: {
						oldText: {
							type: "string",
							description:
								"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
						},
						newText: { type: "string", description: "Replacement text for this targeted edit." },
					},
					required: ["oldText", "newText"],
					additionalProperties: false,
				},
			},
		},
		required: ["path", "edits"],
		additionalProperties: false,
	},
	async execute(args, rootDir) {
		// Normalize (JSON-string edits / legacy form), then validate at the boundary.
		const prepared = prepareEditArguments(args);
		const validated = validateEditInput(prepared);
		if (!validated.ok) {
			return err(validated.error);
		}
		const { path, edits } = validated.value;

		const absolutePath = resolveToCwd(path, rootDir);

		// Must be readable + writable (pi: R_OK | W_OK). On failure, mirror pi's message.
		const accessRes = await access(absolutePath, constants.R_OK | constants.W_OK);
		if (!accessRes.ok) {
			const code = errnoCode(accessRes.error);
			const detail = code !== null ? `Error code: ${code}` : String(accessRes.error);
			return err(new Error(`Could not edit file: ${path}. ${detail}.`));
		}

		// Read UTF-8, strip BOM (the model won't include an invisible BOM in oldText),
		// detect the original line ending, and normalize to LF for matching.
		const bufferRes = await readFile(absolutePath);
		if (!bufferRes.ok) {
			return err(bufferRes.error);
		}
		const rawContent = bufferRes.value.toString("utf-8");
		const { bom, text: content } = stripBom(rawContent);
		const originalEnding = detectLineEnding(content);
		const normalizedContent = normalizeToLF(content);

		// Apply the edits against the normalized content (Result-returning; never throws).
		const applied = applyEditsToNormalizedContent(normalizedContent, edits, path);
		if (!applied.ok) {
			return err(applied.error);
		}

		// Restore the original line ending + BOM, then write back.
		const finalContent = bom + restoreLineEndings(applied.value.newContent, originalEnding);
		const writeRes = await writeFile(absolutePath, finalContent, "utf-8");
		if (!writeRes.ok) {
			return err(writeRes.error);
		}

		const toolOk: ToolOk = {
			content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
		};
		return ok(toolOk);
	},
};
