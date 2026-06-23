import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, deleteCredentials, getCredentials, setCredentials } from "../config/credentials.ts";
import {
	type ChannelEntry,
	type ChannelKind,
	type ChannelMode,
	defaultSettings,
	type Settings,
} from "../config/settings.ts";
import { err, ok } from "../tools/result.ts";
import { listChannels, removeChannel, setDefaultChannel } from "./manage.ts";

/** Build a channel entry with a stable id + a declared `publicUrl` option. */
function channel(id: string, kind: ChannelKind = "nginx", mode: ChannelMode = "static"): ChannelEntry {
	return { id, kind, mode, options: { publicUrl: `https://${id}.example.com` } };
}

/** Settings carrying the given channels + an optional default. */
function withChannels(channels: ChannelEntry[], defaultChannel: string | null = null): Settings {
	return { ...defaultSettings(), channels, defaultChannel };
}

/** A recording credential deleter — captures which ids were cascaded (no fs). */
function recordingDelete(): { fn: (id: string) => void; calls: string[] } {
	const calls: string[] = [];
	return { fn: (id) => calls.push(id), calls };
}

describe("listChannels", () => {
	it("returns an empty array for default settings", () => {
		expect(listChannels(defaultSettings())).toEqual([]);
	});

	it("returns the doc's channels", () => {
		const settings = withChannels([channel("a"), channel("b")]);
		expect(listChannels(settings).map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("returns a copy — mutating it does not affect the source doc", () => {
		const settings = withChannels([channel("a"), channel("b")]);
		const list = listChannels(settings);
		list.pop();
		expect(settings.channels).toHaveLength(2); // source untouched
	});
});

describe("removeChannel", () => {
	it("removes the matching entry and returns ok with the rest", () => {
		const settings = withChannels([channel("a"), channel("b"), channel("c")]);

		const result = removeChannel(settings, "b", { deleteCreds: recordingDelete().fn });

		expect(result).toEqual(ok(withChannels([channel("a"), channel("c")])));
	});

	it("cascades the channel's credentials", () => {
		const settings = withChannels([channel("a"), channel("b")]);
		const deleter = recordingDelete();

		removeChannel(settings, "a", { deleteCreds: deleter.fn });

		expect(deleter.calls).toEqual(["a"]); // the removed id is cascaded
	});

	it("resets defaultChannel to null when removing the default", () => {
		const settings = withChannels([channel("a"), channel("b")], "a");

		const result = removeChannel(settings, "a", { deleteCreds: recordingDelete().fn });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.defaultChannel).toBeNull();
			expect(result.value.channels.map((c) => c.id)).toEqual(["b"]);
		}
	});

	it("leaves defaultChannel untouched when removing a non-default channel", () => {
		const settings = withChannels([channel("a"), channel("b")], "b");

		const result = removeChannel(settings, "a", { deleteCreds: recordingDelete().fn });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.defaultChannel).toBe("b");
	});

	it("returns err and cascades nothing when the id is unknown", () => {
		const settings = withChannels([channel("a")]);
		const deleter = recordingDelete();

		const result = removeChannel(settings, "missing", { deleteCreds: deleter.fn });

		expect(result).toEqual(err(new Error("No channel with id missing")));
		expect(deleter.calls).toEqual([]); // no cascade on the unknown-id path
	});

	it("does not mutate the input settings", () => {
		const settings = withChannels([channel("a"), channel("b")]);

		removeChannel(settings, "a", { deleteCreds: recordingDelete().fn });

		expect(settings.channels.map((c) => c.id)).toEqual(["a", "b"]); // untouched
		expect(settings.defaultChannel).toBeNull();
	});
});

describe("removeChannel — real credential cascade", () => {
	// Exercises the production default wiring (`deleteCredentials`) against a temp
	// `~/.openhammer/credentials.json` — the strongest proof that "remove cascades its
	// credentials" uses the real secrets store, not a fake. Injects the real fn bound
	// to a temp path so the dev box's own credentials file is never touched.
	let dir: string;
	let credPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "openhammer-manage-"));
		credPath = credentialsPath(dir);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("removes the channel's secret bag from credentials.json", () => {
		setCredentials("c1", { authtoken: "t0p-secret" }, credPath);
		setCredentials("c2", { authtoken: "other" }, credPath); // a sibling must survive
		const settings = withChannels([channel("c1"), channel("c2")]);

		const result = removeChannel(settings, "c1", { deleteCreds: (id) => deleteCredentials(id, credPath) });

		expect(result.ok).toBe(true);
		expect(getCredentials("c1", credPath)).toEqual({}); // torn down
		expect(getCredentials("c2", credPath)).toEqual({ authtoken: "other" }); // sibling intact
	});

	it("is safe when the channel had no secrets (idempotent cascade)", () => {
		const settings = withChannels([channel("c1")]); // never seeded any secrets

		const result = removeChannel(settings, "c1", { deleteCreds: (id) => deleteCredentials(id, credPath) });

		expect(result.ok).toBe(true); // no throw — deleteCredentials no-ops on an absent id
		expect(getCredentials("c1", credPath)).toEqual({});
	});
});

describe("setDefaultChannel", () => {
	it("sets defaultChannel to the id and returns ok", () => {
		const settings = withChannels([channel("a"), channel("b")], "a");

		const result = setDefaultChannel(settings, "b");

		expect(result).toEqual(ok(withChannels([channel("a"), channel("b")], "b")));
	});

	it("sets a default when none was set before", () => {
		const settings = withChannels([channel("a"), channel("b")], null);

		const result = setDefaultChannel(settings, "b");

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.defaultChannel).toBe("b");
	});

	it("returns err when the id is unknown (default never dangles)", () => {
		const settings = withChannels([channel("a")]);

		expect(setDefaultChannel(settings, "missing")).toEqual(err(new Error("No channel with id missing")));
	});

	it("does not mutate the input settings", () => {
		const settings = withChannels([channel("a"), channel("b")], "a");

		setDefaultChannel(settings, "b");

		expect(settings.defaultChannel).toBe("a"); // untouched
	});
});
