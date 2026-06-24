/**
 * The channel-add wizard (spec 17k) — the `openhammer channel add` flow.
 *
 * {@link addChannel} drives the whole flow over the registry + schema engines with
 * **zero per-channel code**: pick a provider from the registry → collect its
 * `fields` via the generic {@link runWizard} → validate with
 * `provider.probe?.(answers)` under a pi-tui `Loader` spinner ({@link runSpinner},
 * spec 21c) → on success append a {@link ChannelEntry} (secrets split out to the
 * credentials store) and set `defaultChannel` if it is the first. Adding a channel
 * is one provider file + one registry line — this wizard never changes (the
 * scalability seam proven again by 17l's section wizard reusing the same
 * {@link runWizard}).
 *
 * **Composition — one banner, from {@link runWizard}.** The provider select leads
 * (a bare `io.select`), then {@link runWizard} frames the field-configuration
 * phase with the banner + `intro`/`outro` (its single source is `withSession`).
 * The channel wizard deliberately does not print its own banner — that would
 * double it. This mirrors the section wizard (17l: select a section, then
 * `runWizard`), so both config families reuse `runWizard`'s framing unchanged.
 *
 * **Boundary posture — secrets here, doc via the caller.** The wizard persists
 * *secrets* (the default `setSecrets` → {@link setCredentials} writes
 * `~/.openhammer/credentials.json`) but returns the updated {@link Settings} for
 * the CLI to `saveSettings` — the same split 17m's remove/use use (the CLI owns
 * the settings-doc write). Secrets are written only when there are any (a
 * zero-secret channel like cloudflare never touches `credentials.json`); a
 * cancelled or probe-failed run writes nothing.
 *
 * **Probe gate — static only at add-time (the 17i reconciliation).** Only
 * `mode:"static"` providers are probed here: their endpoint is the operator's
 * already-deployed reverse proxy, so `fetch(publicUrl/health)` is a real
 * reachability check. A `mode:"live"` provider's endpoint is created by OpenHammer
 * at `start` time — it does not exist at config time (no server running, no
 * tunnel), so its probe is deferred to runtime (`start`/`doctor`, 17q/17p). This
 * is the ngrok note's "reconciled when 17k lands": the bare-registry ngrok
 * provider's probe needs a local-server port that is absent at `channel add`
 * time, so the wizard never calls it (the authtoken is validated when `start`
 * connects; a bad token falls back to localhost). The gate is a `mode` rule — no
 * per-channel code — so `channel add` works for all four kinds.
 *
 * **Result spine:** `ok(Settings)` on success (entry appended, `defaultChannel`
 * set if first, secrets written when any); `err(Error)` when the probe fails (no
 * write — the CLI reports it); `null` on cancel / a required field left empty (no
 * write, silent). The graceful-absent (`null`) vs surfaced-failure (`err`) split
 * the rest of the TUI layer uses.
 *
 * **Hermetic by injection:** `io`, the registry, the id minter, the secret writer,
 * and the probe spinner all default to production but are passed by the unit
 * tests, so pi-tui, `crypto`, and `~/.openhammer` never touch the hermetic
 * trio — the `11a`/`13`/`17b`–`17j` injection-arg precedent.
 */
import { randomUUID } from "node:crypto";
import { type CredentialValues, setCredentials } from "../../config/credentials.ts";
import type { ChannelEntry, Settings } from "../../config/settings.ts";
import { err, ok, type Result } from "../../tools/result.ts";
import type { ChannelProvider } from "../../tunnel/index.ts";
import { CHANNELS } from "../../tunnel/index.ts";
import type { BannerStream } from "../banner.ts";
import { runSpinner } from "../prompt-loop.ts";
import { defaultIo } from "../prompts.ts";
import { runWizard, type WizardIo } from "../wizard.ts";

/**
 * Run a fallible probe under a spinner. The default drives a pi-tui `Loader`
 * via {@link runSpinner} (spec 21c — the `ora` replacement); CLI-only like the
 * wizard itself, it never runs in the `--omit=dev` prod image. Tests inject an
 * identity runner (`(_label, fn) => fn()`) so no spinner / TTY touches the
 * hermetic trio.
 */
export type ProbeRunner = <T>(label: string, fn: () => Promise<Result<T, Error>>) => Promise<Result<T, Error>>;

/**
 * Format a probe {@link Result} as the spinner's final status line — `✓` on
 * success, `✗ <message>` on failure (the `ora` `succeed()`/`fail()` parity).
 * Pure + exported so the formatting is unit-tested without a terminal
 * (the {@link formatDoctor}/`extractTunnelUrl` "export the pure testable part"
 * precedent); {@link defaultProbeRunner} threads it into {@link runSpinner}.
 */
export function formatProbeResult<T>(label: string, result: Result<T, Error>): string {
	return result.ok ? `✓ ${label}` : `✗ ${result.error.message}`;
}

/** The default probe runner — a pi-tui `Loader` spinner (via {@link runSpinner}) that ends on the result. */
const defaultProbeRunner: ProbeRunner = (label, fn) => runSpinner(label, fn, (r) => formatProbeResult(label, r));

/**
 * The provider-picker select's message — the non-interactive address for the
 * picker (spec 20g): the flag path builds its `flagIo` answers keyed by this, so
 * the flag-driven {@link addChannel} resolves the `--provider` choice through the
 * same `io.select` the interactive wizard uses. Exported (not a private literal)
 * so the cli + the wizard share one source — a rename here can't silently break
 * the flag path.
 */
export const CHANNEL_SELECT_PROMPT = "Channel type";

/** Read the global registry's providers at call time (tests mutate CHANNELS — never snapshot at load). */
export function registryProviders(): ChannelProvider[] {
	return Object.values(CHANNELS).filter((p): p is ChannelProvider => p !== undefined);
}

/** Injectable seams so {@link addChannel} is hermetic (the `11a`/`13`/`17b`–`17j` injection-arg precedent). */
export interface AddChannelDeps {
	/** The io driving the provider select + field prompts (defaults to {@link defaultIo}). */
	io?: WizardIo;
	/** Banner destination for {@link runWizard} (defaults to `process.stdout`). */
	stream?: BannerStream;
	/** Channels to pick from (defaults to the global {@link CHANNELS} registry, read at call time). */
	channels?: ChannelProvider[];
	/** Mint a fresh channel id (defaults to `crypto.randomUUID()`). */
	newId?: () => string;
	/** Persist a channel's secrets (defaults to {@link setCredentials} → `~/.openhammer/credentials.json`). */
	setSecrets?: (id: string, values: CredentialValues) => void;
	/** Wrap the probe in a spinner (defaults to a pi-tui `Loader` via {@link runSpinner}; tests pass an identity fn). */
	probeRunner?: ProbeRunner;
}

/**
 * The {@link addChannel} outcome: `ok(Settings)` (added — the CLI saves the
 * returned doc), `err(Error)` (the probe failed — no write), or `null`
 * (cancelled / incomplete — no write).
 */
export type AddChannelResult = Result<Settings, Error> | null;

/**
 * Run the `openhammer channel add` flow and return the updated {@link Settings}
 * (secrets persisted; the caller `saveSettings`s the doc). Returns:
 * - `ok(Settings)` — the channel was added (entry appended; `defaultChannel` set
 *   when it was the first channel; secrets written when any).
 * - `err(Error)` — a static provider's `probe` failed (nothing written). The CLI
 *   reports `error.message`.
 * - `null` — the operator cancelled the select or a field, or left a required
 *   field empty (nothing written; silent).
 *
 * With the production defaults this is the CLI call; tests inject a fake provider
 * + `io` + `setSecrets` + `probeRunner`.
 */
export async function addChannel(settings: Settings, deps: AddChannelDeps = {}): Promise<AddChannelResult> {
	const io = deps.io ?? defaultIo;
	const providers = deps.channels ?? registryProviders();
	const newId = deps.newId ?? randomUUID;
	const setSecrets = deps.setSecrets ?? setCredentials;
	const probeRunner = deps.probeRunner ?? defaultProbeRunner;

	if (providers.length === 0) {
		return err(new Error("No channel providers are registered"));
	}

	// 1. Pick a provider kind from the registry.
	const chosen = await io.select({
		message: CHANNEL_SELECT_PROMPT,
		options: providers.map((p) => ({ value: p.kind, label: p.kind, hint: p.mode })),
	});
	if (chosen === null) return null; // cancel
	const provider = providers.find((p) => p.kind === chosen);
	if (!provider) return null; // defensive: `chosen` came from `providers`' options

	// 2. Collect the provider's fields (runWizard prints the banner + intro/outro).
	const answers = await runWizard(`Add a ${provider.kind} channel`, provider.fields, io, { stream: deps.stream });
	if (answers === null) return null; // cancel / required-empty

	// 3. Validate via the provider's probe, under a spinner. Static only at add-time
	//    (see the probe-gate note above); capturing `probe` in a local so the closure
	//    narrows without a non-null assertion.
	if (provider.mode === "static" && provider.probe) {
		const probe = provider.probe;
		const probed = await probeRunner(`Validating ${provider.kind}…`, () => probe(answers));
		if (!probed.ok) return probed; // probe-fail → no write
	}

	// 4. Split answers: secret fields → credentials store; the rest → entry options.
	const secrets: CredentialValues = {};
	const options: Record<string, string> = {};
	for (const field of provider.fields) {
		if (field.kind === "secret") secrets[field.key] = answers[field.key];
		else options[field.key] = answers[field.key];
	}
	const id = newId();
	// Only touch credentials.json when there are secrets (a zero-secret channel never does).
	if (Object.keys(secrets).length > 0) setSecrets(id, secrets);

	// 5. Append the entry; set defaultChannel when this is the first channel.
	const entry: ChannelEntry = { id, kind: provider.kind, mode: provider.mode, options };
	const isFirst = settings.channels.length === 0;
	return ok({
		...settings,
		channels: [...settings.channels, entry],
		defaultChannel: isFirst ? id : settings.defaultChannel,
	});
}
