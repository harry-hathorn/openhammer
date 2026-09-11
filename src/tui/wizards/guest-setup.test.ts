import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	defaultGuestConfig,
	GUEST_AGENTS,
	type GuestConfig,
	guestConfigPath,
	loadGuestConfig,
	saveGuestConfig,
} from "../../vm/provision/guest-config.ts";
import { resolveVmDirs, type VmDirs } from "../../vm/session.ts";
import { BANNER } from "../banner.ts";
import type { WizardIo } from "../wizard.ts";
import {
	goldenWarningMessage,
	guestConfigFromAnswers,
	guestSetupFields,
	parseBootCommands,
	parsePackageList,
	runGuestSetup,
} from "./guest-setup.ts";

/** A fresh HOME per test — resolveVmDirs({homeDir}) roots the whole vm tree inside it; nothing real is touched. */
async function withTempDirs(fn: (dirs: VmDirs) => void | Promise<void>): Promise<void> {
	const home = mkdtempSync(join(tmpdir(), "openhammer-guest-setup-"));
	try {
		await fn(resolveVmDirs({ homeDir: home }));
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** A fully-populated valid config (mirrors guest-config.test.ts's fixture — every field non-default). */
const fullConfig: GuestConfig = {
	hostname: "build-box",
	timezone: "Europe/Berlin",
	keyboard: "de-latin1",
	username: "builder",
	gitName: "Harry Hathorn",
	gitEmail: "harry@example.invalid",
	encrypt: true,
	agent: "codex",
	extraPackages: ["ripgrep", "fd", "base-devel"],
	bootCommands: ["systemctl --user enable syncthing", "echo provisioned"],
};

/**
 * A recording fake {@link WizardIo} — no TTY. Each primitive shifts its next answer
 * from a per-kind queue (`null` simulates cancel) and records `<kind>:<message>` so
 * tests pin WHICH prompt ran and in what order (the section.test.ts shape, plus the
 * call log the warning/order assertions need).
 */
function fakeIo(returns: {
	select?: (string | null)[];
	text?: (string | null)[];
	confirm?: (boolean | null)[];
}): WizardIo & { calls: string[] } {
	const calls: string[] = [];
	const take = <T>(arr: T[] | undefined): T | null => {
		if (!arr || arr.length === 0) return null;
		const v = arr.shift();
		return v === undefined ? null : v;
	};
	return {
		calls,
		async select(opts) {
			calls.push(`select:${opts.message}`);
			return take(returns.select);
		},
		async text(opts) {
			calls.push(`text:${opts.message}`);
			return take(returns.text);
		},
		async password() {
			return null;
		},
		async confirm(opts) {
			calls.push(`confirm:${opts.message}`);
			return take(returns.confirm);
		},
		intro() {},
		outro() {},
	};
}

/** A recording BannerStream — captures bytes exactly like banner.test.ts / section.test.ts. */
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

/**
 * The field answers the wizard walks, in declaration order (six identity texts, then
 * encrypt/agent, then the two lists) — a FACTORY: the fake io consumes its queues by
 * `shift`, so each test needs its own fresh arrays (a shared literal would be emptied
 * by the first consumer and silently cancel every later flow).
 */
function fullAnswers(): {
	text: (string | null)[];
	confirm: (boolean | null)[];
	select: (string | null)[];
} {
	return {
		text: [
			"build-box",
			"Europe/Berlin",
			"de-latin1",
			"builder",
			"Harry Hathorn",
			"harry@example.invalid",
			"ripgrep, fd, base-devel",
			"systemctl --user enable syncthing\necho provisioned",
		],
		confirm: [true],
		select: ["codex"],
	};
}

describe("guestSetupFields — shape + seeds", () => {
	it("declares the tier-(a) keys in spec order with only the existing four kinds", () => {
		const fields = guestSetupFields(defaultGuestConfig());
		expect(fields.map((f) => f.key)).toEqual([
			"hostname",
			"timezone",
			"keyboard",
			"username",
			"gitName",
			"gitEmail",
			"encrypt",
			"agent",
			"extraPackages",
			"bootCommands",
		]);
		expect(fields.map((f) => f.kind)).toEqual([
			"text",
			"text",
			"text",
			"text",
			"text",
			"text",
			"confirm",
			"select",
			"text",
			"text",
		]);
	});

	it("the agent select offers the 13 GUEST_AGENTS in order, values = labels", () => {
		const agent = guestSetupFields(defaultGuestConfig()).find((f) => f.key === "agent");
		expect(agent?.kind).toBe("select");
		if (agent?.kind !== "select") return; // narrowed above — unreachable
		expect(agent.options.map((o) => o.value)).toEqual([...GUEST_AGENTS]);
		expect(agent.options.map((o) => o.value)).toEqual([
			"claude",
			"codex",
			"opencode",
			"agy",
			"copilot",
			"crush",
			"grok",
			"pi",
			"omp",
			"ori",
			"hermes",
			"muse",
			"cursor-agent",
		]);
		expect(agent.options.every((o) => o.label === o.value)).toBe(true);
	});

	it("seeds from the 26a defaults", () => {
		const byKey = Object.fromEntries(guestSetupFields(defaultGuestConfig()).map((f) => [f.key, f]));
		expect(byKey.hostname).toMatchObject({ kind: "text", default: "omarchy-sandbox" });
		expect(byKey.timezone).toMatchObject({ default: "UTC" });
		expect(byKey.keyboard).toMatchObject({ default: "us" });
		expect(byKey.username).toMatchObject({ default: "sandbox" });
		expect(byKey.gitName).toMatchObject({ default: "OpenHammer Sandbox" });
		expect(byKey.gitEmail).toMatchObject({ default: "sandbox@openhammer.local" });
		expect(byKey.encrypt).toMatchObject({ kind: "confirm", default: false });
		expect(byKey.agent).toMatchObject({ default: "claude" });
		expect(byKey.extraPackages).toMatchObject({ default: "" }); // blank = none
		expect(byKey.bootCommands).toMatchObject({ default: "" }); // blank = none
	});

	it("seeds from a populated doc: lists join for display, encrypt carries the boolean", () => {
		const byKey = Object.fromEntries(guestSetupFields(fullConfig).map((f) => [f.key, f]));
		expect(byKey.encrypt).toMatchObject({ default: true });
		expect(byKey.agent).toMatchObject({ default: "codex" });
		expect(byKey.extraPackages).toMatchObject({ default: "ripgrep, fd, base-devel" });
		expect(byKey.bootCommands).toMatchObject({ default: "systemctl --user enable syncthing\necho provisioned" });
	});
});

describe("parsePackageList — the pinned parse", () => {
	it("splits on commas and trims surrounding spaces", () => {
		expect(parsePackageList(" ripgrep ,  fd ")).toEqual(["ripgrep", "fd"]);
	});

	it("drops empty tokens (blank = none, and 'a,,b' keeps both)", () => {
		expect(parsePackageList("")).toEqual([]);
		expect(parsePackageList(",")).toEqual([]);
		expect(parsePackageList("a,,b")).toEqual(["a", "b"]);
	});

	it("deduplicates, first occurrence order kept", () => {
		expect(parsePackageList("fd, ripgrep, fd")).toEqual(["fd", "ripgrep"]);
	});

	it("round-trips a valid doc's list exactly (valid tokens hold no comma/space)", () => {
		expect(parsePackageList(fullConfig.extraPackages.join(", "))).toEqual([...fullConfig.extraPackages]);
	});
});

describe("parseBootCommands — the pinned parse", () => {
	it("splits on newlines and trims each line", () => {
		expect(parseBootCommands("a\nb")).toEqual(["a", "b"]);
		expect(parseBootCommands("  systemctl enable sshd  \n  echo hi ")).toEqual(["systemctl enable sshd", "echo hi"]);
	});

	it("drops blank lines (blank = none; interior blanks are separators, not commands)", () => {
		expect(parseBootCommands("")).toEqual([]);
		expect(parseBootCommands("\n\n")).toEqual([]);
		expect(parseBootCommands("a\n\n b \n")).toEqual(["a", "b"]);
	});

	it("does NOT deduplicate — the lines run in order and a repeat can be intentional", () => {
		expect(parseBootCommands("sleep 5\nsleep 5")).toEqual(["sleep 5", "sleep 5"]);
	});
});

describe("guestConfigFromAnswers — answers → config through the real normalize", () => {
	it("reduces a full answer set over the defaults to the target config", () => {
		const answers: Record<string, string> = {
			hostname: "build-box",
			timezone: "Europe/Berlin",
			keyboard: "de-latin1",
			username: "builder",
			gitName: "Harry Hathorn",
			gitEmail: "harry@example.invalid",
			encrypt: "true",
			agent: "codex",
			extraPackages: "ripgrep, fd, base-devel",
			bootCommands: "systemctl --user enable syncthing\necho provisioned",
		};
		const result = guestConfigFromAnswers(defaultGuestConfig(), answers);
		expect(result).toEqual({ ok: true, value: fullConfig });
	});

	it("missing keys fall back to the seed (the graceful missing-key contract)", () => {
		const result = guestConfigFromAnswers(fullConfig, {});
		expect(result).toEqual({ ok: true, value: fullConfig });
	});

	it("coerces the confirm string; a missing encrypt keeps the seed's boolean", () => {
		const seedAnswers: Record<string, string> = {
			hostname: "build-box",
			timezone: "Europe/Berlin",
			keyboard: "de-latin1",
			username: "builder",
			gitName: "Harry Hathorn",
			gitEmail: "harry@example.invalid",
			agent: "codex",
			extraPackages: "ripgrep, fd, base-devel",
			bootCommands: "systemctl --user enable syncthing\necho provisioned",
		};
		const flipped = guestConfigFromAnswers(fullConfig, { ...seedAnswers, encrypt: "false" });
		expect(flipped).toMatchObject({ ok: true, value: { encrypt: false } });
		const kept = guestConfigFromAnswers(fullConfig, seedAnswers); // no encrypt key → seed's true
		expect(kept).toEqual({ ok: true, value: fullConfig });
	});

	it("an out-of-set agent errs with the vmSelectValue voice (non-interactive answers only)", () => {
		const result = guestConfigFromAnswers(defaultGuestConfig(), { agent: "not-an-agent" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toBe(`agent must be one of ${GUEST_AGENTS.join(", ")} (got "not-an-agent")`);
	});

	it("localizes a broken hostname through the real normalize", () => {
		const result = guestConfigFromAnswers(defaultGuestConfig(), { hostname: "my host" });
		expect(result).toMatchObject({
			ok: false,
			error: new Error('hostname "my host" is not a valid host label (letters, digits, hyphens)'),
		});
	});

	it("localizes timezone, keyboard, and username the same way", () => {
		expect(guestConfigFromAnswers(defaultGuestConfig(), { timezone: "America/New York" })).toMatchObject({
			ok: false,
			error: new Error('timezone "America/New York" is not a valid timezone token (e.g. UTC, America/New_York)'),
		});
		expect(guestConfigFromAnswers(defaultGuestConfig(), { keyboard: "us layout" })).toMatchObject({
			ok: false,
			error: new Error('keyboard "us layout" is not a valid layout token (e.g. us, de-latin1)'),
		});
		expect(guestConfigFromAnswers(defaultGuestConfig(), { username: "san dbox" })).toMatchObject({
			ok: false,
			error: new Error('username "san dbox" is not a valid user name (letters, digits, hyphens)'),
		});
	});

	it("names the exact offending package token", () => {
		const result = guestConfigFromAnswers(defaultGuestConfig(), { extraPackages: "ripgrep, ri pgrep" });
		expect(result).toMatchObject({
			ok: false,
			error: new Error('extra packages: "ri pgrep" is not a valid package name'),
		});
	});

	it("unchanged fields never trip the probes — only the edited field is blamed", () => {
		// hostname keeps the seed's valid value (empty answer → default); timezone is broken.
		const result = guestConfigFromAnswers(fullConfig, { timezone: "not valid!" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.message).toContain("timezone");
		expect(result.error.message).not.toContain("hostname");
	});
});

describe("runGuestSetup — the flow (temp HOME, injected probe)", () => {
	it("no golden: runs the fields in declaration order and saves a doc the loader accepts unchanged", async () => {
		await withTempDirs(async (dirs) => {
			const { stream, written } = fakeStream();
			const io = fakeIo(fullAnswers());

			const result = await runGuestSetup({ dirs, io, stream, goldenId: () => null });

			expect(result).toEqual({ ok: true, value: fullConfig });
			// The round-trip IS the contract: the doc on disk loads back as the same config.
			expect(loadGuestConfig(dirs)).toEqual(fullConfig);
			// The field phase walked in declaration order (texts, confirm, agent select, lists).
			expect(io.calls).toEqual([
				"text:Hostname",
				"text:Timezone",
				"text:Keyboard layout",
				"text:Username",
				"text:Git name",
				"text:Git email",
				"confirm:Encrypt the disk (LUKS)?",
				"select:Default agent",
				"text:Extra packages",
				"text:Boot-with commands",
			]);
			// One banner, from runWizard's withSession — nothing else wrote to the stream.
			expect(written()).toBe(`${BANNER}\n`);
		});
	});

	it("seeds from a seeded guest.json: all-empty answers + the seeded agent round-trip the doc", async () => {
		await withTempDirs(async (dirs) => {
			saveGuestConfig(dirs, fullConfig);
			const io = fakeIo({
				text: ["", "", "", "", "", "", "", ""], // every text keeps its seed
				confirm: [true], // encrypt confirm — the seeded true arrives as the initialValue
				select: [fullConfig.agent], // the select keeps the seeded agent
			});

			const result = await runGuestSetup({ dirs, io, goldenId: () => null });

			expect(result).toEqual({ ok: true, value: fullConfig });
			expect(loadGuestConfig(dirs)).toEqual(fullConfig);
		});
	});

	it("post-golden: the warning confirm PRECEDES the fields with the exact message; declining writes nothing", async () => {
		await withTempDirs(async (dirs) => {
			const io = fakeIo({ confirm: [false] }); // decline the warning

			const result = await runGuestSetup({ dirs, io, goldenId: () => "golden-20260911-010203" });

			expect(result).toBeNull(); // declined — silent
			expect(existsSync(guestConfigPath(dirs))).toBe(false); // no write
			expect(io.calls).toEqual([`confirm:${goldenWarningMessage("golden-20260911-010203")}`]); // precedes: NO field prompt ran
		});
	});

	it("post-golden accepted: the exact spec warning ran, then the flow saved normally", async () => {
		await withTempDirs(async (dirs) => {
			const io = fakeIo({ ...fullAnswers(), confirm: [true, true] }); // warning confirm, then encrypt

			const result = await runGuestSetup({ dirs, io, goldenId: () => "golden-20260911-010203" });

			expect(result).toEqual({ ok: true, value: fullConfig });
			expect(loadGuestConfig(dirs)).toEqual(fullConfig);
			expect(io.calls[0]).toBe(`confirm:${goldenWarningMessage("golden-20260911-010203")}`);
		});
	});

	it("no golden: no warning confirm ever fires (the encrypt confirm is the only one)", async () => {
		await withTempDirs(async (dirs) => {
			const io = fakeIo(fullAnswers());

			await runGuestSetup({ dirs, io, goldenId: () => null });

			expect(io.calls.some((c) => c.startsWith("confirm:a golden image already exists"))).toBe(false);
			expect(io.calls).toContain("confirm:Encrypt the disk (LUKS)?");
		});
	});

	it("a cancelled field writes nothing", async () => {
		await withTempDirs(async (dirs) => {
			const io = fakeIo({ text: [null] }); // cancel on Hostname

			const result = await runGuestSetup({ dirs, io, goldenId: () => null });

			expect(result).toBeNull();
			expect(existsSync(guestConfigPath(dirs))).toBe(false);
		});
	});

	it("an invalid answer surfaces as err and writes nothing (never persist a doc normalize rejects)", async () => {
		await withTempDirs(async (dirs) => {
			const answers = fullAnswers();
			answers.text[0] = "my host"; // only the hostname answer breaks the doc
			const io = fakeIo(answers);

			const result = await runGuestSetup({ dirs, io, goldenId: () => null });

			expect(result).toMatchObject({
				ok: false,
				error: { message: 'hostname "my host" is not a valid host label (letters, digits, hyphens)' },
			});
			expect(existsSync(guestConfigPath(dirs))).toBe(false);
		});
	});

	it("a write failure converts to err (the store's throwing boundary, surfaced inline)", async () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-guest-setup-fail-"));
		try {
			// A regular file where the vm root should mkdir — saveGuestConfig throws ENOTDIR.
			const blocker = join(home, "blocker");
			writeFileSync(blocker, "x");
			const root = join(blocker, "vm");
			const dirs: VmDirs = {
				root,
				sessions: join(root, "sessions"),
				images: join(root, "images"),
				isos: join(root, "isos"),
				cidata: join(root, "cidata"),
				secrets: join(root, "secrets"),
			};
			const io = fakeIo(fullAnswers());

			const result = await runGuestSetup({ dirs, io, goldenId: () => null });

			expect(result?.ok).toBe(false);
			if (result === null || result.ok) return; // narrowed to the err case
			expect(result.error.message.startsWith("cannot save the guest config:")).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
