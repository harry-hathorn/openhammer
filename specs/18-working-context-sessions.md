# 18 — Tool Orientation `guide` (+ Sessions/Memory, deferred)

## Purpose
Two things, deliberately split:
- **In scope (Phase A):** a single `guide` tool that returns a concise, evolvable orientation — what OpenHammer is, the 7 tools, and crucially **the working-root contract** (paths resolve under `MCP_ROOT_DIR`; `bash` cwd resets each call; use absolute paths). This makes the working directory obvious to the client **without bloating every tool's description** — tool definitions stay precise; the guide is read once and evolves as the MCP grows.
- **Deferred (Phase B):** per-session `cwd` + memory. **Moved out of the build loop** into `docs/agent-harness-design.md` (+ `specs/99`); reconcile with that doc's stateless thesis before actioning (see "Deferred").

## Phase A — the `guide` tool (in scope, stateless)
### `src/tools/guide.ts` — `guideTool: ToolModule`
- Name `guide`, no params, description *"Read this first — how OpenHammer's tools work + your working root."* Returns markdown built from `config.rootDir` + a template:
  - **What OpenHammer is:** a stateless MCP server with no LLM; it executes tools rooted at `MCP_ROOT_DIR`.
  - **Working root:** `<abs rootDir>` — all paths resolve under it; `bash` runs here and its cwd **does not persist** across calls; **use absolute paths** to avoid landing in the wrong directory.
  - The 7 tools, one line each (`read`/`bash`/`edit`/`write`/`grep`/`find`/`ls`).
  - Workflow notes: output is bounded (per-tool truncation + the `response_too_large` backstop); there is no memory between calls; `bash` reaches anything the OS user can — run in a container to jail it.
  - "This guide evolves as OpenHammer grows."
- Registered so `tools/list` includes it (an 8th entry: 7 capability tools + `guide`). The 7 capability tools' descriptions stay **unchanged and lean** — no per-tool working-root line.
- **Alternative considered:** MCP's `InitializeResult.instructions` (auto-delivered on connect, not a tool). Viable and arguably better (no call needed, doesn't grow `tools/list`), but `guide` is on-demand, evolvable, and matches the established `get_guide` pattern clients already call. Ship `guide`; revisit `instructions` if clients don't invoke it.

### Result-path honesty (minor, fold into 18a)
Verify `read`/`write`/`edit`/`grep`/`find`/`ls` emit the **absolute resolved path** in results (most already do via `resolveToCwd`) — so a wrong-dir op is visible in the result, not silent. No definition bloat; just accurate output.

## Acceptance criteria (Phase A)
- `tools/list` exposes a `guide` tool; the 7 capability tools' descriptions are **unchanged** (not bloated with a working-root line).
- Calling `guide` returns markdown containing the resolved working root + the "use absolute paths / bash cwd doesn't persist" contract.
- fs-tool results show absolute resolved paths.
- Hermetic trio green; the existing "7 tools" assertions update to "7 + `guide`".

## Deferred — Sessions & Memory (Phase B, NOT in the build loop)
Per-session `cwd` persistence + memory. **Removed from the pickable checkboxes** — the earlier sketch (enable MCP `sessionIdGenerator`, per-session cwd via an `ExecutionEnv` ported from pi's `packages/agent/src/harness/`, JSONL at `~/.openhammer/sessions/…`) is recorded only as a candidate, because:

⚠️ **It must be reconciled with `docs/agent-harness-design.md`'s governing thesis before it's even the right design.** That doc states: OpenHammer is the **substrate + agent-definition store, never the brain**; memory = files under `MCP_ROOT_DIR`; the **provider owns the loop**; server-side stateful sessions are explicitly **rejected** (Part 5A). pi has in-process sessions because pi *is* the long-running agent — OpenHammer deliberately is not. The likely OpenHammer-shaped answer is **agent-as-directory pins a working root per agent** (file-based, stateless), not server session state. Decide which before building. See `docs/agent-harness-design.md` Parts 2/4/5 and `specs/99`.

## Decisions & deviations
- **Guide tool, not per-tool description bloat** — the working-root contract lives in one evolvable `guide` tool read once; tool definitions stay precise. (Replaces the earlier "bake the root into every description" idea — rejected as repetitive/bloated.)
- **Phase B deferred, not gated** — removed from the build loop entirely (not a pickable checkbox) and recorded in `docs/agent-harness-design.md`, because it needs reconciliation with the stateless thesis before it's the right design.
- **`guide` is an 8th tool** — the "7 capability tools" identity is preserved; `guide` is orientation, not a capability.

## Suggested plan items (atomic checkboxes)
- [ ] 18a — `src/tools/guide.ts` (`guideTool`): markdown orientation incl. the resolved working root + "use absolute paths" contract; register in `createAllTools` (8th tool); verify fs results emit absolute resolved paths. + tests. *deps: 10, 03–09.*
- [ ] 18b — tests: `guide` returns the root + contract; `tools/list` includes `guide`; the 7 capability descriptions are unchanged. *deps: 18a.*
- *(Phase B sessions/memory: deferred to `docs/agent-harness-design.md` — not a pickable checkbox.)*
