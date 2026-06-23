/**
 * OpenHammer entrypoint (spec 14). Wires the layers together on boot:
 * load config → ensure token → (optional) tunnel → listen → print the startup
 * banner, then stays alive serving requests until `SIGINT`/`SIGTERM`.
 *
 * This is the sole boot boundary: it owns binding (`buildFastify` deliberately
 * does not `listen` — see its module header) and the process lifecycle. Boot
 * failures (`ensureToken`'s unwritable credential dir, `EADDRINUSE` on listen)
 * surface as a one-line actionable message on stderr plus a non-zero exit; a
 * clean `SIGINT`/`SIGTERM` exits 0 after closing Fastify and killing the tunnel
 * child (no orphan processes, no stack trace).
 *
 * `main` is exported so the CLI dispatcher (`src/cli.ts`, 17o) can delegate
 * `openhammer start` (and the default command) to this same boot path — one
 * source of truth for binding + lifecycle. The module-level auto-run below fires
 * only when this file is the direct entrypoint (`npm start` / `node dist/main.js`),
 * so importing `main` from the CLI (or a test) does **not** boot a server.
 */
import { pathToFileURL } from "node:url";
import { ensureToken } from "./auth/token.ts";
import { loadConfig } from "./config.ts";
import { buildFastify } from "./server.ts";
import { printStartup } from "./startup-print.ts";
import { startTunnel } from "./tunnel/cloudflare.ts";

export async function main(): Promise<void> {
	const config = loadConfig();
	const { token } = await ensureToken(config);

	// `--tunnel` starts the optional cloudflared quick-tunnel. An absent binary
	// is graceful: `startTunnel` resolves `null` and we continue localhost-only.
	const wantTunnel = process.argv.slice(2).includes("--tunnel");

	const fastify = await buildFastify(config, token);
	await fastify.listen({ port: config.port, host: config.host });

	const tunnel = wantTunnel ? await startTunnel(config.port) : null;
	if (wantTunnel && tunnel === null) {
		fastify.log.warn("cloudflared not found — continuing localhost-only.");
	}

	printStartup({
		localUrl: `http://${config.host}:${config.port}`,
		tunnelUrl: tunnel?.url,
		token,
	});

	// One-shot shutdown: close Fastify, kill the tunnel child, exit 0. The guard
	// absorbs a second signal arriving mid-shutdown (e.g. a second Ctrl+C).
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		fastify.log.info({ signal }, "shutting down");
		await fastify.close();
		tunnel?.child.kill();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Auto-run only when invoked as the entrypoint (`npm start` / `node dist/main.js`),
// not when imported by the CLI dispatcher (17o) or a test — otherwise importing
// `main` would boot a server. Matches the `src/cli.ts` guard: under `tsx src/main.ts`
// (the boot E2E) `process.argv[1]` resolves to this file, so the guard fires.
const invokedDirectly = typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`OpenHammer failed to start: ${message}`);
		process.exit(1);
	});
}
