# 99 — Roadmap: Filesystem-Defined Agent Harness

> 🚫 **STATUS: FUTURE SCOPE — OUT OF SCOPE FOR THE v1 LOOP.**
> This is a forward-looking design record for **step two**. **Do NOT add tasks from this spec to `IMPLEMENTATION_PLAN.md`, and do NOT implement it during the v1 OpenHammer build.** It exists so the intent is captured while fresh and so the v1 design (specs 01–14) doesn't accidentally close doors. Promote it to real specs (15+) only after step one ships and is verified end-to-end with a real MCP client.

## Purpose
Evolve OpenHammer from "shell + filesystem MCP server" into the **filesystem-native home for agents**: agents live as directories of plain files under `MCP_ROOT_DIR`, surfaced to any MCP client (the user's LLM provider) that drives the agent loop. OpenHammer stays a stateless tool / resource / prompt surface — it never hosts the loop.

## The one rule that governs everything
**The agent loop, model calls, and compaction live in the MCP client (the LLM provider). OpenHammer only (a) executes tools and (b) serves agent definitions as resources/prompts.** Non-negotiable. Full reasoning in `docs/agent-harness-design.md`.

## Agent directory convention (under `MCP_ROOT_DIR`)
```
<root>/agents/<agent-name>/        # name derived from path (no name field)
  instructions.md                  # always-on system prompt (a la AGENTS.md / eve instructions.md)
  skills/<skill>.md                # flat skill (description frontmatter)
  skills/<skill>/SKILL.md          # packaged skill (+ optional references/, scripts/)
  tools/<tool>.md                  # filesystem-defined tool = a shell skill / script
  memory/log.jsonl                 # append-only episodic memory
  memory/summary.md                # provider-managed compacted memory
  agenda.md                        # durable todo list
```
Borrowed from pi (`~/.pi/agent/…`) and eve (`agent/`): path-as-identity, skills as `SKILL.md` + `description` frontmatter, markdown instructions. **OpenHammer's addition:** a `tools/` directory — because `bash` is native, a "tool" can be a markdown skill or shell script the agent runs via the `bash` tool. So the *entire* agent (prompts, skills, memory, **and tools**) is files. pi and eve both require code for tools; OpenHammer doesn't — that's the differentiator.

## What step two adds to the v1 server (additive — no rewrite)
- **Enable MCP `resources` + `prompts` capabilities** on the `Server` (spec 12 enables only `tools` today). New request handlers, not a new architecture.
- **resources/**: `agent://index` (catalog of agents + skill descriptions), `agent://<name>/instructions`, `agent://<name>/skills[/<skill>]`, `agent://<name>/memory`, `agent://<name>/agenda`.
- **prompts/**: `invoke-agent(agent, message)` — assembles instructions + skill catalog + memory summary into prompt messages for the client; `load-skill(agent, skill)` — progressive disclosure (returns one skill body).
- **tools/** (alongside the 7): `list_agents`, `append_memory(agent, entry)`, `update_agenda(agent, ops)`. Optional: `write_memory_summary(agent, summary)`.

## What step two must NOT build in OpenHammer
- The agent loop / tool-call cycle.
- Any LLM provider integration or model call.
- Server-side compaction, session trees, or pi-style hook chains.
- A stateful server mode (v1 is stateless and stays so).

## What v1 must preserve to keep this door open (all already true)
- `Server` capabilities are extensible (`{ capabilities: { tools: {} } }` → add `resources`, `prompts`). ✅ spec 12.
- The 7 fs/bash tools already let a client author/read/edit agent files directly. ✅
- Truncation utilities (spec 02) are reused to bound resource/memory responses. ✅
- `MAX_RESPONSE_BYTES` backstop (spec 12) carries over to the new surfaces. ✅

## Acceptance criteria (when eventually promoted to real specs)
- An MCP client can `list_agents`, then `invoke-agent("researcher", "…")`, and receive assembled context (instructions + skill catalog + memory summary).
- A skill's body is loaded on demand via `load-skill`, not shipped in the catalog.
- `append_memory` appends exactly one JSON line to `memory/log.jsonl`; `update_agenda` mutates `agenda.md` atomically.
- No LLM is called by OpenHammer at any point.
- Existing v1 tool behavior and bearer auth are unchanged.

## Dependencies
v1 complete (specs 01–14) and verified with a real MCP client. Then this decomposes into specs 15+ (e.g. 15 agent-directory loader, 16 resources capability, 17 prompts capability, 18 harness tools).

## References
- Full reasoning + alternatives + risks: `docs/agent-harness-design.md`.
- Reference systems studied: pi (`/home/haz/source/pi`, docs `/home/haz/source/pi-docs`) and eve (`/home/haz/source/eve/docs`).
