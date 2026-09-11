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
import { loadSecrets, type SecretFileMapping, type SecretsStore, saveSecrets } from "../../vm/provision/secrets.ts";
import { resolveVmDirs, type VmDirs } from "../../vm/session.ts";
import { BANNER } from "../banner.ts";
import type { WizardIo } from "../wizard.ts";
import {
	envKeyLine,
	envPairError,
	envSummary,
	fileMappingError,
	fileSummary,
	goldenWarningMessage,
	guestConfigFromAnswers,
	guestSetupFields,
	parseBootCommands,
	parsePackageList,
	runGuestSetup,
	runSecretsSetup,
	SECRETS_EDIT_CHOICE,
	SECRETS_LIVE_HINT,
	SECRETS_RESTART_CHOICE,
	secretsModelLines,
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

// ---- tier (b): the secrets editor (spec 28, box 28f) -----------------------------

/** A seeded secret VALUE — the grep test's canary: it may exist only in the store file, never in any rendered string. */
const CANARY_VALUE = "s3cr3t-Value-42-do-not-render";
const HOST_A = "/home/me/credentials.json";
const GUEST_A = "/home/sandbox/.claude/credentials.json";
/** The seeded store the masking + round-trip tests read (mirrors 26a's shapes). */
const seededStore: SecretsStore = {
	env: { API_KEY: CANARY_VALUE, DB_PASS: CANARY_VALUE },
	files: [{ hostPath: HOST_A, guestPath: GUEST_A }],
};

/** One recorded prompt: its kind, its message, and every string a select rendered (labels + hints) — the grep surface. */
interface PromptCall {
	kind: "select" | "text" | "password" | "confirm";
	message: string;
	rendered: string[];
}

/** One scripted answer: applied to the first prompt whose message contains `match` (the editor's menu repeats, so answers are match-keyed, not position-keyed). */
interface ScriptedAnswer {
	match: string;
	answer: string | boolean;
}

/**
 * A scripted io for the secrets flow's LOOPED prompts (the tier-(a) fake's
 * per-kind queues can't express a repeating menu). Each call is RECORDED (kind +
 * message + rendered option labels/hints — exactly what the masking test greps)
 * and answered from the script; an unmatched prompt resolves to `null` (cancel),
 * so an unexpected prompt fails the flow loudly at its assertions.
 */
function scriptedIo(script: ScriptedAnswer[]): WizardIo & { calls: PromptCall[] } {
	const queue = [...script];
	const calls: PromptCall[] = [];
	const respond = (call: PromptCall): string | boolean | null => {
		const index = queue.findIndex((e) => call.message.includes(e.match));
		if (index === -1) return null;
		const entry = queue[index];
		queue.splice(index, 1);
		return entry.answer;
	};
	return {
		calls,
		async select(o) {
			const call: PromptCall = {
				kind: "select",
				message: o.message,
				rendered: o.options.flatMap((x) => [x.label ?? x.value, x.hint ?? ""]),
			};
			calls.push(call);
			const a = respond(call);
			return typeof a === "string" ? a : null;
		},
		async text(o) {
			const call: PromptCall = { kind: "text", message: o.message, rendered: [] };
			calls.push(call);
			const a = respond(call);
			return typeof a === "string" ? a : null;
		},
		async password(o) {
			const call: PromptCall = { kind: "password", message: o.message, rendered: [] };
			calls.push(call);
			const a = respond(call);
			return typeof a === "string" ? a : null;
		},
		async confirm(o) {
			const call: PromptCall = { kind: "confirm", message: o.message, rendered: [] };
			calls.push(call);
			const a = respond(call);
			return typeof a === "boolean" ? a : null;
		},
		intro() {},
		outro() {},
	};
}

/** Every string the io surfaced for a call — messages plus each select's rendered labels/hints. */
function surfacedStrings(calls: PromptCall[]): string[] {
	return calls.flatMap((c) => [c.message, ...c.rendered]);
}

describe("secrets model — the masked render (spec 28, box 28f)", () => {
	const always = (): boolean => true;

	it("renders keys + set states and NEVER a stored value (the grep test, model half)", () => {
		const lines = secretsModelLines(seededStore, always);
		const joined = lines.join("\n");
		expect(joined).toContain("API_KEY");
		expect(joined).toContain("DB_PASS");
		expect(joined).toContain("— set");
		for (const line of lines) expect(line).not.toContain(CANARY_VALUE);
	});

	it("renders host→guest rows; a missing host file gets the soft note (rendered, never blocking)", () => {
		const files: SecretFileMapping[] = [
			{ hostPath: "/present.pem", guestPath: "/g/a" },
			{ hostPath: "/absent.pem", guestPath: "/g/b" },
		];
		const lines = secretsModelLines({ env: {}, files }, (p) => p === "/present.pem");
		expect(lines).toContain("/present.pem → /g/a");
		expect(lines).toContain("/absent.pem → /g/b (file missing on host)");
	});

	it("an empty store renders the none states", () => {
		expect(secretsModelLines({ env: {}, files: [] }, always)).toEqual(["env: none set", "files: none mapped"]);
	});

	it("the one-line summaries count without values", () => {
		expect(envSummary({})).toBe("none set");
		expect(envSummary({ A: "x" })).toBe("1 set (value hidden)");
		expect(envSummary({ A: "x", B: "y" })).toBe("2 set (values hidden)");
		expect(fileSummary([], always)).toBe("none mapped");
		expect(fileSummary([{ hostPath: "/a", guestPath: "/g" }], always)).toBe("1 mapped");
		expect(fileSummary([{ hostPath: "/a", guestPath: "/g" }], () => false)).toBe("1 mapped — 1 missing on host");
	});
});

describe("envPairError / fileMappingError — the 26a grammar surfaced (secrets.ts untouched)", () => {
	it("a bad key names the grammar rule", () => {
		expect(envPairError("bad-key", "v")).toBe(
			'"bad-key" is not a valid env key — use uppercase letters, digits, and underscores, starting with a letter or underscore',
		);
		expect(envPairError("1BAD", "v")).not.toBeNull();
		expect(envPairError("", "v")).not.toBeNull();
		expect(envPairError("GOOD_KEY_2", "v")).toBeNull();
	});

	it("a newline/NUL value names the line-based rule", () => {
		expect(envPairError("KEY", "a\nb")).toBe(
			"the value for KEY contains a newline or NUL — env values are single lines",
		);
		expect(envPairError("KEY", "a\rb")).not.toBeNull();
		expect(envPairError("KEY", "a\0b")).not.toBeNull();
		expect(envPairError("KEY", "a=b with spaces")).toBeNull(); // '=' and spaces are legal in a value
	});

	it("relative paths and control characters are rejected; absolute ones pass", () => {
		expect(fileMappingError("home/me/pem", "/g/a", [])).toBe(
			'"home/me/pem" is not an absolute path — it must start with "/" and hold no newline or NUL',
		);
		expect(fileMappingError("/h/a", "~/.claude/x", [])).not.toBeNull(); // ~ is not resolved — absolute only
		expect(fileMappingError("/h/a\nb", "/g/a", [])).not.toBeNull();
		expect(fileMappingError("/h/a", "/g/a", [])).toBeNull();
	});

	it("a duplicate guestPath names the 26a rejection (the consumption-side clobber)", () => {
		const existing: SecretFileMapping[] = [{ hostPath: "/h/one", guestPath: "/g/dup" }];
		expect(fileMappingError("/h/two", "/g/dup", existing)).toBe(
			'"/g/dup" is already mapped — each guest path may be used once',
		);
		expect(fileMappingError("/h/two", "/g/other", existing)).toBeNull();
	});
});

describe("runSecretsSetup — the flow (temp HOME, scripted io)", () => {
	it("adds an env pair + a file mapping and saves a store loadSecrets reads back identically", async () => {
		await withTempDirs(async (dirs) => {
			const { stream, written } = fakeStream();
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "add-env" },
				{ match: "Env key", answer: "TOKEN" },
				{ match: "Value for TOKEN", answer: CANARY_VALUE },
				{ match: "Secrets editor", answer: "add-file" },
				{ match: "host path", answer: HOST_A },
				{ match: "guest target", answer: GUEST_A },
				{ match: "Secrets editor", answer: "save" },
			]);

			const result = await runSecretsSetup({ dirs, io, stream });

			const expected: SecretsStore = {
				env: { TOKEN: CANARY_VALUE },
				files: [{ hostPath: HOST_A, guestPath: GUEST_A }],
			};
			expect(result).toEqual({ ok: true, value: expected });
			// The round-trip IS the contract: the store on disk loads back the same shape.
			expect(loadSecrets(dirs)).toEqual(expected);
			// One banner, from withSession — nothing else wrote to the stream.
			expect(written()).toBe(`${BANNER}\n`);
		});
	});

	it("a seeded store round-trips untouched through open → save (values preserved, never rendered)", async () => {
		await withTempDirs(async (dirs) => {
			saveSecrets(dirs, seededStore);
			const io = scriptedIo([{ match: "Secrets editor", answer: "save" }]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toEqual({ ok: true, value: seededStore });
			expect(loadSecrets(dirs)).toEqual(seededStore);
			// The values flowed through the working copy to the writer — and through NO
			// rendered string (messages + option labels/hints).
			for (const s of surfacedStrings(io.calls)) expect(s).not.toContain(CANARY_VALUE);
		});
	});

	it("THE GREP TEST: a full editing session's every rendered string lacks the seeded values; keys render", async () => {
		await withTempDirs(async (dirs) => {
			saveSecrets(dirs, seededStore);
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "remove-env" },
				{ match: "Remove which env pair?", answer: "API_KEY" },
				{ match: "Remove env pair API_KEY?", answer: false }, // decline — keep the pair
				{ match: "Secrets editor", answer: "save" },
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toEqual({ ok: true, value: seededStore }); // declined removal + save = unchanged
			// Keys DO render (masked "set" state); the values behind them never do.
			const surfaced = surfacedStrings(io.calls);
			expect(surfaced.some((s) => s.includes(envKeyLine("API_KEY")))).toBe(true);
			expect(surfaced.some((s) => s.includes(envKeyLine("DB_PASS")))).toBe(true);
			for (const s of surfaced) expect(s).not.toContain(CANARY_VALUE);
			// The model half of the same discipline (the canonical render the menu derives from).
			for (const line of secretsModelLines(seededStore, () => true)) expect(line).not.toContain(CANARY_VALUE);
		});
	});

	it("removes an env pair via select + confirm", async () => {
		await withTempDirs(async (dirs) => {
			saveSecrets(dirs, seededStore);
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "remove-env" },
				{ match: "Remove which env pair?", answer: "API_KEY" },
				{ match: "Remove env pair API_KEY?", answer: true },
				{ match: "Secrets editor", answer: "save" },
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toMatchObject({ ok: true, value: { env: { DB_PASS: CANARY_VALUE } } });
			expect(loadSecrets(dirs).env).toEqual({ DB_PASS: CANARY_VALUE });
		});
	});

	it("removes a file mapping via select + confirm", async () => {
		await withTempDirs(async (dirs) => {
			saveSecrets(dirs, seededStore);
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "remove-file" },
				{ match: "Remove which credential file?", answer: "0" },
				{ match: "Remove credential file", answer: true },
				{ match: "Secrets editor", answer: "save" },
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toMatchObject({ ok: true, value: { env: seededStore.env, files: [] } });
			expect(loadSecrets(dirs).files).toEqual([]);
		});
	});

	it("an invalid key surfaces the exact 26a rejection and writes nothing", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "add-env" },
				{ match: "Env key", answer: "bad-key" },
				{ match: "Value for", answer: "v" },
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toMatchObject({ ok: false, error: new Error(envPairError("bad-key", "v") ?? "") });
			expect(existsSync(join(dirs.secrets, "env"))).toBe(false);
			expect(loadSecrets(dirs)).toEqual({ env: {}, files: [] });
		});
	});

	it("a newline value surfaces the exact 26a rejection and writes nothing", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "add-env" },
				{ match: "Env key", answer: "GOOD_KEY" },
				{ match: "Value for", answer: "line one\nline two" },
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toMatchObject({
				ok: false,
				error: new Error(envPairError("GOOD_KEY", "line one\nline two") ?? ""),
			});
			expect(existsSync(join(dirs.secrets, "env"))).toBe(false);
		});
	});

	it("a duplicate guestPath surfaces the exact 26a rejection and writes nothing", async () => {
		await withTempDirs(async (dirs) => {
			saveSecrets(dirs, seededStore);
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "add-file" },
				{ match: "host path", answer: "/home/me/other.pem" },
				{ match: "guest target", answer: GUEST_A }, // already mapped by the seed
			]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result).toMatchObject({
				ok: false,
				error: new Error(
					'"/home/sandbox/.claude/credentials.json" is already mapped — each guest path may be used once',
				),
			});
			expect(loadSecrets(dirs).files).toEqual(seededStore.files); // unchanged — nothing written
		});
	});

	it("a cancel at the menu (or any sub-prompt) leaves nothing written", async () => {
		await withTempDirs(async (dirs) => {
			const menuCancel = scriptedIo([{ match: "Secrets editor", answer: "cancel" }]);
			expect(await runSecretsSetup({ dirs, io: menuCancel })).toBeNull();
			// The next cancel happens mid-add: the key prompt is unscripted → null.
			const subCancel = scriptedIo([{ match: "Secrets editor", answer: "add-env" }]);
			expect(await runSecretsSetup({ dirs, io: subCancel })).toBeNull();
			expect(loadSecrets(dirs)).toEqual({ env: {}, files: [] });
			expect(existsSync(join(dirs.secrets, "env"))).toBe(false);
		});
	});

	it("a missing host file renders the soft note in the flow and stays savable", async () => {
		await withTempDirs(async (dirs) => {
			const mapping: SecretFileMapping[] = [{ hostPath: "/absent-on-host.pem", guestPath: "/g/x" }];
			saveSecrets(dirs, { env: {}, files: mapping });
			const io = scriptedIo([
				{ match: "Secrets editor", answer: "remove-file" }, // open the removal list just to render its labels
				{ match: "Remove which credential file?", answer: "0" },
				{ match: "Remove credential file", answer: false }, // decline — keep the mapping
				{ match: "Secrets editor", answer: "save" },
			]);

			const result = await runSecretsSetup({ dirs, io, hostFileExists: () => false });

			expect(result?.ok).toBe(true);
			const removeCall = io.calls.find((c) => c.message.includes("Remove which credential file?"));
			expect(removeCall?.rendered.some((r) => r.includes("(file missing on host)"))).toBe(true);
			expect(loadSecrets(dirs).files).toEqual(mapping); // the soft note never blocked the save
		});
	});

	it("a save failure converts to err (the store's throwing boundary, surfaced inline)", async () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-secrets-fail-"));
		try {
			// A regular file where the vm root should mkdir — saveSecrets throws ENOTDIR.
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
			const io = scriptedIo([{ match: "Secrets editor", answer: "save" }]);

			const result = await runSecretsSetup({ dirs, io });

			expect(result?.ok).toBe(false);
			if (result === null || result.ok) return; // narrowed to the err case
			expect(result.error.message.startsWith("cannot save the secrets:")).toBe(true);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("runSecretsSetup — the row-6 interstitial (spec 28, matrix row 6)", () => {
	it("a live session PRECEDES the editor with the hint; the shortcut invokes the injected 28b action, then the editor opens", async () => {
		await withTempDirs(async (dirs) => {
			const restarts: number[] = [];
			const io = scriptedIo([
				{ match: SECRETS_LIVE_HINT, answer: "restart" },
				{ match: "Secrets editor", answer: "cancel" },
			]);

			const result = await runSecretsSetup({
				dirs,
				io,
				sessionActive: () => true, // 28d's vmSessionActive, injected
				restartSandbox: async () => {
					restarts.push(1);
					return { ok: true, value: undefined };
				},
			});

			expect(result).toBeNull(); // the editor was cancelled after the restart — still nothing written
			expect(restarts).toEqual([1]); // the injected action ran — the wired 28b action, reused (not duplicated)
			expect(io.calls[0]?.message).toBe(SECRETS_LIVE_HINT); // the interstitial PRECEDES everything
			expect(io.calls[0]?.rendered).toContain(SECRETS_EDIT_CHOICE);
			expect(io.calls[0]?.rendered).toContain(SECRETS_RESTART_CHOICE);
			expect(io.calls[1]?.message.startsWith("Secrets editor")).toBe(true); // then the editor
		});
	});

	it("choosing Edit skips the restart action entirely", async () => {
		await withTempDirs(async (dirs) => {
			const restarts: number[] = [];
			const io = scriptedIo([
				{ match: SECRETS_LIVE_HINT, answer: "edit" },
				{ match: "Secrets editor", answer: "cancel" },
			]);

			await runSecretsSetup({
				dirs,
				io,
				sessionActive: () => true,
				restartSandbox: async () => {
					restarts.push(1);
					return { ok: true, value: undefined };
				},
			});

			expect(restarts).toEqual([]); // no restart — the hint alone carried the row-6 semantics
			expect(io.calls[0]?.message).toBe(SECRETS_LIVE_HINT);
		});
	});

	it("a failed restart surfaces the action's err inline; the editor never opens", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([{ match: SECRETS_LIVE_HINT, answer: "restart" }]);

			const result = await runSecretsSetup({
				dirs,
				io,
				sessionActive: () => true,
				restartSandbox: async () => ({ ok: false, error: new Error("unowned hint") }),
			});

			expect(result).toEqual({ ok: false, error: new Error("unowned hint") }); // the action's hint, surfaced
			expect(io.calls).toHaveLength(1); // only the interstitial — never a silent fall-through
		});
	});

	it("an unwired restart shortcut errs — never a silent no-op", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([{ match: SECRETS_LIVE_HINT, answer: "restart" }]);

			const result = await runSecretsSetup({ dirs, io, sessionActive: () => true });

			expect(result).toEqual({ ok: false, error: new Error("no sandbox restart action is wired here") });
		});
	});

	it("no live session → no interstitial: the first prompt is the editor menu", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([{ match: "Secrets editor", answer: "cancel" }]);

			await runSecretsSetup({ dirs, io }); // no sessionActive dep — the default no-live posture

			expect(io.calls[0]?.message.startsWith("Secrets editor")).toBe(true);
			expect(io.calls.some((c) => c.message === SECRETS_LIVE_HINT)).toBe(false);
		});
	});
});
