# 12 — MCP Server, HTTP Transport & Fastify Build

## Purpose
The integration core: an MCP `Server` exposing the 7 tools (with the `MAX_RESPONSE_BYTES` backstop), a stateless Streamable-HTTP transport mounted at `POST /mcp` behind bearer auth, and the Fastify app (CORS, `/health`, well-known) that boots it.

## Files
- `src/mcp/server.ts` — `createMcpServer`, `ListTools`/`CallTool` handlers, `MAX_RESPONSE_BYTES` backstop.
- `src/mcp/http-transport.ts` — `mcpHttpRoutes`, per-request `StreamableHTTPServerTransport`, header-flush + `reply.hijack()`, GET/DELETE → 405.
- `src/server.ts` — Fastify build, `@fastify/cors`, `/health`, error handlers, `listen`.

## Depends on
- `src/tools/index.ts` → `createAllTools` (spec 10)
- `src/tools/result.ts` → `Result`/`ok`/`err` (spec 02a)
- `src/auth/middleware.ts` → `createAuthMiddleware` (spec 11)
- `src/mcp/well-known.ts` → `registerWellKnown` (spec 11)
- `src/config.ts` → `Config` (spec 01)

## `src/mcp/server.ts` — `createMcpServer(rootDir, maxResponseBytes): Server`
- `new Server({ name: "openhammer", version: <pkg version> }, { capabilities: { tools: {} } })`.
- Build `entries = createAllTools(rootDir)` once (closure).
- `setRequestHandler(ListToolsRequestSchema, async () => ({ tools: entries.map(e => e.tool) }))`.
- `setRequestHandler(CallToolRequestSchema, async (request) => { ... })`:
  - `const { name, arguments: args } = request.params`.
  - Find entry by `name`; none → `return { content: [{ type:"text", text:`Unknown tool: ${name}` }], isError: true }`.
  - **Narrow the Result** (with a fallback `try/catch` only as a bug safety-net — tools never throw for *expected* failures, but a genuine bug still must not 500):
    ```ts
    let r: Result<ToolOk>;
    try { r = await entry.handler(args); }
    catch (e) { r = err(e instanceof Error ? e : new Error(String(e))); }
    if (!r.ok) return { content: [{ type: "text", text: r.error.message }], isError: true };
    ```
  - **Universal size backstop** on `r.value.content`: `bytes = sum(Buffer.byteLength(text) for text blocks) + sum(data.length for image blocks)`. If `bytes > maxResponseBytes` → replace the ENTIRE content with one text block: `JSON.stringify({ ok:false, error:"response_too_large", bytes, cap:maxResponseBytes, message:"The \"${name}\" response was ${bytes} bytes, over the ${maxResponseBytes}-byte limit. Narrow the query or page the results." })`.
  - `return { content: r.value.content }` (success; `isError` omitted/false).
- Imports: `Server` from `@modelcontextprotocol/sdk/server/index.js`; `CallToolRequestSchema, ListToolsRequestSchema` from `@modelcontextprotocol/sdk/types.js`; `Result`/`err` + `ToolOk` from `../tools/result.ts` / `./types.ts`.

## `src/mcp/http-transport.ts` — `mcpHttpRoutes(fastify, { token, config }): Promise<void>`
- Attach the auth `preHandler` **to the POST /mcp route only** (so `/health` + well-known stay open): `fastify.post("/mcp", { preHandler: createAuthMiddleware(token, config), handler: ... })`.
- **POST /mcp handler:**
  - per-request `server = createMcpServer(config.rootDir, config.maxResponseBytes)`.
  - `transport = new StreamableHTTPServerTransport({ enableJsonResponse: true })` — **stateless: do NOT pass `sessionIdGenerator`**.
  - `reply.raw.once("close", () => { try { void transport.close(); void server.close(); } catch {} })`.
  - `await server.connect(transport as unknown as Transport)` (cast absorbs SDK optional-callback type friction).
  - **Flush Fastify headers** onto `reply.raw` before handing to the SDK: `for (const [k,v] of Object.entries(reply.getHeaders())) if (v !== undefined && !reply.raw.headersSent) reply.raw.setHeader(k, v as any)`. (This is why CORS expose-headers actually reach the browser.)
  - `await transport.handleRequest(req.raw, reply.raw, req.body)`.
  - `return reply.hijack()`.
- **GET /mcp** → `reply.code(405).send({ jsonrpc:"2.0", error:{ code:-32000, message:"Method not allowed." }, id:null })`.
- **DELETE /mcp** → `reply.code(405).send()`.
- Imports: `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`; `Transport` type from `@modelcontextprotocol/sdk/shared/transport.js`.

## `src/server.ts` — `buildFastify(config, token): Promise<FastifyInstance>`
- `Fastify({ logger: { level: config.logLevel, transport: pino-pretty only in dev } })`.
- register `@fastify/cors`: `origin: true`, `credentials: true`, `methods: ["GET","POST","PUT","PATCH","DELETE","OPTIONS"]`, `exposedHeaders: ["Mcp-Session-Id","Mcp-Protocol-Version","WWW-Authenticate","Deprecation","Sunset","Warning","Link"]`.
- `GET /health` → `{ status: "ok" }` (no auth).
- `registerWellKnown(fastify, baseUrl)` where `baseUrl = `http://${config.host}:${config.port}``.
- `await fastify.register(mcpHttpRoutesPlugin, { token, config })` (wrap `mcpHttpRoutes` in a Fastify plugin if not already).
- Global error + 404 handlers.
- **Return `fastify` WITHOUT calling `listen`.** The caller (`main.ts`, spec 14) owns binding + lifecycle.
  This split is required for testing (spec 15): the Tier-1 in-process E2E binds ephemeral **port 0** itself,
  and the Tier-2 boot E2E controls shutdown. (Behavior for `main.ts` is unchanged — it just calls `listen`.)

## Acceptance criteria
- `tools/list` over the MCP Inspector returns all 7 tools with correct names/schemas. (Automated equivalent: the Tier-1 in-process E2E `test/e2e-hermetic/mcp.e2e.test.ts`, task T-mcp-e2e, drives all 7 tools through the real SDK client — this **replaces** the manual Inspector walkthrough as a regression.)
- Each tool dispatches correctly via `tools/call` (see per-tool specs).
- No/invalid bearer → `401` + `WWW-Authenticate`; valid bearer → success.
- A tool returning `err` → `isError:true` content with the message (no 500).
- A tool that throws a genuine bug → still `isError:true` via the fallback catch (no 500, no crash).
- `bash {command:"yes | head -c 2000000"}` (or any >512KB result) → single `response_too_large` JSON text block (proves the backstop).
- `GET /health` → 200 without auth; `GET /.well-known/oauth-protected-resource` → 200 without auth.
- `GET /mcp`, `DELETE /mcp` → 405. CORS expose-headers include `Mcp-Session-Id`.

## Decisions & deviations
- **Stateless** (no `sessionIdGenerator`). Per-request `Server` + `Transport`.
- **Two design notes:** (1) tools return `Result<ToolOk>` (not raw data to `JSON.stringify`); the `CallTool` handler narrows. (2) a fallback `try/catch` around the handler catches genuine bugs as `isError` — expected failures come back as `err`, never thrown.
- Backstop replaces the whole content (text or image) with a single `response_too_large` text block — a structured error, never a silently truncated body.

## Suggested plan items (atomic checkboxes)
- [ ] Implement `src/mcp/server.ts` (`createMcpServer`: Server, ListTools/CallTool, Result narrowing + fallback catch + backstop) with unit tests
- [ ] Implement `src/mcp/http-transport.ts` (`mcpHttpRoutes`: auth preHandler on POST, per-request transport, header flush, hijack, GET/DELETE 405) with integration test against a real Fastify
- [ ] Implement `src/server.ts` (`buildFastify`: cors, /health, well-known, mcp routes, listen, error/404 handlers)
