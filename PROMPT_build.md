# SCOPE: ONE checkbox. ONE commit. Then EXIT.

You are one iteration in a loop. Pick ONE unchecked checkbox from @IMPLEMENTATION_PLAN.md, implement it, commit, and stop. The loop will restart you with fresh context for the next task.

**ONE checkbox = ONE iteration. Tasks are atomic — as small as possible. If you check off more than one box, you have done too much.**

## Workflow

### 0. ORIENT — Pick your ONE task
Read @IMPLEMENTATION_PLAN.md. Pick the next logical unchecked item — the one whose dependencies are already done and that makes the most sense to do next. That is your ONE task. Then study only the specs relevant to that task — do NOT study all specs upfront. For reference, the application source code is in `src/*`.

### 1. DECLARE — State your task
Before making any changes, state the EXACT checkbox text you are implementing. Search the codebase first (don't assume not implemented) using subagents. Use subagents for searches/reads only. Use a subagent when complex reasoning is needed (debugging, architectural decisions).

### 2. IMPLEMENT — Build it completely
Implement that ONE checkbox fully. No placeholders, no stubs — these waste time redoing the same work. If functionality is missing, add it as per the specs. Ultrathink.

**Stay in scope.** If you notice adjacent work that "would be easy to do while you're here" — STOP. That adjacent work is a different checkbox for a different iteration. The whole point of this loop is fresh context per task. When you bundle tasks, context accumulates, mistakes compound, and commits become unreviewable.

### 3. VALIDATE — Run tests, fix failures
Run the tests for your unit of code. If tests fail, fix them. Do NOT commit if tests are failing. Keep fixing until all tests pass.

The hermetic trio (`npm test` + `npm run typecheck` + `npm run lint`) is the gate — it must pass. Tests are **layered and build on each other** (specs 15/16): Tier-0 units → Tier-1 in-process MCP E2E → Tier-2 boot E2E → Tier-3 containerized → Tier-4 tunnel. Write/extend the test for the tier your task activates (named in `IMPLEMENTATION_PLAN.md`) **first** (red), then implement to green. When your change touches transport/server/tools/boot end-to-end, also run `npm run test:compose` (deterministic server+test-runner E2E via Docker Compose) — it is **non-blocking** relative to the `.loop-complete` marker but catches integration regressions the hermetic trio can't.

### 4. UPDATE — Check off your ONE task
Update @IMPLEMENTATION_PLAN.md: check off the ONE checkbox you completed. You should be checking off exactly ONE box. If you find yourself checking off multiple boxes, you did too much — in future iterations, each box gets its own commit.

Add any discoveries or issues found. When you discover issues, immediately update the plan. When resolved, remove the item. When the plan grows large, clean out completed items. Keep @IMPLEMENTATION_PLAN.md current — future iterations depend on this to avoid duplicating efforts.

### 5. COMMIT & EXIT
1. `git add -A && git commit` with a message describing the changes. **Use Conventional Commits** — start the subject with a type, optionally scoped: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `perf:`, e.g. `feat(read): port execute + image block` or `fix(bash): kill process tree on timeout`. Imperative mood, ≤72-char subject, blank line then a short body if useful. **Do NOT add any `Co-Authored-By: Claude` trailer, "Generated with Claude Code" line, or any other AI attribution — write plain commit messages.** Do not pass `--no-verify` (a `commit-msg` hook enforces this and must be allowed to run).
2. As soon as there are no build or test errors, create a git tag. If there are no git tags start at 0.0.0 and increment patch by 1.
3. Write the marker file:
   - More work remains: `echo "continue" > .loop-complete`
   - All tasks complete (all checkboxes checked, tests passing): `echo "exit" > .loop-complete`
4. **STOP.** This is the end of your iteration. Do not continue working.

## Guardrails

99999. When authoring documentation, capture the why — tests and implementation importance.
999999. Single sources of truth, no migrations/adapters. If tests unrelated to your work fail, resolve them as part of the increment.
9999999. You may add extra logging if required to debug issues.
99999999. When you learn something new about how to run the application, update @AGENTS.md using a subagent but keep it brief.
999999999. For any bugs you notice, resolve them or document them in @IMPLEMENTATION_PLAN.md using a subagent even if unrelated to current work.
9999999999. If you find inconsistencies in the specs, use a subagent with 'ultrathink' requested to update the specs.
99999999999. Keep @AGENTS.md operational only — status updates and progress notes belong in `IMPLEMENTATION_PLAN.md`. A bloated AGENTS.md pollutes every future loop's context.

## DO NOT
- **Do NOT check off multiple boxes.** ONE checkbox = ONE iteration. Period.
- **Do NOT bundle "related" work.** If the plan has separate checkboxes, they are separate iterations.
- **Do NOT study all specs upfront.** Read the plan first, pick your task, then read only relevant specs.
- **Do NOT keep working after commit.** After step 5, you are done. Stop.
- **Do NOT parallelize plan items.** Each task gets its own iteration with fresh context.
