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
 *
 * VM boot modes (spec 27, wired in 27f): a VM mode (`--vm`/`--vm-agent`/
 * `MCP_VM_MODE`/settings) runs the fail-fatal preflight SYNCHRONOUSLY after
 * config resolution — before the credential mint — and a miss throws
 * preflight's ONE actionable line into the same boot-failure path below
 * (the deliberate deviation from the channel null-safe pattern, argued in the
 * spec). The boot-scoped backend is then the delegating VM backend (every tool
 * call gates on the sandbox's readiness; not-ready calls get the actionable
 * booting err), and the QEMU boot is kicked off EAGER-ASYNC the moment
 * `listen()` succeeds — never blocking it, so `/health` serves immediately
 * (server health ≠ VM health). The shutdown slot stops the guest AFTER Fastify
 * has stopped serving (`backend.close()` IS the VM stop). Mode `off` (the
 * default) is byte-for-byte today's local path.
 */
import { resolveJwtSecret } from "./auth/oauth/clients.ts";
import { oauthIssuerAudience } from "./auth/oauth/token.ts";
import { ensureToken } from "./auth/token.ts";
import { parseArgs } from "./cli/args.ts";
import { loadSettings } from "./config/settings.ts";
import { resolveConfig } from "./config.ts";
import { isMainEntry } from "./entrypoint.ts";
import { RequestRecorder } from "./mcp/telemetry.ts";
import { type ChannelStateLine, startStatusSocket } from "./observability/status-socket.ts";
import { buildFastify } from "./server.ts";
import { printStartup } from "./startup-print.ts";
import { createLocalBackend } from "./tools/backend.ts";
import { resolveChannelHandle } from "./tunnel/boot.ts";
import { type PrepareVmBootDeps, prepareVmBoot } from "./vm/boot-backend.ts";

/**
 * Injection seams for main's VM boot wiring (spec 27f) — the repo's box contract:
 * the defaults are the real implementations, so the Tier-2 boot E2E drives
 * vm-mode boots through a scripted gate (test/e2e-hermetic/vm-boot-driver.ts)
 * without KVM/QEMU ever being required. Nothing else in the boot is injectable:
 * the token, channel, and server stay production-real in every tier.
 */
export interface MainDeps {
	/** The VM boot seams threaded into `prepareVmBoot` (preflight verdict + service factory). */
	readonly vm?: PrepareVmBootDeps;
}

export async function main(deps: MainDeps = {}): Promise<void> {
	// `--channel <id>` / `--tunnel` / `--vm` / `--vm-agent` come from argv
	// (re-parsed here because `npm start` / `node dist/main.js` bypass the CLI
	// dispatcher). `resolveConfig` folds `--channel` over
	// `settings.defaultChannel` (§3.4: flag > file) and `vmMode` over
	// `MCP_VM_MODE`/`settings.vm.mode` (27b's same precedence, later flag wins).
	const argv = parseArgs(process.argv.slice(2));
	const settings = loadSettings();
	const config = resolveConfig({ channel: argv.channel, vmMode: argv.vmMode }, process.env, settings);

	// VM boot posture (spec 27, wired 27f): mode `off` (the default) assembles
	// NOTHING — `prepareVmBoot` returns null before any VM dep resolves, and the
	// boot below is byte-for-byte today's local path (the off-mode boot E2E is
	// the pin). A VM mode runs the fail-fatal preflight SYNCHRONOUSLY here —
	// before anything else VM-ish and before `ensureToken` mints a credential: a
	// miss throws preflight's ONE actionable line, and this module's boot-failure
	// path prints it (`OpenHammer failed to start: <msg>` + exit 1). The service
	// is constructed but NOT started here — see the eager spawn below `listen()`.
	const vmBoot = prepareVmBoot(config, deps.vm);

	const { token } = await ensureToken(config);

	// Live activity capture (17s): one recorder feeds the transport's `onRequest`
	// hook (records each `POST /mcp`) and the status socket (streams it to
	// `openhammer monitor`). Always created so the hook is wired — the socket is
	// the best-effort part (null when it can't bind).
	const recorder = new RequestRecorder();

	// Resolve the boot channel via the registry (17q) BEFORE building Fastify so
	// a live tunnel URL is known and advertised as the public base URL — the OAuth
	// AS metadata (issuer/authorization_endpoint/token_endpoint/resource) + the
	// JWT iss/aud all derive from it, so they must be correct under the tunnel.
	// `null` + a `notice` is the null-safe localhost-only fallback (no channel, or
	// the channel failed to start); the handle's `stop` tears a live channel down
	// on shutdown (static channels have none — the operator owns the endpoint).
	const { handle, notice } = await resolveChannelHandle({
		channelId: config.channelId,
		channels: settings.channels,
		env: process.env,
		wantTunnel: argv.tunnel,
		localPort: config.port,
	});

	// Public base URL precedence: a live tunnel URL (an OpenHammer-managed
	// ngrok/cloudflare channel) > `MCP_PUBLIC_URL` (a manual/external tunnel) >
	// the configured localhost. The single source the OAuth AS metadata, the JWT
	// iss/aud, and the protected-resource `resource` advertise — so a tunnel no
	// longer drags `http://127.0.0.1:<port>` into discovery.
	const baseUrl = handle?.url ?? config.publicUrl ?? `http://${config.host}:${config.port}`;

	// OAuth (spec 20d): resolve the JWT verify config once at boot so the `/mcp`
	// gate accepts an AS-issued HS256 JWT in addition to the opaque token. The
	// `jwtSecret` is the single source (`OAUTH_JWT_SECRET` env or the
	// persisted/minted one — minting on first boot, like `ensureToken`); issuer/
	// audience derive from the public base URL the `/oauth/token` grant signs with,
	// so a grant-issued JWT verifies here. `undefined` (no secret resolvable) →
	// the gate stays opaque-only; the grant still surfaces its own error.
	const { issuer, audience } = oauthIssuerAudience(baseUrl);
	const jwtSecret = resolveJwtSecret();
	const oauth = jwtSecret !== undefined ? { jwtSecret, issuer, audience } : undefined;
	// The boot-scoped tool backend (spec 23): one per server process, threaded
	// through buildFastify → the /mcp routes → every per-request MCP server.
	// Mode `off` keeps today's LocalBackend exactly; a VM mode gets the
	// delegating backend whose every method gates on the service's readiness
	// (27f — not-ready tool calls get the actionable booting err).
	const backend = vmBoot === null ? createLocalBackend() : vmBoot.backend;
	const fastify = await buildFastify(config, token, config.allowedClients, recorder, oauth, baseUrl, backend);
	await fastify.listen({ port: config.port, host: config.host });

	// The eager-async QEMU spawn (spec 27's boot posture): kicked off the moment
	// the LAST fallible boot step has passed, never blocking `listen()` —
	// `/health` serves from here on regardless of VM state (server health ≠ VM
	// health). Starting any earlier would orphan the guest on a later boot
	// failure (`ensureToken`/`EADDRINUSE` exit through the boot-failure path,
	// which never runs the shutdown slot). `start()` resolves when the boot
	// SETTLES (ready or failed) and never rejects — failures surface through
	// `ensureReady`, never here.
	if (vmBoot !== null) {
		void vmBoot.service.start();
	}

	if (notice !== null) {
		fastify.log.warn(notice);
	}

	// The active channel's live state, advertised over the status socket
	// (19c-channel): only the persisted channel (`config.channelId`) maps to a
	// dashboard row, so it is the only id emitted — a provider / `--tunnel`
	// channel has no persisted id (its URL reaches the dashboard via the status
	// panel instead). `up` is whether the boot resolved a handle for it.
	const channelState: ChannelStateLine[] =
		config.channelId !== null
			? [{ type: "channel-state", id: config.channelId, up: handle !== null, url: handle?.url ?? null }]
			: [];

	// The local inspector channel (17s): `~/.openhammer/openhammer.sock` (0600).
	// Null-safe — a bind failure logs + continues serving; the bearer gate (not
	// the socket) is the real gate. Carries the channel-state snapshot (19c-channel)
	// so a connecting dashboard reads each configured channel's up/down + URL.
	const statusSocket = await startStatusSocket(recorder, {
		channels: channelState,
		warn: (message) => fastify.log.warn(message),
	});
	if (statusSocket === null) {
		fastify.log.warn("status socket unavailable — `openhammer monitor` will not work");
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
		// Drop the status socket (drops monitor clients + removes the file) and the
		// recorder's subscribers — best-effort (the `12b` `.catch(()=>{})` idiom).
		if (statusSocket !== null) {
			void statusSocket.close().catch(() => {});
		}
		recorder.close();
		// Best-effort teardown (the `12b` per-promise `.catch(()=>{})` idiom): a
		// live channel's `stop` is idempotent; never block the exit on it.
		const stop = handle?.stop;
		if (stop !== undefined) {
			await stop().catch(() => {});
		}
		// The boot-scoped tool backend's teardown (spec 23) — LocalBackend's
		// `close` is a documented no-op; the VM delegating backend's `close` IS
		// the session stop (mux close → ACPI powerdown → stop ladder → persist
		// teardown, spec 27e). ORDER, deliberately: `fastify.close()` above has
		// already stopped the server from ACCEPTING tool calls and drained what
		// was in flight, so the guest powers down with no call mid-flight
		// against it — stop serving first, THEN stop the sandbox.
		await backend.close().catch(() => {});
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

// Auto-run only when invoked as the entrypoint (`npm start` / `node dist/main.js`),
// not when imported by the CLI dispatcher (17o) or a test — otherwise importing
// `main` would boot a server. Matches the `src/cli.ts` guard: under `tsx src/main.ts`
// (the boot E2E) `process.argv[1]` resolves to this file, so the guard fires.
const invokedDirectly = isMainEntry(process.argv[1], import.meta.url);
if (invokedDirectly) {
	main().catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`OpenHammer failed to start: ${message}`);
		process.exit(1);
	});
}
