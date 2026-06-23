/**
 * Tier-3 compose test-runner (spec 16). The containerized analogue of the Tier-1
 * canary: a real SDK `Client` drives an MCP server over `POST /mcp` across the
 * Docker network — connect (initialize), `listTools`, `callTool` — asserting on
 * the returned text. Identical client logic to the canary; only the URL differs
 * (read from `MCP_URL`).
 *
 * Self-selects its assertion suite from `tools/list`:
 *  - the fixture (one `echo` tool) → `npm run test:compose`, and
 *  - the real `server` (the 7 fs/bash tools) → `npm run test:compose:real`,
 *    retargeted at `http://server:3000/mcp`. There is no shared filesystem
 *    between containers, so the file-based tools are seeded via the server's own
 *    `write` (rooted at `MCP_ROOT_DIR=/data`, which auto-creates parent dirs)
 *    before `read`/`grep`/`find`/`ls`/`edit` assert on them.
 *
 * Exits 0 on success, 1 on any assertion/connection failure — `--exit-code-from`
 * propagates that code out of `docker compose up` (the `test:compose` /
 * `test:compose:real` gates), and `--abort-on-container-exit` tears the run down.
 *
 * **Standalone — no `src/` import.** Driven by `tsx` under the compose `dev`
 * image; not loaded by vitest — it lives under `test/compose/`, outside the
 * `test/e2e-hermetic/**` trio include (but inside `tsconfig.test.json`/biome's
 * `test/` scope, so it is typechecked + linted).
 */
import assert from "node:assert";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL ?? "http://fixture-server:3000/mcp";
const MCP_TOKEN = process.env.MCP_TOKEN ?? "fixture-compose-bearer-token";

/** The real server's `createAllTools` order — exactly what `tools/list` returns. */
const REAL_TOOL_NAMES = ["guide", "read", "bash", "edit", "write", "grep", "find", "ls"];

/** compose interleaves per-service stdout; a prefix keeps the run readable. */
function log(message: string): void {
	process.stdout.write(`[run-e2e] ${message}\n`);
}

/**
 * Narrow a `callTool` result to its first content block's text. The SDK types
 * `callTool`'s return as a union; narrow on `"content" in result`, then on the
 * `text` discriminant — no `as` casts (the guards carry the narrowing), mirroring
 * the Tier-1 canary's helper.
 */
function firstText(result: unknown): string | undefined {
	if (typeof result !== "object" || result === null || !("content" in result)) return undefined;
	const { content } = result;
	if (!Array.isArray(content)) return undefined;
	const block = content[0];
	if (
		block !== null &&
		typeof block === "object" &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		typeof block.text === "string"
	) {
		return block.text;
	}
	return undefined;
}

/**
 * Whether a `callTool` result carries the error flag. `callTool` returns a union
 * whose structured-result variant has no named `isError` (only an index
 * signature), so narrow via an `in` guard rather than a typed param (no `as`) —
 * the codebase's boundary-narrowing convention.
 */
function isErrorResult(result: unknown): boolean {
	return typeof result === "object" && result !== null && "isError" in result && result.isError === true;
}

/** Assert a `callTool` succeeded (`isError` falsy) and its first text block matches. */
function expectOk(result: unknown, pattern: RegExp, label: string): void {
	assert.ok(!isErrorResult(result), `${label} returned isError: ${firstText(result) ?? "(no text)"}`);
	assert.match(firstText(result) ?? "", pattern, `${label} did not match ${String(pattern)}`);
}

/** Fixture path (1 tool): the `echo` round-trip the canary proves. */
async function runFixtureEcho(client: Client, tools: ReadonlyArray<{ name: string }>): Promise<void> {
	assert.equal(tools.length, 1, `expected exactly 1 tool, got ${tools.length}`);
	assert.equal(tools[0]?.name, "echo", `expected the "echo" tool, got ${String(tools[0]?.name)}`);
	log(`tools/list ok: ${tools.map((t) => t.name).join(", ")}`);

	const message = "hello compose";
	const result = await client.callTool({ name: "echo", arguments: { message } });
	assert.ok(!result.isError, "tools/call returned isError");
	assert.equal(firstText(result), message, "tools/call did not echo the message back verbatim");
	log("tools/call ok: echo round-trip matched");
}

/** Real-server path (8 tools): drive each capability tool end-to-end over the wire. */
async function runRealServer(client: Client, tools: ReadonlyArray<{ name: string }>): Promise<void> {
	const names = tools.map((t) => t.name);
	assert.deepEqual(names, REAL_TOOL_NAMES, `expected the 8 real tools, got ${names.join(", ")}`);
	log(`tools/list ok: ${names.join(", ")}`);

	// bash — pure stdout echo.
	expectOk(await client.callTool({ name: "bash", arguments: { command: "echo bash-works" } }), /bash-works/, "bash");

	// write — create a file under /data (auto-seeded; the runner has no host fs).
	expectOk(
		await client.callTool({ name: "write", arguments: { path: "w.txt", content: "written!" } }),
		/Successfully wrote/,
		"write",
	);

	// read — round-trip the file written above.
	expectOk(await client.callTool({ name: "read", arguments: { path: "w.txt" } }), /written!/, "read");

	// grep — seed a TODO marker, then search it.
	expectOk(
		await client.callTool({
			name: "write",
			arguments: { path: "g.txt", content: "nothing here\nTODO fix this\n" },
		}),
		/Successfully wrote/,
		"seed(g.txt)",
	);
	expectOk(await client.callTool({ name: "grep", arguments: { pattern: "TODO" } }), /TODO fix this/, "grep");

	// find — write to a nested path (write auto-creates the parent dir), then glob it.
	expectOk(
		await client.callTool({ name: "write", arguments: { path: "sub/notes.md", content: "x" } }),
		/Successfully wrote/,
		"seed(sub/notes.md)",
	);
	expectOk(await client.callTool({ name: "find", arguments: { pattern: "**/*.md" } }), /notes\.md/, "find");

	// ls — list the root; the created file + dir must appear (dirs suffixed `/`).
	const lsResult = await client.callTool({ name: "ls", arguments: { path: "." } });
	assert.ok(!isErrorResult(lsResult), `ls returned isError: ${firstText(lsResult) ?? "(no text)"}`);
	const lsText = firstText(lsResult) ?? "";
	assert.match(lsText, /w\.txt/, "ls did not list w.txt");
	assert.match(lsText, /sub\//, "ls did not suffix the subdirectory with /");

	// edit — seed a file, replace a block, then read it back to confirm it landed.
	expectOk(
		await client.callTool({ name: "write", arguments: { path: "e.txt", content: "alpha\nbeta\n" } }),
		/Successfully wrote/,
		"seed(e.txt)",
	);
	expectOk(
		await client.callTool({
			name: "edit",
			arguments: { path: "e.txt", edits: [{ oldText: "beta", newText: "gamma" }] },
		}),
		/Successfully replaced 1 block\(s\)/,
		"edit",
	);
	expectOk(await client.callTool({ name: "read", arguments: { path: "e.txt" } }), /gamma/, "edit(readback)");

	log("tools/call ok: all 7 capability tools round-tripped");
}

async function runOnce(): Promise<void> {
	log(`connecting to ${MCP_URL}`);
	const client = new Client({ name: "compose-runner", version: "0.0.0" }, { capabilities: {} });
	// The bearer rides on every request via `requestInit` headers — no
	// `authProvider`, so the SDK never starts the OAuth discovery flow.
	const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
		requestInit: { headers: { authorization: `Bearer ${MCP_TOKEN}` } },
	});

	try {
		await client.connect(transport);
		log("connected (initialize ok)");

		const { tools } = await client.listTools();
		const names = tools.map((t) => t.name);
		if (names.length === 1 && names[0] === "echo") {
			log("target: fixture server (1 echo tool)");
			await runFixtureEcho(client, tools);
		} else {
			log(`target: real server (${names.length} tools)`);
			await runRealServer(client, tools);
		}
	} finally {
		await client.close().catch(() => {});
	}
}

runOnce()
	.then(() => {
		log("ALL CHECKS PASSED");
		process.exit(0);
	})
	.catch((error: unknown) => {
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		process.stderr.write(`[run-e2e] FAILED: ${detail}\n`);
		process.exit(1);
	});
