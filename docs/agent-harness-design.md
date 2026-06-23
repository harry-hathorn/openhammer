# OpenHammer → Agent Harness: Learning & Ideation

> A design journal capturing research findings (pi, pi-docs, eve) and reasoning about the ideal future implementation. This is **not** a build spec — `specs/99-roadmap-agent-harness.md` is the actionable future-scope summary; this is the *why* and the *what-ifs*. Not read by the build loop.

## TL;DR
OpenHammer's highest-value future is to become the **filesystem-native home for agents**: agents live as directories of plain files (instructions, skills, memory, agenda, *and* tools), surfaced to any MCP client — the user's LLM provider — which owns the loop. The agent loop, model calls, and compaction **never** live in OpenHammer. This realizes the "agents are best defined on the filesystem" thesis **more completely than pi or eve**, because bash being native means even *tools* can be files (pi/eve require code for tools). The whole thing stays stateless, composable, and true to step one.

---

## Part 1 — What the research shows

### The unifying model (pi + eve agree)
Both define an agent as files on disk, discovered by walking a directory tree, with **identity derived from path** (no `name`/`id` field — the filename/dirname *is* the identity). The agent concepts split cleanly:

| Concept | On disk? | pi location | eve location |
|---|---|---|---|
| System / persona prompt | ✅ markdown | `SYSTEM.md` + `AGENTS.md` (walked up to root) | `instructions.md` (root, required) |
| Skills (progressive disclosure) | ✅ `SKILL.md` + `description` frontmatter | `~/.pi/agent/skills`, `<cwd>/.pi/skills` | `agent/skills/` |
| Context / long-term instructions | ✅ markdown | `AGENTS.md` / `CLAUDE.md` | (folded into instructions) |
| Memory / sessions | ✅ JSONL tree (pi) / durable store (eve) | `~/.pi/agent/sessions/…jsonl` | Workflow SDK (`.workflow-data`) |
| Settings | ✅ JSON | `~/.pi/agent/settings.json` + project | `agent/agent.ts` (`defineAgent`) |
| **Tools** | ❌ **code** (`defineTool`) | `packages/…/tools/` + extensions | `agent/tools/*.ts` |
| The loop, compaction, hooks | ❌ runtime code | `packages/agent` harness | eve runtime + Workflow SDK |
| Subagents | ✅ nested dirs / files | `agents/*.md` (extension convention) | `agent/subagents/<id>/` |

**Three findings that shaped the design:**

1. **Tools are code in both pi and eve — not files.** Prompts, skills, memory, sessions are files; tools are TypeScript (`defineTool`). This is a limit of their model, not a virtue.
2. **The loop/compaction/hook layer is SDK- and state-bound.** pi's 17-event hook chain (`before_provider_request`, `tool_call` blocking, `session_before_compact`, …), eve's step-checkpointed Workflow SDK, crash-safe resume, parked-work suspension — none of this transfers to a *stateless* MCP server where some other client owns the model. eve's own conclusion: *"borrow the filesystem conventions wholesale, keep the loop/memory on the client side of the protocol boundary."*
3. **eve is an MCP *client*, not a server.** It consumes external shell/fs MCP servers as "connections" with brokered auth. So "my LLM provider drives an agent over MCP, OpenHammer serves it" is the **textbook MCP division of labor**, not a custom architecture. This is strong corroboration of the user's instinct.

### Skill shape (verbatim, pi)
```yaml
---
name: valid-skill          # optional; defaults to parent dir; ^[a-z0-9-]+$, ≤64 chars
description: A valid skill. # required; ≤1024 chars
disable-model-invocation: false  # optional: hide from model, still callable explicitly
---
<body: markdown the model reads on demand>
```
eve aligns with the same **Agent Skills standard** ("a skill authored against that standard ports over as-is"). Adopting `SKILL.md` verbatim gives interoperability for free.

### Progressive disclosure (both)
Skill *descriptions* are advertised to the model up front (small); the *body* is loaded only when a turn needs it (pi: model reads the file via the `read` tool; eve: a framework-owned `load_skill` tool). This keeps context small — critical over a stateless protocol where you don't want to ship every skill body on every turn.

---

## Part 2 — The governing architectural principle

**Declarative content is addressable (resources/prompts); imperative behavior is the client's job (the loop). OpenHammer is the substrate + the agent-definition store, never the brain.**

Why this is the right cut:
- **Composability.** Any MCP client (pi, Claude Code, eve-as-client, a custom provider) can drive agents defined here. No lock-in to one runtime.
- **Stateless simplicity.** Memory = files; the server needs no durability/compaction machinery. Matches step one exactly.
- **Matches MCP's design.** MCP already separates `tools` (actions), `resources` (addressable data), `prompts` (parameterized templates). The agent concepts map 1:1 — no fighting the protocol.
- **It's what the user asked for.** "In my LLM provider plugged into the MCP I should be able to invoke a certain agent" — the provider *is* the loop owner by definition.

The single biggest mistake to avoid: being tempted to "just add a small LLM loop in the server for convenience." That couples OpenHammer to a model/runtime, breaks statelessness, and poorly reimplements pi/eve's actual moat (their loop + durability). Resist it. (This is now a guardrail line in `AGENTS.md`.)

---

## Part 3 — OpenHammer's differentiator: tools as filesystem

Because `bash` is a first-class tool, **a "tool" can be a file**: a markdown skill that tells the agent how/when to run a command, or a shell script the agent invokes via `bash` with documented args. Concretely:

```
agents/deployer/tools/release.md      # "to cut a release, run scripts/release.sh <ver>"
agents/deployer/scripts/release.sh    # the actual executable
```

The agent reads `release.md` (a resource), then executes `scripts/release.sh` through the `bash` tool. **No TypeScript, no rebuild, no `defineTool`.** A non-developer can add a new agent capability by dropping markdown + a script into `tools/`.

This is more filesystem-pure than pi *or* eve — both stop at "tools are code." OpenHammer completes the thesis: prompts, skills, memory, agendas, **and tools** are all files. That's the moat.

(Caveat, documented not hidden: filesystem-defined tools that wrap arbitrary bash run with the agent's — i.e., the container's — privileges. Since OpenHammer isn't jailed anyway and docker is the jail, this is consistent. But `tools/*.md` authoring is a trust boundary, same as the `bash` tool itself.)

---

## Part 4 — The ideal future implementation

### 4.1 Agent directory convention (under `MCP_ROOT_DIR`)
```
<root>/
├── agents/
│   └── <agent-name>/            # name = path; validated ^[a-z0-9-]+$
│       ├── instructions.md       # always-on system prompt
│       ├── skills/
│       │   ├── <skill>.md        # flat skill
│       │   └── <skill>/SKILL.md  # packaged skill (+ references/, scripts/)
│       ├── tools/
│       │   └── <tool>.md         # filesystem-defined tool (wraps a bash command/script)
│       ├── memory/
│       │   ├── log.jsonl         # append-only episodic memory (one JSON obj/line)
│       │   └── summary.md        # semantic/compacted memory (provider-managed)
│       └── agenda.md             # durable todo list
└── shared/                       # cross-agent skills/lib (a la eve's lib/)
```
Borrow pi/eve conventions wholesale: path-as-identity, `SKILL.md` + `description` frontmatter, ancestor `AGENTS.md`-style instructions. Add `tools/` (Part 3).

### 4.2 MCP surfacing (additive to the v1 `tools` capability)
**resources/** (read-only, addressable — the declarative half):
- `agent://index` → catalog: every agent + each skill's `{name, description}` (descriptions only — progressive disclosure).
- `agent://<name>/instructions` → `instructions.md`.
- `agent://<name>/skills/<skill>` → one skill body (loaded on demand).
- `agent://<name>/memory` → current memory (log tail + summary), bounded by the v1 truncation utils + `MAX_RESPONSE_BYTES`.
- `agent://<name>/agenda` → `agenda.md`.

**prompts/** (parameterized entry points — the "invoke an agent" surface):
- `invoke-agent(agent, message)` → assembles `[instructions + skill catalog + memory summary]` into prompt messages and returns them. The client then runs its loop with that context. This is the primary "use a certain agent" entry.
- `load-skill(agent, skill)` → returns one skill body (progressive-disclosure helper, for clients that prefer prompt semantics over resource reads).

**tools/** (alongside the 7 shell/fs tools — the small structured-mutation layer):
- `list_agents` → the index (tool form of the resource, for clients that only speak tools).
- `append_memory(agent, entry)` → append one JSON line to `memory/log.jsonl`.
- `update_agenda(agent, ops)` → add/complete/reorder items in `agenda.md` (atomic write).
- Optional `write_memory_summary(agent, summary)` → provider-driven compaction writes `memory/summary.md`.

Note the whole layer is optional sugar: a client can also just author/read/edit agent files directly with the v1 `read`/`write`/`edit`/`bash` tools. The resources/prompts/harness-tools exist to make agents **first-class** and to encode conventions, not to gate anything.

### 4.3 Memory model (stateless by design)
- **Episodic** = append-only `memory/log.jsonl` (`{ts, type, content}` per line), written only by `append_memory`.
- **Semantic/compacted** = `memory/summary.md`, written by the **provider** (it owns compaction), not the server.
- The provider reads `log.jsonl` + `summary.md` into context each turn (via resources or fs tools) and compacts when it decides to. OpenHammer never compacts, never calls an LLM, never holds a conversation in memory.
- Growth safety: resource responses reuse the v1 `truncate` utils + `MAX_RESPONSE_BYTES`, so an unbounded log can't blow up a single response — it nudges the provider to compact.

### 4.4 The loop lives in the client
1. Provider connects to OpenHammer as an MCP client (bearer token, step one auth).
2. To run agent X: call `invoke-agent("X", msg)` → get assembled context.
3. Provider runs **its own** LLM loop, calling OpenHammer tools (`bash`, `read`/`write`/`edit`, `append_memory`, `update_agenda`) as the agent acts.
4. Provider persists memory/agenda back through OpenHammer tools.
5. OpenHammer is stateless across it all.

---

## Part 5 — Alternatives considered (and rejected)

- **A. Full in-server loop (eve-style).** *Rejected.* Couples OpenHammer to a model/runtime, breaks statelessness, poorly reinvents pi/eve's moat, and contradicts the user's "my provider drives it" requirement. The loop must be client-side.
- **B. Hybrid: optional server-side loop for headless/scheduled agents.** *Deferred (possible v4).* Adds a stateful mode for agents that must run unattended. Real product, separate from the core vision; only build if there's a concrete need.
- **C. Resources-only (skip prompts/harness-tools).** *Rejected.* Without `invoke-agent`/`load-skill`/`append_memory`/`update_agenda`, agents aren't first-class — the provider fumbles everything through raw fs tools. The small additions pay for themselves in ergonomics and encoded conventions.
- **D. Per-agent subprocess isolation (pi's subagent model).** *Rejected for OpenHammer.* One server, many agents-as-directories, the provider multiplexes. Isolation = docker (already decided). Spawning a process per agent is overkill here.
- **E. A custom binary protocol instead of MCP resources/prompts.** *Rejected.* MCP already has resources/prompts; inventing a parallel surface fights the ecosystem and breaks the "any MCP client can drive it" property.

---

## Part 6 — Open questions & risks

1. **Client support for resources/prompts varies.** Tools are universal across MCP clients; `resources`/`prompts` support is uneven. *Mitigation:* expose the same data as tools too (`list_agents`, etc.) so a tools-only client still works. **This is the #1 adoption risk — design every surface to degrade gracefully to tools.**
2. **Per-agent authorization/scoping.** v1 has one bearer token for the whole server. A future "read-only agent" or per-agent tool scopes is an auth extension. Open.
3. **Concurrent writes to one agent.** Multiple clients writing `append_memory`/`update_agenda` to the same agent could race. Append-only JSONL + atomic file writes mostly mitigate; a per-agent write lock is a later option if needed.
4. **Discovery cost at scale.** Scanning `agents/*/skills/` on every resource read could get slow with many agents/skills. *Mitigation:* cache the index, invalidate on fs change (pi's `ResourceLoader.reload()` pattern).
5. **Naive providers that never compact.** `memory/log.jsonl` grows unbounded. *Mitigation:* resource responses truncate (4.3), nudging compaction; can't fully prevent a bad client, and that's acceptable — the server stays dumb on purpose.
6. **Trust boundary of `tools/*.md`.** Filesystem-defined tools run arbitrary bash. Consistent with the `bash` tool not being jailed (docker is the jail), but authoring `tools/` is a privileged action — document it.
7. **Per-client cwd-persistence via MCP sessions (spec 18 Phase B).** A real client (Claude Code) wrote to the wrong directory because OpenHammer is root-pinned + stateless (`bash` cwd resets each call). The tempting fix — enable MCP `sessionIdGenerator` + per-session cwd/memory ported from pi's `packages/agent/src/harness/` — is **in tension with this doc's thesis**: OpenHammer is the stateless substrate, memory = files under `MCP_ROOT_DIR`, the provider owns the loop (Parts 2 & 5A). pi has in-process sessions because pi *is* the long-running agent; OpenHammer is not. **The OpenHammer-shaped answer is likely the agent-as-directory convention pins a working root per agent** (file-based), plus the provider tracking cwd as loop owner — not server session state. The near-term fix is **spec 18 Phase A: a `guide` tool** that states the working root + "use absolute paths" without bloating tool definitions. Reconcile this session question here before actioning Phase B.

---

## Part 7 — Phasing

- **v1 (specs 01–14):** the 7 shell/fs tools. Ship and verify with a real MCP client first.
- **v2 (step two — specs 15+):** enable `resources` + `prompts`; agent-directory convention + loader; `list_agents` / `append_memory` / `update_agenda` tools; `invoke-agent` / `load-skill` prompts. Still no loop.
- **v3 (optional):** a **reference client library** (separate package, not in OpenHammer) that drives an agent from OpenHammer — a thin loop consumers can import. Proves the model; lives outside the server.
- **v4 (only if needed):** a headless/scheduled agent *mode* (stateful server-side loop) for agents that must run unattended. Separate product; defer until a concrete need exists.

---

## Part 8 — Pointers for future drilling

**pi-docs** (`/home/haz/source/pi-docs/`):
- `11a_agent_harness.md` — the harness (orchestrator above the loop).
- `11d_agent_skills_prompts.md`, `23_coding_prompt_skills.md` — skills & prompts on disk (frontmatter, discovery).
- `11b_agent_session.md`, `11c_agent_compaction.md` — JSONL sessions, compaction strategy + verbatim prompts.
- `10_agent_core.md` — the inner agent loop.
- `20_coding_extensions.md`, `19c_tool_infra.md` — extension system; tools are code.

**pi source** (`/home/haz/source/pi/`):
- `packages/agent/src/harness/agent-harness.ts` — `AgentHarness` (`prompt`/`skill`/`compact`).
- `packages/agent/src/agent-loop.ts` — `runLoop` / `executeToolCalls`.
- `packages/agent/src/harness/{skills,prompt-templates,system-prompt}.ts` — loaders + `formatSkillsForSystemPrompt`.
- `packages/agent/src/harness/session/{session,jsonl-storage,jsonl-repo}.ts` — JSONL tree storage.
- `packages/agent/src/harness/compaction/{compaction,branch-summarization}.ts`.
- `packages/coding-agent/src/core/{resource-loader,skills,prompt-templates,system-prompt,settings-manager,session-manager}.ts`.
- `packages/coding-agent/examples/extensions/subagent/` — reference: `agents/*.md` subagent definitions.

**eve docs** (`/home/haz/source/eve/docs/`):
- `introduction.mdx`, `README.md` — "filesystem-first framework for durable backend agents."
- `reference/project-layout.md` — the slot table (`instructions` vs `skills` vs `tools` vs `connections` vs `subagents` vs `lib`).
- `tools/overview.mdx`, `skills.mdx`, `instructions.mdx` — tool/skill/instruction shapes.
- `concepts/{execution-model-and-durability,sessions-runs-and-streaming,context-control}.md` — durability, the two-handle API, compaction.
- `connections.mdx` — eve as **MCP client** (`defineMcpClientConnection`), brokered auth.

---

## Bottom line
The ideal implementation is the one that changes OpenHammer the *least*: keep it stateless, keep the loop in the client, and add a resources/prompts surface + a few harness tools so agents-as-directories become first-class. The result is more filesystem-pure than pi or eve (tools are files too), composable with any MCP client, and a natural continuation of step one rather than a rewrite.
