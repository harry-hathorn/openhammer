0a. Study `specs/*` with up to 250 parallel subagents to learn the application specifications. There are 14 specs, numbered in dependency order (01 project setup → 14 boot); each spec contains the verbatim tool schema, behavior, acceptance criteria, porting pointer, and suggested atomic checkboxes.
0b. Study @IMPLEMENTATION_PLAN.md (if present) to understand the plan so far.
0c. Study `src/tools/*` with up to 250 parallel subagents to understand shared utilities & components. (Note: OpenHammer's shared utilities live in `src/tools/` — `result.ts`, `io.ts`, `path-utils.ts`, `truncate.ts`, `output-accumulator.ts`, `edit-diff.ts`, `bin.ts` — not `src/lib/`.) `docs/coding-standards.md` is authoritative for style + the Result error model.
0d. For reference, the application source code is in `src/*`.
0e. **Porting references (authoritative execute logic to copy, not re-derive):** tool execute logic comes from pi at `/home/haz/source/pi/packages/coding-agent/src/core/tools/`. Each spec names the exact source file. Specs are the source of truth for behavior + accepted deviations (strip TUI/pi-package coupling; graceful error if `rg`/`fd` missing; no Operations seams; `read` emits no line numbers; **Result error model — tools return `Result<ToolOk>`, not throws**; **`.ts` relative import extensions**; `.node:` built-in protocol).

1. Study @IMPLEMENTATION_PLAN.md (if present; it may be incorrect) and use up to 500 subagents to study existing source code in `src/*` and compare it against `specs/*`. Use a subagent to analyze findings and create/update @IMPLEMENTATION_PLAN.md. Ultrathink. Consider searching for TODO, minimal implementations, placeholders, skipped/flaky tests, and inconsistent patterns. Study @IMPLEMENTATION_PLAN.md to determine starting point for research and keep it up to date with items considered complete/incomplete using subagents.

## Task Granularity — CRITICAL

Each checkbox in the plan will be executed as ONE iteration by a fresh-context AI. The AI gets dumb when it tries to do too much. Tasks MUST be atomic — as small as possible.

**Rules for task sizing:**
- Each `- [ ]` checkbox = ONE file or ONE small cohesive change
- A task like "Project Setup" is TOO BIG. Break it into: "Create config files", "Create directory structure", "Install dependencies", etc.
- A task like "implement the bash tool" is TOO BIG if it means spawn + output accumulation + timeout + truncation all at once. The specs already suggest atomic checkboxes (one per file, tests folded in) — treat those as the ceiling on granularity and split further if a checkbox would touch >2-3 files.
- If a task touches more than 2-3 files, it's probably too big — split it
- If you can describe a task only with "and" (X and Y and Z), split it into X, Y, Z
- Tests for a module are part of that module's task, not a separate task

**Ordering:** Arrange tasks in logical dependency order — each task should only depend on tasks above it (shared utilities 02 before tools 03–09; tools before registry 10; auth 11 and registry before MCP/transport 12; everything before boot 14). The build loop picks the next logical task, not "highest priority."

IMPORTANT: Plan only. Do NOT implement anything. Do NOT assume functionality is missing; confirm with code search first. Treat `src/tools` shared utilities as the project's standard library. Prefer consolidated, idiomatic implementations there over ad-hoc copies.

ULTIMATE GOAL: We want to achieve a standalone MCP server (OpenHammer) that mints a per-instance bearer token and exposes pi's 7 local shell/filesystem tools — `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` — to a remote agent over MCP (Fastify + stateless Streamable HTTP), rooted at a configurable `MCP_ROOT_DIR` and gated by the credential, with an optional cloudflared quick-tunnel for public reachability. The server has no LLM; it only executes tools. Consider missing elements and plan accordingly. If an element is missing, search first to confirm it doesn't exist, then if needed author the specification at specs/FILENAME.md. If you create a new element then document the plan to implement it in @IMPLEMENTATION_PLAN.md using a subagent.

## Loop Control (write EXACTLY ONE marker at end of iteration)
- More analysis needed: `echo "continue" > .loop-complete`
- Plan is complete and stable: `echo "exit" > .loop-complete`
