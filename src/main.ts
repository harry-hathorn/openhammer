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
 */
import { ensureToken } from "./auth/token.ts";
import { loadConfig } from "./config.ts";
import { buildFastify } from "./server.ts";
import { printStartup } from "./startup-print.ts";
import { startTunnel } from "./tunnel/cloudflare.ts";

async function main(): Promise<void> {
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

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	console.error(`OpenHammer failed to start: ${message}`);
	process.exit(1);
});
