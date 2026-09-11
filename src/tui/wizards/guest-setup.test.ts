import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { VmStateLine } from "../../observability/status-socket.ts";
import {
	defaultGuestConfig,
	GUEST_AGENTS,
	type GuestConfig,
	guestConfigPath,
	loadGuestConfig,
	saveGuestConfig,
} from "../../vm/provision/guest-config.ts";
import { ISO_SHA256, ISO_URL } from "../../vm/provision/iso.ts";
import { loadSecrets, type SecretFileMapping, type SecretsStore, saveSecrets } from "../../vm/provision/secrets.ts";
import { resolveVmDirs, type VmDirs } from "../../vm/session.ts";
import { remoteQuote, type SshExecResult, type SshTarget, sshExecArgv } from "../../vm/ssh.ts";
import { BANNER } from "../banner.ts";
import type { WizardIo } from "../wizard.ts";
import {
	AGENT_DEFAULTS_ARGV,
	APPLY_TO_RUNNING_HINT,
	applyToRunningReady,
	envKeyLine,
	envPairError,
	envSummary,
	fileMappingError,
	fileSummary,
	goldenWarningMessage,
	guestConfigFromAnswers,
	guestSetupFields,
	newestGoldenGuestUser,
	PROVISION_NO_EDITOR_ERROR,
	parseBootCommands,
	parsePackageList,
	parseThemeList,
	provisionScriptPath,
	provisionTemplate,
	type RunEditor,
	runApplyAgent,
	runApplyTheme,
	runGuestSetup,
	runProvisionEditor,
	runSecretsSetup,
	SECRETS_EDIT_CHOICE,
	SECRETS_LIVE_HINT,
	SECRETS_RESTART_CHOICE,
	secretsModelLines,
	sshTargetForVmLine,
	THEME_LIST_ARGV,
	themeSetRemoteArgv,
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

// ---- tier (c) + apply-to-running (spec 28, box 28g) -------------------------------

/** The first-open template, pinned VERBATIM — header (what it is / whose it is / authoritative) + the two-line example. */
const TEMPLATE = [
	"#!/usr/bin/env bash",
	"# OpenHammer's provision.sh — the operator's escape hatch (specs 26/28).",
	"# Runs as bash IN THE GUEST during `vm provision`, after the base provisioning.",
	"# Operator-authored and authoritative: a non-zero exit FAILS the provision run.",
	"#",
	"# Example:",
	"#   pacman -Sy --noconfirm htop",
	"#   git config --global init.defaultBranch main",
	"",
].join("\n");

describe("runProvisionEditor — the tier-(c) escape hatch (spec 28, box 28g)", () => {
	it("first open creates the file from the commented template (content pinned) and opens $EDITOR on it", async () => {
		await withTempDirs(async (dirs) => {
			expect(provisionTemplate()).toBe(TEMPLATE); // the template itself is the pinned string
			const editorArgv: string[][] = [];
			const runEditor: RunEditor = async (argv) => {
				editorArgv.push([...argv]);
				writeFileSync(argv[1] ?? "", `${TEMPLATE}\necho edited\n`); // the editor "saves an edit"
			};

			const result = await runProvisionEditor({ dirs, env: { EDITOR: "vi" }, runEditor });

			expect(result).toEqual({ ok: true, value: undefined });
			// The file existed BEFORE the editor ran (created from the template), and the
			// editor's save is what's on disk after.
			expect(editorArgv).toEqual([["vi", provisionScriptPath(dirs)]]);
			expect(readFileSync(provisionScriptPath(dirs), "utf8")).toBe(`${TEMPLATE}\necho edited\n`);
			expect(provisionScriptPath(dirs)).toBe(join(dirs.root, "provision.sh")); // provision.ts step (j)'s exact path
		});
	});

	it("second open edits the existing file — the template never overwrites operator content", async () => {
		await withTempDirs(async (dirs) => {
			mkdirSync(dirs.root, { recursive: true, mode: 0o700 }); // the operator's file already exists
			writeFileSync(provisionScriptPath(dirs), "# my own script\n");
			const runEditor: RunEditor = async () => {}; // opened, changed nothing

			const result = await runProvisionEditor({ dirs, env: { EDITOR: "vi" }, runEditor });

			expect(result).toEqual({ ok: true, value: undefined });
			expect(readFileSync(provisionScriptPath(dirs), "utf8")).toBe("# my own script\n");
		});
	});

	it("EDITOR unset errs with the exact actionable message BEFORE anything is written", async () => {
		await withTempDirs(async (dirs) => {
			let ran = false;
			const never: RunEditor = async () => {
				ran = true;
			};
			const result = await runProvisionEditor({ dirs, env: {}, runEditor: never });
			const blank = await runProvisionEditor({ dirs, env: { EDITOR: "   " }, runEditor: async () => {} });

			expect(result).toEqual({ ok: false, error: new Error(PROVISION_NO_EDITOR_ERROR) });
			expect(blank).toEqual({ ok: false, error: new Error(PROVISION_NO_EDITOR_ERROR) });
			expect(existsSync(provisionScriptPath(dirs))).toBe(false); // the gate precedes any write
			expect(ran).toBe(false);
		});
	});

	it("an editor failure surfaces as err naming the editor (the flash renders it inline)", async () => {
		await withTempDirs(async (dirs) => {
			const failed: RunEditor = async () => {
				throw new Error("exited 1");
			};

			const result = await runProvisionEditor({ dirs, env: { EDITOR: "vi" }, runEditor: failed });

			expect(result).toEqual({ ok: false, error: new Error('cannot run $EDITOR ("vi"): exited 1') });
		});
	});
});

/** A vm-state line fixture — the 27h wire shape, ready with a session + port by default. */
function applyLine(over: Partial<VmStateLine> = {}): VmStateLine {
	return {
		type: "vm-state",
		state: "ready",
		sessionId: "vm-20260911T101112Z-ab",
		phase: null,
		sshPort: 42255,
		error: null,
		...over,
	};
}

/** One recorded ssh exec — the fake's assertion surface. */
interface RecordedExec {
	target: SshTarget;
	remoteArgv: readonly string[];
	stdin: string | undefined;
}

/**
 * A scripted ssh exec: records (target, argv, stdin) per call and answers from the
 * script in order (the last entry repeats), the SshExecResult shape. Never touches a
 * real ssh — the argv IS the contract under test.
 */
function fakeSshExec(
	script: Array<{ code: number; stdout?: string; stderr?: string }>,
	calls: RecordedExec[],
): (target: SshTarget, remoteArgv: readonly string[], opts?: { stdin?: string }) => Promise<SshExecResult> {
	let i = 0;
	return async (target, remoteArgv, opts) => {
		calls.push({ target, remoteArgv, stdin: opts?.stdin });
		const next = script[Math.min(i, script.length - 1)] ?? { code: 0 };
		i += 1;
		return { exitCode: next.code, timedOut: false, stdoutTail: next.stdout ?? "", stderrTail: next.stderr ?? "" };
	};
}

describe("apply-to-running — the pure pieces (spec 28, box 28g)", () => {
	it("applyToRunningReady: booting/ready WITH a session id and a discovered port; anything else is not ready", () => {
		expect(applyToRunningReady(applyLine())).toBe(true);
		expect(applyToRunningReady(applyLine({ state: "booting" }))).toBe(true); // the post-discovery booting window
		expect(applyToRunningReady(applyLine({ state: "booting", sshPort: null }))).toBe(false); // port not yet found
		expect(applyToRunningReady(applyLine({ sessionId: null }))).toBe(false);
		expect(applyToRunningReady(applyLine({ state: "stopped" }))).toBe(false);
		expect(applyToRunningReady(applyLine({ state: "failed" }))).toBe(false);
		expect(applyToRunningReady(null)).toBe(false);
	});

	it("sshTargetForVmLine builds the pinned target from the line + the vm tree (loopback, session pin, mux socket)", () => {
		const dirs = resolveVmDirs({ homeDir: "/h" });
		const target = sshTargetForVmLine(dirs, applyLine(), "sandbox");
		expect(target).toEqual({
			ok: true,
			value: {
				user: "sandbox", // the manifest's guestUser — never the host user's name
				host: "127.0.0.1", // loopback-only by TYPE
				port: 42255, // the LIVE port from the vm-state line
				keyPath: join(dirs.root, "id_ed25519"),
				knownHostsPath: join(dirs.sessions, "vm-20260911T101112Z-ab", "known_hosts"), // re-keyed per boot
				controlPath: join(dirs.sessions, "vm-20260911T101112Z-ab", "cm.sock"),
			},
		});
	});

	it("sshTargetForVmLine refuses — no line/port/id, an unsafe id, no guest user — each before any exec", () => {
		const dirs = resolveVmDirs({ homeDir: "/h" });
		expect(sshTargetForVmLine(dirs, null, "sandbox")).toEqual({
			ok: false,
			error: new Error("no ready sandbox session to apply to — boot one first (Configure → set the boot mode)"),
		});
		expect(sshTargetForVmLine(dirs, applyLine({ sshPort: null }), "sandbox")).toMatchObject({ ok: false });
		expect(sshTargetForVmLine(dirs, applyLine({ sessionId: "../escape" }), "sandbox")).toEqual({
			ok: false,
			error: new Error(
				"the vm-state line's session id is not a safe path segment — refusing to address the session tree",
			),
		});
		expect(sshTargetForVmLine(dirs, applyLine(), undefined)).toEqual({
			ok: false,
			error: new Error(
				"cannot resolve the guest user — no readable golden manifest under the vm tree (images/<id>/manifest.json)",
			),
		});
	});

	it("AGENT_DEFAULTS_ARGV is the constant direct-write command; the agent itself never rides it", () => {
		expect([...AGENT_DEFAULTS_ARGV]).toEqual([
			"bash",
			"-c",
			'mkdir -p "$HOME/.config/omarchy/defaults" && cat > "$HOME/.config/omarchy/defaults/agent"',
		]);
		expect([...THEME_LIST_ARGV]).toEqual(["omarchy", "theme", "list"]);
		expect(themeSetRemoteArgv("tokyo night")).toEqual(["omarchy", "theme", "set", "tokyo night"]); // one argument
	});

	it("the spawn-level argv pins the transport (loopback destination, port, pin file, BatchMode, key-only) and remoteQuote's the command", () => {
		const target: SshTarget = {
			user: "sandbox",
			host: "127.0.0.1",
			port: 42255,
			keyPath: "/h/.openhammer/vm/id_ed25519",
			knownHostsPath: "/h/.openhammer/vm/sessions/vm-x/known_hosts",
			controlPath: "/h/.openhammer/vm/sessions/vm-x/cm.sock",
		};
		const argv = sshExecArgv(target, AGENT_DEFAULTS_ARGV);
		expect(argv[0]).toBe("ssh");
		expect(argv).toContain("-p");
		expect(argv).toContain("42255");
		expect(argv).toContain("BatchMode=yes"); // never prompt — unattended
		expect(argv).toContain("StrictHostKeyChecking=yes"); // the pin, enforced
		expect(argv).toContain(`UserKnownHostsFile=${target.knownHostsPath}`); // the session's CURRENT-port pin
		expect(argv).toContain(`IdentityFile=${target.keyPath}`); // key-only
		expect(argv).toContain("IdentitiesOnly=yes");
		expect(argv.at(-2)).toBe("sandbox@127.0.0.1");
		// ONE pre-joined command element, each word remoteQuote'd — the write command
		// arrives verbatim (no host shell string was ever built).
		expect(argv.at(-1)).toBe(AGENT_DEFAULTS_ARGV.map(remoteQuote).join(" "));
	});

	it("parseThemeList takes every non-empty trimmed line", () => {
		expect(parseThemeList("tokyo-night\ncatppuccin\n\n  gruvbox  \r\n")).toEqual([
			"tokyo-night",
			"catppuccin",
			"gruvbox",
		]);
		expect(parseThemeList("  \n")).toEqual([]);
	});

	it("newestGoldenGuestUser: the newest golden manifest's guestUser; absent/corrupt → undefined (never throws)", () => {
		const home = mkdtempSync(join(tmpdir(), "openhammer-apply-user-"));
		try {
			const dirs = resolveVmDirs({ homeDir: home });
			expect(newestGoldenGuestUser(home)).toBeUndefined(); // no golden at all
			const goldenDir = join(dirs.images, "golden-4.0.3-20260911T101112Z");
			mkdirSync(goldenDir, { recursive: true });
			writeFileSync(
				join(goldenDir, "manifest.json"),
				JSON.stringify({
					id: "golden-4.0.3-20260911T101112Z",
					flavor: "base",
					guestUser: "sandbox",
					rootDir: "/home/sandbox",
					isoVersion: "4.0.3",
					isoUrl: ISO_URL,
					isoSha256: ISO_SHA256,
					diskVirtualSizeBytes: 42_949_672_960,
					provisionScriptHashes: null,
					builtAt: "2026-09-11T10:11:12.000Z",
					encrypt: false,
				}),
			);
			expect(newestGoldenGuestUser(home)).toBe("sandbox");
			writeFileSync(join(goldenDir, "manifest.json"), "{ not json");
			expect(newestGoldenGuestUser(home)).toBeUndefined(); // corrupt → the flow's actionable err, never a wrong user
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("runApplyAgent — the DIRECT FILE WRITE (spec 28, box 28g; 22-measured finding 12)", () => {
	it("one ssh exec: the constant write argv, the agent on stdin, the pinned target; the ok report carries the hint", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const exec = fakeSshExec([{ code: 0 }], calls);
			const io = scriptedIo([{ match: "default agent", answer: "codex" }]);

			const result = await runApplyAgent({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: exec,
			});

			// The result text IS the surfaced report — the row-7 hint appended.
			expect(result).toEqual({
				ok: true,
				value: `default agent written to ~/.config/omarchy/defaults/agent (codex) — ${APPLY_TO_RUNNING_HINT}`,
			});
			// The seeded select ran, and NOTHING else.
			expect(io.calls.map((c) => c.message)).toEqual([
				"Set the default agent — written to ~/.config/omarchy/defaults/agent in the guest",
			]);
			// Exactly ONE exec: destination/port/pin from the vm-state line + vm tree.
			expect(calls).toHaveLength(1);
			expect(calls[0]?.target).toEqual({
				user: "sandbox",
				host: "127.0.0.1",
				port: 42255,
				keyPath: join(dirs.root, "id_ed25519"),
				knownHostsPath: join(dirs.sessions, "vm-20260911T101112Z-ab", "known_hosts"),
				controlPath: join(dirs.sessions, "vm-20260911T101112Z-ab", "cm.sock"),
			});
			expect([...(calls[0]?.remoteArgv ?? [])]).toEqual([...AGENT_DEFAULTS_ARGV]);
			expect(calls[0]?.stdin).toBe("codex\n"); // the agent rides stdin — no shell string ever carries it
		});
	});

	it("the select is seeded from the LOCAL guest.json's agent (what the next install bakes)", async () => {
		await withTempDirs(async (dirs) => {
			saveGuestConfig(dirs, fullConfig); // agent: "codex"
			const calls: RecordedExec[] = [];
			let seeded: string | undefined;
			const io = scriptedIo([{ match: "default agent", answer: "codex" }]);
			// Wrap the recorded select to capture the initialValue the flow seeded.
			const wrapped: typeof io = {
				...io,
				async select(o) {
					seeded = o.initialValue;
					return io.select(o);
				},
			};

			await runApplyAgent({
				dirs,
				io: wrapped,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0 }], calls),
			});

			expect(seeded).toBe("codex"); // fullConfig.agent
		});
	});

	it("a cancel at the select is null and the guest is never touched", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const io = scriptedIo([]); // no answers — every prompt cancels

			const result = await runApplyAgent({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0 }], calls),
			});

			expect(result).toBeNull();
			expect(calls).toHaveLength(0);
		});
	});

	it("a failed write surfaces the exit code, the guest's words, and the hint STILL appended", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([{ match: "default agent", answer: "claude" }]);

			const result = await runApplyAgent({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 1, stderr: "bash: permission denied" }], []),
			});

			expect(result).toEqual({
				ok: false,
				error: new Error(
					`writing the default agent failed in the guest (exit 1: bash: permission denied) — ${APPLY_TO_RUNNING_HINT}`,
				),
			});
		});
	});

	it("no ready session errs BEFORE any prompt (the rows are hidden; the flow still refuses)", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([]);
			const calls: RecordedExec[] = [];

			const result = await runApplyAgent({
				dirs,
				io,
				vmLine: null,
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0 }], calls),
			});

			expect(result).toEqual({
				ok: false,
				error: new Error("no ready sandbox session to apply to — boot one first (Configure → set the boot mode)"),
			});
			expect(io.calls).toHaveLength(0); // no prompt ever ran
			expect(calls).toHaveLength(0);
		});
	});
});

describe("runApplyTheme — list, degrade, set (spec 28, box 28g)", () => {
	it("a fetched list offers the select; the chosen theme sets with the exact argv; the report carries the hint", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const io = scriptedIo([{ match: "omarchy theme list", answer: "catppuccin" }]);

			const result = await runApplyTheme({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0, stdout: "tokyo-night\ncatppuccin\n\n  gruvbox  \n" }, { code: 0 }], calls),
			});

			expect(result).toEqual({ ok: true, value: `theme set to catppuccin — ${APPLY_TO_RUNNING_HINT}` });
			// The select offered the guest's own list — trimmed, blanks dropped.
			const selectCall = io.calls.find((c) => c.kind === "select");
			expect(selectCall?.rendered).toContain("tokyo-night");
			expect(selectCall?.rendered).toContain("catppuccin");
			expect(selectCall?.rendered).toContain("gruvbox");
			// TWO execs: the list fetch, then the set (arg array — a spaced theme is ONE argument).
			expect(calls).toHaveLength(2);
			expect([...(calls[0]?.remoteArgv ?? [])]).toEqual([...THEME_LIST_ARGV]);
			expect([...(calls[1]?.remoteArgv ?? [])]).toEqual(["omarchy", "theme", "set", "catppuccin"]);
			expect(calls[1]?.stdin).toBeUndefined();
		});
	});

	it("a failed list DEGRADES to a text field carrying the failure as the hint; the set still runs (never blocks)", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const io = scriptedIo([{ match: "theme list failed", answer: "tokyo-night" }]);

			const result = await runApplyTheme({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 1, stderr: "omarchy: command not found" }, { code: 0 }], calls),
			});

			expect(result).toEqual({ ok: true, value: `theme set to tokyo-night — ${APPLY_TO_RUNNING_HINT}` });
			// The degrade prompt named the failure (the spec's hint-on-degrade posture).
			const textCall = io.calls.find((c) => c.kind === "text");
			expect(textCall?.message).toContain("the guest's theme list failed");
			expect(textCall?.message).toContain("exit 1: omarchy: command not found");
			expect([...(calls[1]?.remoteArgv ?? [])]).toEqual(["omarchy", "theme", "set", "tokyo-night"]);
		});
	});

	it("an EMPTY list degrades too; the answer is trimmed before the set", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const io = scriptedIo([{ match: "theme list failed", answer: "  tokyo  " }]);

			const result = await runApplyTheme({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0, stdout: "   \n" }, { code: 0 }], calls),
			});

			expect(result).toEqual({ ok: true, value: `theme set to tokyo — ${APPLY_TO_RUNNING_HINT}` });
			expect([...(calls[1]?.remoteArgv ?? [])]).toEqual(["omarchy", "theme", "set", "tokyo"]);
		});
	});

	it("a failed set surfaces the failure with the hint STILL appended (matrix row 7)", async () => {
		await withTempDirs(async (dirs) => {
			const io = scriptedIo([{ match: "omarchy theme list", answer: "tokyo-night" }]);

			const result = await runApplyTheme({
				dirs,
				io,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec(
					[
						{ code: 0, stdout: "tokyo-night\n" },
						{ code: 1, stderr: "no such theme" },
					],
					[],
				),
			});

			expect(result).toEqual({
				ok: false,
				error: new Error(
					`omarchy theme set tokyo-night failed in the guest (exit 1: no such theme) — ${APPLY_TO_RUNNING_HINT}`,
				),
			});
		});
	});

	it("a cancel at either choice is null and the set exec never runs", async () => {
		await withTempDirs(async (dirs) => {
			const calls: RecordedExec[] = [];
			const listedCancel = scriptedIo([]); // the list select cancels
			const resultA = await runApplyTheme({
				dirs,
				io: listedCancel,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 0, stdout: "tokyo-night\n" }, { code: 0 }], calls),
			});
			const degradeCancel = scriptedIo([]); // the degrade text cancels
			const resultB = await runApplyTheme({
				dirs,
				io: degradeCancel,
				vmLine: applyLine(),
				guestUser: "sandbox",
				sshExec: fakeSshExec([{ code: 1 }, { code: 0 }], calls),
			});

			expect(resultA).toBeNull();
			expect(resultB).toBeNull();
			expect(calls).toHaveLength(2); // only the two list fetches — no set exec ever ran
			expect(calls.every((c) => [...c.remoteArgv].join(" ") === THEME_LIST_ARGV.join(" "))).toBe(true);
		});
	});
});
