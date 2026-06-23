/**
 * The `openhammer doctor` command + its built-in checks (spec 17p).
 *
 * `doctor` runs the diagnostics registry's checks plus one dynamic check per
 * configured channel, and prints the results grouped by status (fail first, then
 * warn, then pass). The built-in checks probe the install: `config.json` parses
 * and is a valid settings doc; each `Settings.channels` entry's provider is
 * `isAvailable` (live — binary/secret present) or `probe`-reachable (static — the
 * operator's declared endpoint answers `/health`); `credentials.json` is
 * owner-only (`0600`); `rg`/`fd` are on `PATH`. Each check is isolated
 * ({@link safeRun} turns a throw into a `fail`), so `doctor` never throws.
 *
 * **Self-registration.** The built-in checks register into the global
 * {@link DIAGNOSTICS} registry at this module's load, mirroring how the channel
 * providers register into `CHANNELS` at `tunnel/index.ts` load. This is the
 * TDZ-safe shape, **not** the trap the 17g note flags: `doctor.ts → registry.ts`
 * is one-directional (registry.ts imports nothing), so registry.ts fully
 * initializes `DIAGNOSTICS` before this module's top-level code runs — there is
 * no side-effect `import` hoisted above a `const` in the *same* module (the
 * 17g hazard). `doctorCommand` therefore reads `getDiagnostics()` and sees the
 * built-ins in production.
 *
 * **Hermeticity — injection-arg precedent.** Every external touch (paths,
 * `getChannel`, `getCredentials`, `isToolAvailable`, the static check set) is an
 * injectable dep, so the unit tests exercise each check + `runDiagnostics` +
 * `doctorCommand` against temp paths and fakes without touching the real
 * `~/.openhammer` or `PATH` (the `11a`/`13`/`17b`–`17m` precedent).
 *
 * **Exit code.** `1` if any check `fail`s (a real problem — lets CI/scripts
 * gate on `doctor`); `0` otherwise. A `warn` is advisory and does not fail the
 * command (the install still works).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { type CredentialValues, credentialsPath, getCredentials } from "../config/credentials.ts";
import { type ChannelEntry, loadSettings, normalizeSettings, type Settings, settingsPath } from "../config/settings.ts";
import {
	type DiagnosticCheck,
	type DiagnosticResult,
	type DiagnosticStatus,
	getDiagnostics,
	registerDiagnostic,
} from "../diagnostics/registry.ts";
import { isToolAvailable } from "../tools/bin.ts";
import type { BannerStream } from "../tui/banner.ts";
import { type ChannelProvider, getChannel } from "../tunnel/index.ts";

/** Narrow an unknown catch value to its message string (AGENTS.md: `catch` is `unknown`). */
function messageOf(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/**
 * Wrap a check's `run` so a thrown error becomes a `fail` result. A check should
 * return its own `fail` rather than throw, but the safety net keeps one buggy
 * check from aborting the whole `doctor` run — every check is isolated.
 */
async function safeRun(check: DiagnosticCheck): Promise<DiagnosticResult> {
	try {
		return await check.run();
	} catch (e) {
		return { status: "fail", message: `${check.id} check threw: ${messageOf(e)}` };
	}
}

/** Where {@link doctorCommand} writes — a structural slice of the CLI's `CommandIo` (avoids a `cli.ts` import cycle). */
export interface DoctorIo {
	stdout: BannerStream;
}

/** One check's outcome paired with its id, for grouped printing. */
export interface DiagnosticReport {
	id: string;
	result: DiagnosticResult;
}

/**
 * The `config.json` check: the file is valid JSON **and** a valid {@link Settings}
 * doc. Absent → `pass` (defaults are fine); present-but-unparseable or
 * structurally invalid → `fail`. `loadSettings` hides corruption behind safe
 * defaults; this check surfaces it (via {@link normalizeSettings}, the
 * single-source validator).
 */
export function createConfigCheck(path: string = settingsPath()): DiagnosticCheck {
	return {
		id: "config",
		run: async () => {
			if (!existsSync(path)) return { status: "pass", message: "config.json absent (using defaults)" };
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(path, "utf-8"));
			} catch (e) {
				return { status: "fail", message: `config.json is not valid JSON: ${messageOf(e)}` };
			}
			return normalizeSettings(parsed) !== null
				? { status: "pass", message: "config.json is a valid settings document" }
				: { status: "fail", message: "config.json is not a valid settings document" };
		},
	};
}

/**
 * The `credentials.json` perms check: when present, the secrets file is
 * owner-only (`0600`). Absent → `pass` (no secrets stored yet); too-open → `warn`
 * (the install still works, but secrets are group/other-readable — fix with
 * `chmod 600`). A secrets-file perm drift is advisory, not a hard failure.
 */
export function createCredentialsCheck(path: string = credentialsPath()): DiagnosticCheck {
	return {
		id: "credentials",
		run: async () => {
			if (!existsSync(path)) return { status: "pass", message: "credentials.json absent (no secrets stored)" };
			const mode = statSync(path).mode & 0o777;
			if (mode === 0o600) return { status: "pass", message: "credentials.json perms 0600 (owner-only)" };
			return {
				status: "warn",
				message: `credentials.json perms 0${mode.toString(8)}, expected 0600 (run: chmod 600 credentials.json)`,
			};
		},
	};
}

/**
 * The binary-presence check for a runtime tool (`rg`/`fd`): present → `pass`;
 * absent → `fail` (the tool backed by it — `grep` for `rg`, `find` for `fd` — is
 * unavailable). Mirrors the `grep`/`find` `isToolAvailable` gate.
 */
export function createBinaryCheck(
	name: "rg" | "fd",
	isAvailable: (name: string) => boolean = isToolAvailable,
): DiagnosticCheck {
	return {
		id: name,
		run: async () =>
			isAvailable(name)
				? { status: "pass", message: `${name} present` }
				: {
						status: "fail",
						message: `${name} not found on PATH — the ${name === "rg" ? "grep" : "find"} tool will be unavailable`,
					},
	};
}

/**
 * The per-channel check. A **live** channel's provider must be `isAvailable`
 * (its binary present on PATH — `cloudflared` for cloudflare, `ngrok` for ngrok;
 * a future live provider may instead gate on a secret); a **static** channel's
 * declared endpoint must be `probe`-reachable. The full options bag merges the
 * entry's non-secret `options` with its secrets (`getCredentials`) so a
 * secret-gated `isAvailable` (or a `probe`) sees its values.
 * `not available` / unreachable → `warn` (the channel won't function, but the
 * server still boots localhost-only); an unregistered kind → `fail` (config error).
 */
export function createChannelCheck(
	entry: ChannelEntry,
	deps: Pick<DoctorDeps, "getChannel" | "getCredentials"> = {},
): DiagnosticCheck {
	const getChan = deps.getChannel ?? getChannel;
	const getCreds = deps.getCredentials ?? getCredentials;
	return {
		id: `channel:${entry.id}`,
		run: async () => {
			const provider = getChan(entry.kind);
			if (!provider) {
				return { status: "fail", message: `channel ${entry.id}: no provider registered for kind "${entry.kind}"` };
			}
			const options = { ...entry.options, ...getCreds(entry.id) };
			if (provider.mode === "live") {
				const available = await provider.isAvailable(options);
				return available
					? { status: "pass", message: `channel ${entry.id} (${entry.kind}): ready` }
					: {
							status: "warn",
							message: `channel ${entry.id} (${entry.kind}): not available (missing binary or secret)`,
						};
			}
			// static → probe the operator's declared endpoint (no `start` to run).
			const probe = provider.probe;
			if (!probe) return { status: "pass", message: `channel ${entry.id} (${entry.kind}): configured` };
			const probed = await probe(options);
			return probed.ok
				? { status: "pass", message: `channel ${entry.id} (${entry.kind}): reachable` }
				: { status: "warn", message: `channel ${entry.id} (${entry.kind}): ${probed.error.message}` };
		},
	};
}

/**
 * The canonical static check set (config + credentials + rg + fd), built with the
 * given paths/`isAvailable` so tests inject temp paths; production calls it with
 * no args (real paths + the real `isToolAvailable`). Registered into the global
 * registry at module load so `getDiagnostics()` reflects what `doctor` runs.
 */
export function createDefaultChecks(
	deps: { settingsPath?: string; credentialsPath?: string; isAvailable?: (name: string) => boolean } = {},
): DiagnosticCheck[] {
	return [
		createConfigCheck(deps.settingsPath),
		createCredentialsCheck(deps.credentialsPath),
		createBinaryCheck("rg", deps.isAvailable),
		createBinaryCheck("fd", deps.isAvailable),
	];
}

/**
 * Injectable seams for {@link runDiagnostics} / {@link doctorCommand} — the
 * `11a`/`13`/`17b`–`17m` injection-arg precedent, so the unit tests stay hermetic.
 */
export interface DoctorDeps {
	/** Settings to derive the per-channel checks from (defaults to `loadSettings` at {@link settingsPath}). */
	settings?: Settings;
	/** Path to `config.json` (defaults to {@link settingsPath}; used when `settings` is absent). */
	settingsPath?: string;
	/** Override channel-kind resolution (defaults to the registry {@link getChannel}). */
	getChannel?: (kind: ChannelEntry["kind"]) => ChannelProvider | undefined;
	/** Override secret lookup (defaults to {@link getCredentials} at {@link credentialsPath}). */
	getCredentials?: (id: string) => CredentialValues;
	/** Override the static check set (defaults to the registry {@link getDiagnostics}). */
	checks?: DiagnosticCheck[];
}

/**
 * Run every registered check plus one per configured channel, returning the
 * paired id+result list. The static checks run first (in registry order), then
 * the per-channel checks in `settings.channels` order. `deps.checks` overrides
 * the static set (tests inject temp-path built-ins); `deps.settings`/
 * `getChannel`/`getCredentials` override the channel family. Production calls
 * with no deps (the registry's built-ins + real settings). Each check is isolated
 * via {@link safeRun}, so a run never throws.
 */
export async function runDiagnostics(deps: DoctorDeps = {}): Promise<DiagnosticReport[]> {
	const settings = deps.settings ?? loadSettings(deps.settingsPath ?? settingsPath());
	const staticChecks = deps.checks ?? getDiagnostics();
	const channelChecks = settings.channels.map((entry) => createChannelCheck(entry, deps));
	const reports: DiagnosticReport[] = [];
	for (const check of [...staticChecks, ...channelChecks]) {
		reports.push({ id: check.id, result: await safeRun(check) });
	}
	return reports;
}

// Statuses printed worst-first (a `fail` is the thing to read first); grouped in this order.
const STATUS_ORDER: readonly DiagnosticStatus[] = ["fail", "warn", "pass"];

/**
 * Format the reports as a human-readable block grouped by status (fail, then
 * warn, then pass), each group a `[status]` header over `id: message` lines,
 * led by a one-line summary. Pure — unit-tested without an io stream.
 */
export function formatDoctor(reports: DiagnosticReport[]): string {
	const counts: Record<DiagnosticStatus, number> = { pass: 0, warn: 0, fail: 0 };
	for (const { result } of reports) counts[result.status] += 1;
	const blocks: string[] = [
		`Ran ${reports.length} check(s): ${counts.fail} fail, ${counts.warn} warn, ${counts.pass} pass.`,
	];
	for (const status of STATUS_ORDER) {
		const group = reports.filter((r) => r.result.status === status);
		if (group.length === 0) continue;
		const lines = [`[${status}]`];
		for (const { id, result } of group) lines.push(`  ${id}: ${result.message}`);
		blocks.push(lines.join("\n"));
	}
	return blocks.join("\n\n");
}

/**
 * The `openhammer doctor` command: run every check, print the results grouped by
 * status, and return the exit code (`1` if any check `fail`ed, else `0` — a
 * `warn` is advisory). Mirrors the channel/config command shape (io in, exit code
 * out); `deps` threads through to {@link runDiagnostics} for hermetic tests.
 */
export async function doctorCommand(io: DoctorIo, deps: DoctorDeps = {}): Promise<number> {
	const reports = await runDiagnostics(deps);
	io.stdout.write(`${formatDoctor(reports)}\n`);
	return reports.some((r) => r.result.status === "fail") ? 1 : 0;
}

// Register the built-in checks so `getDiagnostics()` reflects what `doctor` runs
// (mirrors how the channel providers register into CHANNELS at index.ts load).
// doctor.ts → registry.ts is one direction, so this self-registration is TDZ-safe
// (registry.ts fully loads before this module's top-level code runs — no cycle).
for (const check of createDefaultChecks()) registerDiagnostic(check);
