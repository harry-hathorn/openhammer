import { describe, expect, it } from "vitest";
import type { CredentialValues } from "../../config/credentials.ts";
import {
	type ChannelEntry,
	type ChannelKind,
	type ChannelMode,
	defaultSettings,
	type Settings,
} from "../../config/settings.ts";
import { err, ok } from "../../tools/result.ts";
import type { ChannelProvider } from "../../tunnel/index.ts";
import { BANNER } from "../banner.ts";
import type { ConfigField } from "../schema.ts";
import type { WizardIo } from "../wizard.ts";
import { type AddChannelResult, addChannel, formatProbeResult } from "./channel.ts";

/**
 * A recording fake {@link WizardIo} — no TTY, no clack. Each primitive shifts its
 * next answer from a per-kind queue (`null` simulates cancel); the channel wizard
 * consumes `select` first (the provider kind) then the field primitives in
 * declaration order (driven by `runWizard`). Mirrors wizard.test.ts's per-method
 * shape so every method returns only its own type — no casts.
 */
function fakeIo(returns: {
	select?: (string | null)[];
	text?: (string | null)[];
	password?: (string | null)[];
	confirm?: (boolean | null)[];
}): WizardIo {
	const take = <T>(arr: T[] | undefined): T | null => {
		if (!arr || arr.length === 0) return null;
		const v = arr.shift();
		return v === undefined ? null : v;
	};
	return {
		async select() {
			return take(returns.select);
		},
		async text() {
			return take(returns.text);
		},
		async password() {
			return take(returns.password);
		},
		async confirm() {
			return take(returns.confirm);
		},
		intro() {},
		outro() {},
	};
}

/** A recording BannerStream — captures bytes exactly like banner.test.ts / wizard.test.ts. */
function fakeStream(): { stream: { write(c: string | Uint8Array): boolean }; written: () => string } {
	let out = "";
	const stream = {
		write(c: string | Uint8Array): boolean {
			out += typeof c === "string" ? c : Buffer.from(c).toString("utf8");
			return true;
		},
	};
	return { stream, written: () => out };
}

/** Build a fake provider — only the surface the wizard touches (`fields` + `probe` + `mode`). */
function fakeProvider(opts: {
	kind?: ChannelKind;
	mode?: ChannelMode;
	fields?: ConfigField[];
	probe?: ChannelProvider["probe"];
}): ChannelProvider {
	return {
		kind: opts.kind ?? "ngrok",
		mode: opts.mode ?? "live",
		fields: opts.fields ?? [],
		isAvailable: async () => true,
		probe: opts.probe,
	};
}

/** Identity probe runner — runs the probe with no spinner (no `ora` in the test graph). */
const identityProbe = async <T>(_label: string, fn: () => Promise<T>): Promise<T> => fn();

/** A recording `setSecrets` — captures the persisted id + secret bag. */
function recordingSecrets(): {
	fn: (id: string, v: CredentialValues) => void;
	calls: { id: string; values: CredentialValues }[];
} {
	const calls: { id: string; values: CredentialValues }[] = [];
	return { fn: (id, values) => calls.push({ id, values }), calls };
}

const fixedId = () => "id-1234";

describe("formatProbeResult — spinner final status line (spec 21c)", () => {
	it("formats a success with ✓ + the label", () => {
		expect(formatProbeResult("Validating nginx…", ok(undefined))).toBe("✓ Validating nginx…");
	});

	it("formats a failure with ✗ + the error message", () => {
		expect(formatProbeResult("Validating nginx…", err(new Error("publicUrl /health returned 502")))).toBe(
			"✗ publicUrl /health returned 502",
		);
	});
});

describe("addChannel — happy path", () => {
	it("appends a static channel, probes it, and sets defaultChannel (first channel)", async () => {
		const provider = fakeProvider({
			kind: "nginx",
			mode: "static",
			fields: [{ key: "publicUrl", label: "public URL", kind: "text", required: true }],
			probe: async () => ok(undefined),
		});
		const { stream, written } = fakeStream();
		const secrets = recordingSecrets();
		const io = fakeIo({ select: ["nginx"], text: ["https://oh.example.com"] });

		const result = await addChannel(defaultSettings(), {
			io,
			stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: secrets.fn,
			probeRunner: identityProbe,
		});

		expect(result).toEqual(
			ok({
				...defaultSettings(),
				channels: [
					{ id: "id-1234", kind: "nginx", mode: "static", options: { publicUrl: "https://oh.example.com" } },
				],
				defaultChannel: "id-1234",
			}),
		);
		// A static channel with no secret field never touches the credentials store.
		expect(secrets.calls).toHaveLength(0);
		// runWizard printed the banner once (framing the field phase) to the injected stream.
		expect(written()).toBe(`${BANNER}\n`);
	});

	it("persists a live channel's secret + options and skips its probe (no server at add-time)", async () => {
		const provider = fakeProvider({
			kind: "ngrok",
			mode: "live",
			fields: [
				{ key: "authtoken", label: "ngrok authtoken", kind: "secret", required: true },
				{ key: "region", label: "region", kind: "text" },
			],
			// A probe that would err without a port — never called for a live channel at add-time.
			probe: async () => err(new Error("ngrok probe requires a local server port")),
		});
		const { stream } = fakeStream();
		const secrets = recordingSecrets();
		const io = fakeIo({ select: ["ngrok"], password: ["tok-abc"], text: ["us"] });

		const result = await addChannel(defaultSettings(), {
			io,
			stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: secrets.fn,
			probeRunner: identityProbe,
		});

		expect(result).toEqual(
			ok({
				...defaultSettings(),
				channels: [{ id: "id-1234", kind: "ngrok", mode: "live", options: { region: "us" } }],
				defaultChannel: "id-1234",
			}),
		);
		// The secret went to the credentials store; only the secret field, not `region`.
		expect(secrets.calls).toEqual([{ id: "id-1234", values: { authtoken: "tok-abc" } }]);
	});

	it("does not change defaultChannel when a channel already exists", async () => {
		const existing: ChannelEntry = { id: "old", kind: "nginx", mode: "static", options: { publicUrl: "https://x" } };
		const settings: Settings = { ...defaultSettings(), channels: [existing], defaultChannel: "old" };
		const provider = fakeProvider({
			kind: "nginx",
			mode: "static",
			fields: [{ key: "publicUrl", label: "public URL", kind: "text", required: true }],
			probe: async () => ok(undefined),
		});
		const io = fakeIo({ select: ["nginx"], text: ["https://y"] });

		const result = await addChannel(settings, {
			io,
			stream: fakeStream().stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: recordingSecrets().fn,
			probeRunner: identityProbe,
		});

		expect(result?.ok).toBe(true);
		if (result?.ok) {
			expect(result.value.defaultChannel).toBe("old"); // unchanged — only the first channel becomes default
			expect(result.value.channels).toHaveLength(2);
		}
	});
});

describe("addChannel — no write paths", () => {
	it("returns null and writes nothing when the operator cancels the select", async () => {
		const provider = fakeProvider({ kind: "ngrok", fields: [{ key: "authtoken", label: "t", kind: "secret" }] });
		const secrets = recordingSecrets();
		const io = fakeIo({ select: [null] });

		const result = await addChannel(defaultSettings(), {
			io,
			stream: fakeStream().stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: secrets.fn,
			probeRunner: identityProbe,
		});

		expect(result).toBeNull();
		expect(secrets.calls).toHaveLength(0);
	});

	it("returns null and writes nothing when a field is cancelled", async () => {
		const provider = fakeProvider({
			kind: "ngrok",
			fields: [{ key: "authtoken", label: "t", kind: "secret", required: true }],
		});
		const secrets = recordingSecrets();
		const io = fakeIo({ select: ["ngrok"], password: [null] }); // cancel the required secret

		const result = await addChannel(defaultSettings(), {
			io,
			stream: fakeStream().stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: secrets.fn,
			probeRunner: identityProbe,
		});

		expect(result).toBeNull();
		expect(secrets.calls).toHaveLength(0);
	});

	it("returns err and writes nothing when a static provider's probe fails", async () => {
		const provider = fakeProvider({
			kind: "nginx",
			mode: "static",
			fields: [{ key: "publicUrl", label: "public URL", kind: "text", required: true }],
			probe: async () => err(new Error("publicUrl /health returned 502")),
		});
		const secrets = recordingSecrets();
		const io = fakeIo({ select: ["nginx"], text: ["https://oh.example.com"] });

		const result: AddChannelResult = await addChannel(defaultSettings(), {
			io,
			stream: fakeStream().stream,
			channels: [provider],
			newId: fixedId,
			setSecrets: secrets.fn,
			probeRunner: identityProbe,
		});

		expect(result).toEqual(err(new Error("publicUrl /health returned 502")));
		expect(secrets.calls).toHaveLength(0);
	});

	it("returns err when the registry has no providers", async () => {
		const result = await addChannel(defaultSettings(), {
			io: fakeIo({}),
			stream: fakeStream().stream,
			channels: [],
			newId: fixedId,
			setSecrets: recordingSecrets().fn,
			probeRunner: identityProbe,
		});

		expect(result).toEqual(err(new Error("No channel providers are registered")));
	});
});
