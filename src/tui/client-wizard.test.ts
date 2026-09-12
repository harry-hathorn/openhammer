import { describe, expect, it } from "vitest";
import { GRANT_AUTHORIZATION_CODE, GRANT_CLIENT_CREDENTIALS } from "../auth/oauth/clients.ts";
import { clientConfigFromFlags, collectClientConfig, parseRedirectUris } from "./client-wizard.ts";
import type { PromptIo } from "./prompts.ts";

/** A per-primitive-queue fake {@link PromptIo} (each pops its next answer; `null` on exhaustion). */
function fakeIo(opts: {
	texts?: (string | null)[];
	selects?: (string | null)[];
	passwords?: (string | null)[];
}): PromptIo {
	const texts = [...(opts.texts ?? [])];
	const selects = [...(opts.selects ?? [])];
	const passwords = [...(opts.passwords ?? [])];
	return {
		async select() {
			const v = selects.shift();
			return v === undefined ? null : v;
		},
		async text() {
			const v = texts.shift();
			return v === undefined ? null : v;
		},
		async password() {
			const v = passwords.shift();
			return v === undefined ? null : v;
		},
		async confirm() {
			return null;
		},
		intro() {},
		outro() {},
	};
}

describe("parseRedirectUris", () => {
	it("splits on comma or newline, trims, and drops empties", () => {
		expect(parseRedirectUris("https://a, https://b\n https://c ,,")).toEqual(["https://a", "https://b", "https://c"]);
	});

	it("returns an empty array for a blank value", () => {
		expect(parseRedirectUris("   ")).toEqual([]);
	});
});

describe("clientConfigFromFlags", () => {
	it("defaults to client_credentials when no type is given", () => {
		expect(clientConfigFromFlags({ label: "bot" })).toEqual({ label: "bot", grantTypes: [GRANT_CLIENT_CREDENTIALS] });
	});

	it("builds an auth-code client with redirect URIs + a per-client login", () => {
		const cfg = clientConfigFromFlags({
			label: "web",
			type: "authorization_code",
			redirectUris: "https://a,https://b",
			username: "op",
			password: "pw",
		});
		expect(cfg.grantTypes).toEqual([GRANT_AUTHORIZATION_CODE]);
		expect(cfg.redirectUris).toEqual(["https://a", "https://b"]);
		expect(cfg.username).toBe("op");
		expect(cfg.password).toBe("pw");
	});

	it("ignores an unknown type (falls back to client_credentials)", () => {
		expect(clientConfigFromFlags({ label: "bot", type: "password" }).grantTypes).toEqual([GRANT_CLIENT_CREDENTIALS]);
	});
});

describe("collectClientConfig", () => {
	it("collects a machine (client_credentials) client through the type picker", async () => {
		const cfg = await collectClientConfig(fakeIo({ texts: ["bot"], selects: ["client_credentials"] }));
		expect(cfg).toEqual({ label: "bot", grantTypes: [GRANT_CLIENT_CREDENTIALS] });
	});

	it("returns null when the label prompt is cancelled", async () => {
		expect(await collectClientConfig(fakeIo({ texts: [null] }))).toBeNull();
	});

	it("returns null when the type picker is cancelled", async () => {
		expect(await collectClientConfig(fakeIo({ texts: ["bot"], selects: [null] }))).toBeNull();
	});

	it("collects a login (authorization_code) client: URIs + per-client login (the CLI flags' twin)", async () => {
		const cfg = await collectClientConfig(
			fakeIo({
				texts: ["web", "https://a, https://b", "op"],
				selects: ["authorization_code"],
				passwords: ["pw"],
			}),
		);
		expect(cfg).toEqual({
			label: "web",
			grantTypes: [GRANT_AUTHORIZATION_CODE],
			redirectUris: ["https://a", "https://b"],
			username: "op",
			password: "pw",
		});
	});

	it("a login client with blank URIs and a blank username omits both", async () => {
		const cfg = await collectClientConfig(fakeIo({ texts: ["web", "  ", "  "], selects: ["authorization_code"] }));
		expect(cfg).toEqual({ label: "web", grantTypes: [GRANT_AUTHORIZATION_CODE] });
	});

	it("a login username with an empty password keeps the username, drops the password", async () => {
		const cfg = await collectClientConfig(
			fakeIo({ texts: ["web", "https://a", "op"], selects: ["authorization_code"], passwords: [""] }),
		);
		expect(cfg).toEqual({
			label: "web",
			grantTypes: [GRANT_AUTHORIZATION_CODE],
			redirectUris: ["https://a"],
			username: "op",
		});
	});

	it("a cancel at the URIs / username / password prompts aborts the whole flow", async () => {
		expect(await collectClientConfig(fakeIo({ texts: ["web", null], selects: ["authorization_code"] }))).toBeNull();
		expect(
			await collectClientConfig(fakeIo({ texts: ["web", "https://a", null], selects: ["authorization_code"] })),
		).toBeNull();
		expect(
			await collectClientConfig(
				fakeIo({ texts: ["web", "https://a", "op"], selects: ["authorization_code"], passwords: [null] }),
			),
		).toBeNull();
	});
});
