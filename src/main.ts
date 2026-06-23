/**
 * OpenHammer entrypoint (spec 14 + 17q). Wires the layers together on boot:
 * resolve config → ensure token → bind Fastify → resolve the boot channel via
 * the registry (live `start` / static `resolve` / localhost-only) → print the
 * startup banner, then stays alive serving requests until `SIGINT`/`SIGTERM`.
 *
 * This is the sole boot boundary: it owns binding (`buildFastify` deliberately
 * does not `listen` — see its module header) and the process lifecycle. Boot
 * failures (`ensureToken`'s unwritable credential dir, `EADDRINUSE` on listen)
 * surface as a one-line actionable message on stderr plus a non-zero exit; a
 * clean `SIGINT`/`SIGTERM` exits 0 after closing Fastify and tearing the channel
 * down (no orphan processes, no stack trace).
 *
 * Channel resolution (17q) lives in `src/tunnel/boot.ts`: `--channel <id>` /
 * `settings.defaultChannel` / `MCP_TUNNEL_PROVIDER` / the legacy `--tunnel` all
 * funnel through one precedence path. A channel that is absent, unregistered, or
 * fails to start is **null-safe** — `resolveChannelHandle` returns a `notice`
 * (logged here) and the server continues localhost-only. The bearer gate is the
 * real gate; a missing channel is graceful degradation, never a boot failure.
 *
 * `main` is exported so the CLI dispatcher (`src/cli.ts`, 17o) can delegate
 * `openhammer start` (and the default command) to this same boot path — one
 * source of truth for binding + lifecycle. The module-level auto-run below fires
 * only when this file is the direct entrypoint (`npm start` / `node dist/main.js`),
 * so importing `main` from the CLI (or a test) does **not** boot a server.
 */
import { pathToFileURL } from "node:url";
import { ensureToken } from "./auth/token.ts";
import { parseArgs } from "./cli/args.ts";
import { loadSettings } from "./config/settings.ts";
import { resolveConfig } from "./config.ts";
import { buildFastify } from "./server.ts";
import { printStartup } from "./startup-print.ts";
import { resolveChannelHandle } from "./tunnel/boot.ts";

export async function main(): Promise<void> {
	// `--channel <id>` / `--tunnel` come from argv (re-parsed here because `npm
	// start` / `node dist/main.js` bypass the CLI dispatcher). `resolveConfig`
	// folds `--channel` over `settings.defaultChannel` (§3.4: flag > file).
	const argv = parseArgs(process.argv.slice(2));
	const settings = loadSettings();
	const config = resolveConfig({ channel: argv.channel }, process.env, settings);
	const { token } = await ensureToken(config);

	const fastify = await buildFastify(config, token, config.allowedClients);
	await fastify.listen({ port: config.port, host: config.host });

	// Resolve the boot channel via the registry (17q). `null` + a `notice` is the
	// null-safe localhost-only fallback (no channel, or the channel failed to
	// start) — logged here, never fatal. The handle's `stop` tears a live channel
	// down on shutdown; static channels have none (the operator owns the endpoint).
	const { handle, notice } = await resolveChannelHandle({
		channelId: config.channelId,
		channels: settings.channels,
		env: process.env,
		wantTunnel: argv.tunnel,
		localPort: config.port,
	});
	if (notice !== null) {
		fastify.log.warn(notice);
	}

	printStartup({
		localUrl: `http://${config.host}:${config.port}`,
		tunnelUrl: handle?.url,
		token,
	});

	// One-shot shutdown: close Fastify, tear the channel down, exit 0. The guard
	// absorbs a second signal arriving mid-shutdown (e.g. a second Ctrl+C).
	let shuttingDown = false;
	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		fastify.log.info({ signal }, "shutting down");
		await fastify.close();
		// Best-effort teardown (the `12b` per-promise `.catch(()=>{})` idiom): a
		// live channel's `stop` is idempotent; never block the exit on it.
		const stop = handle?.stop;
		if (stop !== undefined) {
			await stop().catch(() => {});
		}
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
