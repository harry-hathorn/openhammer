/**
 * Tier-3 compose test-runner (spec 16). The containerized analogue of the Tier-1
 * canary: a real SDK `Client` drives the fixture server over `POST /mcp` across
 * the Docker network — connect (initialize), `listTools`, `callTool` — asserting
 * on the returned text. Identical client logic to the canary; only the URL
 * differs (read from `MCP_URL`, default `http://fixture-server:3000/mcp`).
 *
 * Exits 0 on success, 1 on any assertion/connection failure — `--exit-code-from
 * test-runner` propagates that code out of `docker compose up` (the
 * `test:compose` gate), and `--abort-on-container-exit` tears the run down.
 *
 * **Standalone — no `src/` import.** The fixture is the target, not the
 * production server (the real server's 7-tool coverage is `T-real-compose`'s
 * job). Driven by `tsx` under the compose `dev` image; not loaded by vitest — it
 * lives under `test/compose/`, outside the `test/e2e-hermetic/**` trio include.
 */
import assert from "node:assert";
import process from "node:process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = process.env.MCP_URL ?? "http://fixture-server:3000/mcp";
const MCP_TOKEN = process.env.MCP_TOKEN ?? "fixture-compose-bearer-token";

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
		assert.equal(tools.length, 1, `expected exactly 1 tool, got ${tools.length}`);
		assert.equal(tools[0]?.name, "echo", `expected the "echo" tool, got ${String(tools[0]?.name)}`);
		log(`tools/list ok: ${tools.map((t) => t.name).join(", ")}`);

		const message = "hello compose";
		const result = await client.callTool({ name: "echo", arguments: { message } });
		assert.ok(!result.isError, "tools/call returned isError");
		assert.equal(firstText(result), message, "tools/call did not echo the message back verbatim");
		log("tools/call ok: echo round-trip matched");
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
