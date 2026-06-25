/**
 * Tier-1 real E2E (specs 15 + 16). Drives the **production** server — the real
 * `buildFastify` (CORS + `/health` + well-known + bearer-gated stateless
 * `POST /mcp`) — over loopback HTTP on an ephemeral port with a real SDK
 * `Client`. Where the canary (`harness.canary.test.ts`) proves the harness
 * against a standalone fixture, this suite proves the real server itself: all 7
 * capability tools round-trip over `tools/call` (plus the `guide` orientation tool
 * in `tools/list`), the bearer gate returns 401, and the
 * universal `MAX_RESPONSE_BYTES` backstop fires as a structured payload.
 *
 * Each tool is driven over the wire as the sole subject under test — fixture
 * setup + verification use `node:fs` directly so a failure points at exactly
 * one tool, not a chain of them (a broken `write` must not turn the `read` test
 * red). Per-request `Server` + `Transport` make the app stateless, so a fresh
 * server per test (via `withServer`) is purely for isolation, not correctness.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FastifyInstance } from "fastify";
import { describe, expect, it } from "vitest";

import type { Config } from "../../src/config.ts";
import { buildFastify } from "../../src/server.ts";

const TOKEN = "real-buildfastify-bearer-token";
const TOOL_NAMES = ["guide", "read", "bash", "edit", "write", "grep", "find", "ls"];

/** Build + listen the real server on an ephemeral port; close the app + clean the temp root after `fn`. */
async function withServer<T>(
	options: { maxResponseBytes?: number } = {},
	fn: (ctx: { app: FastifyInstance; baseUrl: string; rootDir: string }) => Promise<T>,
): Promise<T> {
	const rootDir = mkdtempSync(join(tmpdir(), "openhammer-e2e-"));
	const config: Config = {
		port: 0,
		host: "127.0.0.1",
		rootDir,
		authToken: undefined,
		publicUrl: undefined,
		maxResponseBytes: options.maxResponseBytes ?? 512_000,
		// Silent keeps `npm test` output clean — the SDK transport + per-request
		// server are otherwise chatty on every request.
		logLevel: "silent",
	};
	const app = await buildFastify(config, TOKEN);
	// Real listen on an ephemeral port — the SDK client uses its own fetch, so
	// `inject` can't satisfy it; it needs a genuine HTTP endpoint.
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${address.port}`;
	try {
		return await fn({ app, baseUrl, rootDir });
	} finally {
		await app.close();
		rmSync(rootDir, { recursive: true, force: true });
	}
}

/** Connect a bearer-carrying SDK client; the caller closes it. */
async function connectClient(baseUrl: string): Promise<Client> {
	const client = new Client({ name: "e2e-client", version: "0.0.0" }, { capabilities: {} });
	// The bearer rides on every request via `requestInit` headers — no
	// `authProvider`, so the SDK never tries the OAuth discovery flow.
	const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
		requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
	});
	await client.connect(transport);
	return client;
}

/**
 * Pull the first content block's text out of a `callTool` result. The SDK types
 * `callTool`'s return as a union; narrow on `"content" in result`, then on the
 * `text` discriminant — no `as` casts (the guards carry the narrowing).
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

/** Connect, call one tool, close — returns the isError flag + first text block. */
async function callToolOnce(
	baseUrl: string,
	name: string,
	args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string | undefined }> {
	const client = await connectClient(baseUrl);
	try {
		const result = await client.callTool({ name, arguments: args });
		return { isError: Boolean(result.isError), text: firstText(result) };
	} finally {
		await client.close().catch(() => {});
	}
}

describe("Tier-1 real: SDK client ↔ buildFastify", () => {
	it("lists all 8 tools over the real server", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const client = await connectClient(baseUrl);
			try {
				const { tools } = await client.listTools();
				expect(tools.map((t) => t.name)).toEqual(TOOL_NAMES);
			} finally {
				await client.close().catch(() => {});
			}
		});
	});

	it("read returns a file's contents", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			writeFileSync(join(rootDir, "a.txt"), "line one\nline two\n");
			const { isError, text } = await callToolOnce(baseUrl, "read", { path: "a.txt" });
			expect(isError).toBe(false);
			expect(text).toContain("line one");
			expect(text).toContain("line two");
		});
	});

	it("bash runs a command and returns stdout", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const { isError, text } = await callToolOnce(baseUrl, "bash", { command: "echo bash-works" });
			expect(isError).toBe(false);
			expect(text).toContain("bash-works");
		});
	});

	it("write creates a file on disk", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			const { isError, text } = await callToolOnce(baseUrl, "write", {
				path: "w.txt",
				content: "written!",
			});
			expect(isError).toBe(false);
			expect(text).toContain("Successfully wrote");
			expect(readFileSync(join(rootDir, "w.txt"), "utf8")).toBe("written!");
		});
	});

	it("edit replaces a block in an existing file", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			writeFileSync(join(rootDir, "e.txt"), "alpha\nbeta\n");
			const { isError, text } = await callToolOnce(baseUrl, "edit", {
				path: "e.txt",
				edits: [{ oldText: "beta", newText: "gamma" }],
			});
			expect(isError).toBe(false);
			expect(text).toContain("Successfully replaced 1 block(s)");
			const after = readFileSync(join(rootDir, "e.txt"), "utf8");
			expect(after).toContain("gamma");
			expect(after).not.toContain("beta");
		});
	});

	it("grep finds matching lines", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			writeFileSync(join(rootDir, "g.txt"), "nothing here\nTODO fix this\n");
			const { isError, text } = await callToolOnce(baseUrl, "grep", { pattern: "TODO" });
			expect(isError).toBe(false);
			expect(text).toContain("TODO fix this");
		});
	});

	it("find locates files by glob", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			mkdirSync(join(rootDir, "sub"));
			writeFileSync(join(rootDir, "sub", "notes.md"), "x");
			const { isError, text } = await callToolOnce(baseUrl, "find", { pattern: "**/*.md" });
			expect(isError).toBe(false);
			expect(text).toContain("notes.md");
		});
	});

	it("ls lists directory entries", async () => {
		await withServer({}, async ({ baseUrl, rootDir }) => {
			writeFileSync(join(rootDir, "x.txt"), "x");
			mkdirSync(join(rootDir, "sub"));
			const { isError, text } = await callToolOnce(baseUrl, "ls", { path: "." });
			expect(isError).toBe(false);
			expect(text).toContain("x.txt");
			expect(text).toContain("sub/");
		});
	});

	it("rejects tools/call with no bearer (401)", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "ls", arguments: { path: "." } },
				}),
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("www-authenticate")).toMatch(/^Bearer realm="openhammer"/);
		});
	});

	it("rejects tools/call with a wrong bearer (401)", async () => {
		await withServer({}, async ({ baseUrl }) => {
			const res = await fetch(`${baseUrl}/mcp`, {
				method: "POST",
				headers: { "content-type": "application/json", authorization: "Bearer definitely-wrong" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "ls", arguments: { path: "." } },
				}),
			});
			expect(res.status).toBe(401);
		});
	});

	it("fires the response_too_large backstop on an oversized response", async () => {
		// An 8-byte cap makes any non-trivial output overflow; 200 chars of echo
		// is well over it and stays under bash's own 50KB truncation, so the
		// whole-response backstop — not per-tool truncation — is what fires.
		await withServer({ maxResponseBytes: 8 }, async ({ baseUrl }) => {
			const { isError, text } = await callToolOnce(baseUrl, "bash", {
				command: `echo ${"x".repeat(200)}`,
			});
			// The backstop is a structured success-payload (not isError) per spec.
			expect(isError).toBe(false);
			const parsed = JSON.parse(text ?? "null") as Record<string, unknown>;
			expect(parsed).toMatchObject({ ok: false, error: "response_too_large", cap: 8 });
			expect(typeof parsed.bytes).toBe("number");
		});
	});
});
