/**
 * Channel management ops (spec 17m) — `channel list` / `channel remove <id>` /
 * `channel use <id>`.
 *
 * Pure `Result` transformations over {@link Settings} for the non-add channel
 * subcommands. Each mutating op returns the updated {@link Settings} for the CLI to
 * `saveSettings` — the same doc-via-caller split the add wizard (17k) and the
 * section wizard (17l) use, so the settings doc is written once, by the caller:
 *
 * ```ts
 * const r = removeChannel(settings, id);
 * if (r.ok) saveSettings(path, r.value); // the CLI owns the only doc write
 * else console.error(r.error.message);
 * ```
 *
 * **Boundary posture — secrets here, doc via the caller.** `removeChannel` cascades
 * the channel's secret teardown directly — the inverse of `addChannel`'s
 * `setCredentials`. The secret half is torn down *inside* the op (a `deleteCredentials`
 * write), while the settings doc is returned for the CLI to save. Like the add wizard,
 * the credential-store write is the throwing persistence boundary (it propagates to
 * the CLI, which surfaces actionable stderr); the {@link Result} spine is reserved for
 * the expected domain failure — an unknown id.
 *
 * **`deleteCredentials` is idempotent** (a no-op when the channel never had secrets —
 * e.g. a zero-field cloudflare channel), so the cascade is always safe to run.
 *
 * **Default-channel invariant.** `setDefaultChannel` only ever points the default at an
 * *existing* channel (an unknown id is `err`), so the default can never dangle.
 * `removeChannel` keeps that invariant: if the removed channel was the default, the
 * default resets to `null` (the operator re-picks with `use`), never a stale id.
 *
 * **Hermetic by injection:** the credentials cascade defaults to
 * {@link deleteCredentials} but is injectable (`deleteCreds`), so the unit tests record
 * the cascade without touching `~/.openhammer/credentials.json` — the
 * `11a`/`13`/`17b`–`17k` injection-arg precedent.
 */
import { deleteCredentials } from "../config/credentials.ts";
import type { ChannelEntry, Settings } from "../config/settings.ts";
import { err, ok, type Result } from "../tools/result.ts";

/** Injectable seams so {@link removeChannel} is hermetic (the injection-arg precedent). */
export interface ManageDeps {
	/**
	 * Cascade-delete a channel's secrets (defaults to {@link deleteCredentials}).
	 * A single-arg `(id) => void` so a test injects either a recording fake or a
	 * real `deleteCredentials` bound to a temp path.
	 */
	deleteCreds?: (id: string) => void;
}

/**
 * The channels in a settings doc (pure read). Returns a shallow copy of the array
 * so a caller cannot mutate the doc's channel list through the result; the CLI
 * formats this for `channel list`. Has no failure mode, so no {@link Result}.
 */
export function listChannels(settings: Settings): ChannelEntry[] {
	return [...settings.channels];
}

/**
 * Remove a channel by id and cascade-delete its secrets. Returns the updated
 * {@link Settings} (`ok`) for the CLI to `saveSettings`, or `err` when no channel
 * has that id (nothing written — no cascade, no doc change). If the removed channel
 * was the default, the default resets to `null` (the no-dangling-default invariant).
 *
 * The secret cascade (`deleteCreds`, default {@link deleteCredentials}) is idempotent,
 * so a channel that never had secrets tears down nothing. Treats `settings` as
 * readonly — returns a new object, never mutates the input.
 */
export function removeChannel(settings: Settings, id: string, deps: ManageDeps = {}): Result<Settings, Error> {
	if (!settings.channels.some((c) => c.id === id)) {
		return err(new Error(`No channel with id ${id}`));
	}
	const deleteCreds = deps.deleteCreds ?? deleteCredentials;
	// Cascade the secret teardown — the inverse of addChannel's setCredentials.
	deleteCreds(id);
	const channels = settings.channels.filter((c) => c.id !== id);
	const defaultChannel = settings.defaultChannel === id ? null : settings.defaultChannel;
	return ok({ ...settings, channels, defaultChannel });
}

/**
 * Set the default channel by id (`channel use <id>`). Returns the updated
 * {@link Settings} (`ok`) for the CLI to `saveSettings`, or `err` when no channel
 * has that id (nothing written). The id must reference an existing channel — so the
 * default can never dangle. Treats `settings` as readonly.
 */
export function setDefaultChannel(settings: Settings, id: string): Result<Settings, Error> {
	if (!settings.channels.some((c) => c.id === id)) {
		return err(new Error(`No channel with id ${id}`));
	}
	return ok({ ...settings, defaultChannel: id });
}
