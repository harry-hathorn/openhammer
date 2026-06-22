# 04 — Tool: `bash`

> **Error model:** `execute` returns `Promise<Result<ToolOk, Error>>`. In this spec, "throw X" / "`isError`" means `return err(new Error(X))`; a normal return means `return ok({ content: [...] })`. Tools never throw for expected failures — the MCP layer (spec 12) narrows. See spec 02 (`result.ts`/`io.ts`) + `docs/coding-standards.md`.

## Purpose
Execute a shell command at `MCP_ROOT_DIR`, return merged stdout+stderr truncated to the tail, spilling full output to a temp file. Port of pi's `bash` execute logic + local shell backend, stripped of pi-package/TUI coupling.

## Source reference (port)
`/home/haz/source/pi/packages/coding-agent/src/core/tools/bash.ts` — port `createBashToolDefinition`'s `execute` and the local-execution body of `createLocalBashOperations`. **Strip:** `@earendil-works/pi-*`, `pi-tui`, `getShellConfig`/`getShellEnv`/`trackDetachedChildPid`/`waitForChildProcess` (replace with inline equivalents), `commandPrefix`/`spawnHook`/`operations` plumbing, all render code. File: `src/tools/bash.ts`.

## Depends on
- `src/tools/output-accumulator.ts` → `OutputAccumulator` (spec 02)
- `src/tools/truncate.ts` → `DEFAULT_MAX_BYTES`, `DEFAULT_MAX_LINES`, `formatSize` (spec 02)

## Tool definition (verbatim from pi)
- **name**: `bash`
- **description**: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`
- **inputSchema**:
```json
{
  "type": "object",
  "properties": {
    "command": { "type": "string", "description": "Bash command to execute" },
    "timeout": { "type": "number", "description": "Timeout in seconds (optional, no default timeout)" }
  },
  "required": ["command"]
}
```

## Behavior (port faithfully)
1. Shell = `process.env.SHELL || "bash"`. Spawn `[shell, "-c", command]` with:
   - `cwd: rootDir` (if it doesn't exist → throw `Working directory does not exist: ${rootDir}`).
   - `detached: process.platform !== "win32"` (own process group so we can kill the tree).
   - `stdio: ["ignore", "pipe", "pipe"]`, `env: process.env`, `windowsHide: true`.
2. Pipe **both** `stdout` and `stderr` into one `OutputAccumulator({ tempFilePrefix: "openhammer" })` (merge streams — order interleaves as written).
3. **Timeout:** if `timeout` set and `> 0`, start a timer; on fire, kill the process tree (because `detached`, kill the group: `process.kill(-child.pid, "SIGKILL")` guarded by try/catch), then reject with `timeout:${timeout}`.
4. **Abort:** on abort, kill the tree the same way; reject `aborted`.
5. On child exit: `await finishOutput()` (flush + persist-if-truncated + `closeTempFile()`). Build result text from `snapshot`:
   - `exitCode !== 0 && !== null` → throw `Command exited with code ${exitCode}` (appended to captured output).
   - `timeout` → `Command timed out after ${n} seconds`.
   - `aborted` → `Command aborted`.
   - On truncation, append a footer: lines case → `[Showing lines ${start}-${end} of ${total}. Full output: ${fullOutputPath}]`; bytes case → same with `(${formatSize(DEFAULT_MAX_BYTES)} limit)`; partial-last-line case → `[Showing last ${formatSize(outputBytes)} of line ${end} (line is ${lastLineSize}). Full output: ${fullOutputPath}]`.
   - Empty output → text defaults to `"(no output)"` (non-error exit) / `""` (error append).
6. Success → `{ content: [{ type: "text", text: outputText }] }`. Errors thrown here become `isError:true` at the MCP layer (spec 12).

## Acceptance criteria
- `bash {command:"echo hello && pwd"}` → `hello\n<rootDir>`, success.
- `bash {command:"exit 3"}` → `isError:true`, text contains `Command exited with code 3`.
- `bash {command:"yes | head -c 2000000"}` → tail-truncated output with a `Full output: <tempfile>` footer (proves temp-file spill). The MCP backstop may also fire (spec 12).
- `bash {command:"sleep 30", timeout:1}` → `isError:true`, `Command timed out after 1 seconds`, and the `sleep` process is dead (no orphan).
- stdout and stderr are both captured and merged.

## Decisions & deviations
- **No `BashOperations` interface seam** (locked: "None"). The local exec logic lives directly in `src/tools/bash.ts`. `bash` is native to wherever OpenHammer runs, so sandboxing = **containerize OpenHammer** (mount the target dir, set `MCP_ROOT_DIR`) — no `--sandbox` mode or execution seam is planned.
- **Shell = `$SHELL || "bash"`** (simplified from pi's `getShellConfig`).
- **Process-tree kill** via the detached process group (`process.kill(-pid)`), replacing pi's `killProcessTree`/tracking utils.
- `commandPrefix`/`spawnHook` options dropped (unused without the Operations seam).

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/tools/bash.ts` (spawn shell, merged streams into `OutputAccumulator`, timeout/abort tree-kill, exit-code → error, tail-truncation footer) with unit tests (use a fake short-lived command + a temp rootDir)
