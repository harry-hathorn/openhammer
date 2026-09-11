import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { BannerStream } from "../tui/banner.ts";
import { flagIo } from "../tui/prompts.ts";
import { SECTION_SELECT_PROMPT, setSection } from "../tui/wizards/section.ts";
import { CONFIG_SECTIONS, goldenManifestExists, mcpSection, NO_GOLDEN_GUARD_MESSAGE, vmSection } from "./sections.ts";
import { defaultSettings, defaultVmSettings, type Settings, type VmSettings } from "./settings.ts";

/** A silent banner stream (the cli's `silentStream` — wizard framing writes nowhere). */
const silentStream: BannerStream = { write: () => false };

/** Settings with a given `allowedClients` list (the only field the `mcp` section touches). */
function withClients(clients: string[]): Settings {
	return { ...defaultSettings(), mcp: { allowedClients: clients } };
}

/** Settings with a given vm section (the only family the `vm` section touches). */
function withVm(vm: Partial<VmSettings> = {}): Settings {
	return { ...defaultSettings(), vm: { ...defaultVmSettings(), ...vm } };
}

/**
 * Write deps whose golden probe answers the given fact — the vm write guard's
 * hermetic seam (never the real HOME; a machine-dependent trio is no trio).
 */
const golden = (exists: boolean) => ({ goldenExists: () => exists });

/** A minimal VALID golden manifest (normalizeManifest's shape — see snapshot.ts). */
const VALID_MANIFEST = {
	id: "golden-4.0.3-20260911-101112",
	flavor: "base",
	guestUser: "sandbox",
	rootDir: "/home/sandbox",
	isoVersion: "4.0.3",
	isoUrl: "https://example.com/omarchy-4.0.3.iso",
	isoSha256: "a".repeat(64),
	diskVirtualSizeBytes: 42949672960,
	provisionScriptHashes: null,
	builtAt: "2026-09-11T10:11:12Z",
	encrypt: false,
};

describe("mcpSection — fields", () => {
	it("declares a single text field named allowedClients", () => {
		expect(mcpSection.id).toBe("mcp");
		expect(mcpSection.fields).toHaveLength(1);
		const field = mcpSection.fields[0];
		expect(field).toBeDefined();
		if (field) {
			expect(field.key).toBe("allowedClients");
			expect(field.kind).toBe("text");
		}
	});
});

describe("mcpSection — read", () => {
	it("joins the current list with comma+space for display", () => {
		expect(mcpSection.read(withClients(["cursor", "claude"]))).toEqual({ allowedClients: "cursor, claude" });
	});

	it("reads an empty string for an empty list", () => {
		expect(mcpSection.read(defaultSettings())).toEqual({ allowedClients: "" });
	});

	it("reads a single wildcard verbatim", () => {
		expect(mcpSection.read(withClients(["*"]))).toEqual({ allowedClients: "*" });
	});
});

describe("mcpSection — write", () => {
	it("parses a comma list into string[]", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "cursor, claude" });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude"]);
	});

	it("parses a newline-separated list", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "cursor\nclaude\nvscode" });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude", "vscode"]);
	});

	it("trims entries and drops empties", () => {
		const next = mcpSection.write(defaultSettings(), { allowedClients: "  cursor  ,, , claude ," });
		expect(next.mcp.allowedClients).toEqual(["cursor", "claude"]);
	});

	it("writes [] for an empty answer", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "" }).mcp.allowedClients).toEqual([]);
	});

	it("writes [] for a whitespace-only answer", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "   " }).mcp.allowedClients).toEqual([]);
	});

	it("preserves a wildcard", () => {
		expect(mcpSection.write(defaultSettings(), { allowedClients: "*" }).mcp.allowedClients).toEqual(["*"]);
	});

	it("returns an immutable update — channels/version/defaultChannel untouched", () => {
		const original: Settings = {
			...defaultSettings(),
			channels: [{ id: "x", kind: "nginx", mode: "static", options: { publicUrl: "https://x" } }],
			defaultChannel: "x",
		};
		const next = mcpSection.write(original, { allowedClients: "cursor" });
		expect(next).not.toBe(original); // new object
		expect(next.channels).toBe(original.channels); // untouched by reference
		expect(next.version).toBe(original.version);
		expect(next.defaultChannel).toBe("x");
		expect(next.mcp).not.toBe(original.mcp); // mcp replaced
	});

	it("defaults a missing allowedClients key to []", () => {
		expect(mcpSection.write(defaultSettings(), {}).mcp.allowedClients).toEqual([]);
	});
});

describe("mcpSection — round-trip", () => {
	it("read → write returns the same list (comma-joined round-trips through parse)", () => {
		const s = withClients(["cursor", "claude", "vscode"]);
		const seed = mcpSection.read(s);
		const back = mcpSection.write(s, seed);
		expect(back.mcp.allowedClients).toEqual(["cursor", "claude", "vscode"]);
	});

	it("an empty list round-trips", () => {
		const seed = mcpSection.read(defaultSettings());
		expect(mcpSection.write(defaultSettings(), seed).mcp.allowedClients).toEqual([]);
	});
});

describe("CONFIG_SECTIONS registry", () => {
	it("keys each section by id", () => {
		expect(CONFIG_SECTIONS.mcp).toBe(mcpSection);
		expect(CONFIG_SECTIONS.vm).toBe(vmSection);
	});

	it("has exactly the mcp + vm sections", () => {
		expect(Object.keys(CONFIG_SECTIONS).sort()).toEqual(["mcp", "vm"]);
	});
});

describe("vmSection — fields", () => {
	it("declares mode/persist selects + the five text fields, in VmSettings order", () => {
		expect(vmSection.id).toBe("vm");
		expect(vmSection.fields.map((f) => f.key)).toEqual([
			"mode",
			"memoryMb",
			"cpus",
			"persist",
			"idleTimeoutMs",
			"agentCmd",
			"secretsDir",
		]);
		expect(vmSection.fields.map((f) => f.kind)).toEqual(["select", "text", "text", "select", "text", "text", "text"]);
	});

	it("mode select offers exactly off|vm|agent (derived from the env parser's value array)", () => {
		const field = vmSection.fields[0];
		expect(field).toBeDefined();
		if (field && field.kind === "select") {
			expect(field.options.map((o) => o.value)).toEqual(["off", "vm", "agent"]);
			expect(field.options.every((o) => o.label.length > 0)).toBe(true);
		}
	});

	it("persist select offers exactly auto|retain|discard", () => {
		const field = vmSection.fields.find((f) => f.key === "persist");
		expect(field).toBeDefined();
		if (field && field.kind === "select") {
			expect(field.options.map((o) => o.value)).toEqual(["auto", "retain", "discard"]);
			expect(field.options.every((o) => o.label.length > 0)).toBe(true);
		}
	});
});

describe("vmSection — read", () => {
	it("maps a populated section to the wizard's string map", () => {
		const s = withVm({
			mode: "agent",
			memoryMb: 8192,
			cpus: 6,
			persist: "retain",
			idleTimeoutMs: 45000,
			agentCmd: "codex",
			secretsDir: "/custom/secrets",
		});
		expect(vmSection.read(s)).toEqual({
			mode: "agent",
			memoryMb: "8192",
			cpus: "6",
			persist: "retain",
			idleTimeoutMs: "45000",
			agentCmd: "codex",
			secretsDir: "/custom/secrets",
		});
	});

	it("reads the defaults with an empty string for a null secretsDir", () => {
		expect(vmSection.read(defaultSettings())).toEqual({
			mode: "off",
			memoryMb: "4096",
			cpus: "4",
			persist: "auto",
			idleTimeoutMs: "0",
			agentCmd: "claude",
			secretsDir: "",
		});
	});
});

describe("vmSection — write", () => {
	it("parses the number fields and applies the selects", () => {
		const next = vmSection.write(
			defaultSettings(),
			{
				mode: "vm",
				memoryMb: "8192",
				cpus: "6",
				persist: "discard",
				idleTimeoutMs: "900000",
				agentCmd: "codex",
				secretsDir: "/vm/secrets",
			},
			golden(true),
		);
		expect(next.vm).toEqual({
			mode: "vm",
			memoryMb: 8192,
			cpus: 6,
			persist: "discard",
			idleTimeoutMs: 900000,
			agentCmd: "codex",
			secretsDir: "/vm/secrets",
		});
	});

	it("keeps the current values for blank answers (empty = unchanged, never zero)", () => {
		const s = withVm({ memoryMb: 2048, cpus: 2, idleTimeoutMs: 1000, agentCmd: "codex", secretsDir: "/doc" });
		const next = vmSection.write(s, { memoryMb: "", cpus: "  ", idleTimeoutMs: "", agentCmd: "", secretsDir: "" });
		expect(next.vm.memoryMb).toBe(2048);
		expect(next.vm.cpus).toBe(2);
		expect(next.vm.idleTimeoutMs).toBe(1000);
		expect(next.vm.agentCmd).toBe("codex"); // cannot be emptied (isVmSettings requires non-empty)
		expect(next.vm.secretsDir).toBeNull(); // empty = the default location
	});

	it("throws the actionable error for a malformed number (never persists an invalid doc)", () => {
		expect(() => vmSection.write(defaultSettings(), { memoryMb: "abc" })).toThrow(
			'vm.memoryMb must be an integer >= 1 (got "abc")',
		);
		expect(() => vmSection.write(defaultSettings(), { cpus: "0" })).toThrow(
			'vm.cpus must be an integer >= 1 (got "0")',
		);
		expect(() => vmSection.write(defaultSettings(), { idleTimeoutMs: "-5" })).toThrow(
			'vm.idleTimeoutMs must be an integer >= 0 (got "-5")',
		);
		expect(() => vmSection.write(defaultSettings(), { memoryMb: "3.5" })).toThrow(/vm\.memoryMb/); // non-integer
	});

	it("throws for an out-of-set select answer (the non-interactive `config set vm.<key>` path)", () => {
		expect(() => vmSection.write(defaultSettings(), { mode: "sandbox" })).toThrow(
			'vm.mode must be one of off, vm, agent (got "sandbox")',
		);
		expect(() => vmSection.write(defaultSettings(), { persist: "always" })).toThrow(
			'vm.persist must be one of auto, retain, discard (got "always")',
		);
	});

	it("accepts a 0 idle timeout (never) and trims answers", () => {
		const next = vmSection.write(defaultSettings(), {
			idleTimeoutMs: "0",
			agentCmd: "  codex  ",
			secretsDir: " /s ",
		});
		expect(next.vm.idleTimeoutMs).toBe(0);
		expect(next.vm.agentCmd).toBe("codex");
		expect(next.vm.secretsDir).toBe("/s");
	});

	it("returns an immutable update — channels/version/defaultChannel/mcp untouched", () => {
		const original: Settings = {
			...defaultSettings(),
			channels: [{ id: "x", kind: "nginx", mode: "static", options: { publicUrl: "https://x" } }],
			defaultChannel: "x",
		};
		const next = vmSection.write(original, { mode: "vm" }, golden(true));
		expect(next).not.toBe(original); // new object
		expect(next.channels).toBe(original.channels); // untouched by reference
		expect(next.version).toBe(original.version);
		expect(next.defaultChannel).toBe("x");
		expect(next.mcp).toBe(original.mcp);
		expect(next.vm).not.toBe(original.vm); // vm replaced
	});

	it("defaults missing keys to the current values (defensive, the mcp ?? pattern)", () => {
		expect(vmSection.write(defaultSettings(), {}).vm).toEqual(defaultVmSettings());
	});
});

describe("vmSection — the no-golden mode guard (spec 28, matrix row 2)", () => {
	it("mode vm with a bootable golden passes through", () => {
		const next = vmSection.write(defaultSettings(), { mode: "vm" }, golden(true));
		expect(next.vm.mode).toBe("vm");
	});

	it("mode vm without a golden throws the exact actionable message (block, never persist)", () => {
		expect(() => vmSection.write(defaultSettings(), { mode: "vm" }, golden(false))).toThrow(NO_GOLDEN_GUARD_MESSAGE);
		expect(NO_GOLDEN_GUARD_MESSAGE).toBe(
			"no golden image — run: openhammer vm install (or Sandbox → Install sandbox)",
		);
	});

	it("mode agent without a golden throws too", () => {
		expect(() => vmSection.write(defaultSettings(), { mode: "agent" }, golden(false))).toThrow(
			NO_GOLDEN_GUARD_MESSAGE,
		);
	});

	it("an off write never consults the probe (the guard is vm/agent-only)", () => {
		let consulted = false;
		const next = vmSection.write(
			defaultSettings(),
			{ mode: "off" },
			{
				goldenExists: () => {
					consulted = true;
					return false;
				},
			},
		);
		expect(next.vm.mode).toBe("off");
		expect(consulted).toBe(false);
	});

	it("fires on the RESOLVED mode — already vm + a blank answer + no golden is the cannot-boot state, blocked", () => {
		expect(() => vmSection.write(withVm({ mode: "vm" }), { memoryMb: "8192" }, golden(false))).toThrow(
			NO_GOLDEN_GUARD_MESSAGE,
		);
	});

	it("an invalid mode answer throws before the probe runs (validation first, guard second)", () => {
		let consulted = false;
		expect(() =>
			vmSection.write(
				defaultSettings(),
				{ mode: "nope" },
				{
					goldenExists: () => {
						consulted = true;
						return true;
					},
				},
			),
		).toThrow('vm.mode must be one of off, vm, agent (got "nope")');
		expect(consulted).toBe(false);
	});
});

describe("goldenManifestExists — the guard's probe (preflight check 5's posture)", () => {
	async function goldenHome(): Promise<string> {
		return mkdtemp(join(tmpdir(), "oh-golden-"));
	}

	async function writeGolden(home: string, id: string, manifest: object | string | null): Promise<void> {
		const dir = join(home, ".openhammer", "vm", "images", id);
		await mkdir(dir, { recursive: true });
		if (manifest === null) return;
		const body = typeof manifest === "string" ? manifest : JSON.stringify(manifest);
		await writeFile(join(dir, "manifest.json"), body, "utf8");
	}

	it("false with no images root at all", async () => {
		const home = await goldenHome();
		try {
			expect(goldenManifestExists(home)).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("true for a newest golden with a valid manifest", async () => {
		const home = await goldenHome();
		try {
			await writeGolden(home, VALID_MANIFEST.id, VALID_MANIFEST);
			expect(goldenManifestExists(home)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("false for a golden dir without a manifest", async () => {
		const home = await goldenHome();
		try {
			await writeGolden(home, "golden-4.0.3-20260911-101112", null);
			expect(goldenManifestExists(home)).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("false when the NEWEST golden's manifest is corrupt — never skipped past for an older valid one", async () => {
		const home = await goldenHome();
		try {
			await writeGolden(home, "golden-4.0.3-20260901-000000", VALID_MANIFEST); // older, valid
			await writeGolden(home, "golden-4.0.3-20260911-101112", "{not json"); // newer, corrupt
			expect(goldenManifestExists(home)).toBe(false);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("true when the newest is valid and an older one is corrupt (the newest is the active golden)", async () => {
		const home = await goldenHome();
		try {
			await writeGolden(home, "golden-4.0.3-20260901-000000", "{not json");
			await writeGolden(home, "golden-4.0.3-20260911-101112", VALID_MANIFEST);
			expect(goldenManifestExists(home)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});

	it("strays (non-golden dirs, files) are not goldens", async () => {
		const home = await goldenHome();
		try {
			await writeGolden(home, "not-a-golden", VALID_MANIFEST);
			await writeGolden(home, "golden-4.0.3-20260911-101112", VALID_MANIFEST); // the only real one
			expect(goldenManifestExists(home)).toBe(true);
		} finally {
			await rm(home, { recursive: true, force: true });
		}
	});
});

describe("vmSection — round-trip", () => {
	it("read → write returns the same section (numbers survive the string round-trip)", () => {
		const s = withVm({
			mode: "agent",
			memoryMb: 6144,
			cpus: 8,
			persist: "retain",
			idleTimeoutMs: 60000,
			agentCmd: "agy",
			secretsDir: "/vm/secrets",
		});
		expect(vmSection.write(s, vmSection.read(s), golden(true)).vm).toEqual(s.vm);
	});

	it("the defaults round-trip (null secretsDir survives its empty-string display form)", () => {
		expect(vmSection.write(defaultSettings(), vmSection.read(defaultSettings())).vm).toEqual(defaultVmSettings());
	});
});

describe("`config set vm` — the section wizard reaches the vm section", () => {
	/**
	 * The vm section with its write's golden probe pinned to a known fact — the
	 * engine-path twin of the unit-level `golden()` helper. `setSection` passes no
	 * write deps (production uses the real probe), so the tests pin the probe by
	 * wrapping the section — the CONFIG_SECTIONS-mutation seam's spirit, hermetic.
	 */
	function vmSectionWithGolden(exists: boolean) {
		return {
			...vmSection,
			write: (s: Settings, vals: Record<string, string>) => vmSection.write(s, vals, { goldenExists: () => exists }),
		};
	}

	it("setSection picks vm from the registry and applies the answers (the `config set vm` engine path)", async () => {
		// flagIo keys answers by prompt message: the section picker + the two select
		// fields' labels (an absent select answer falls back to its seeded current
		// value — see prompts.ts flagIo).
		const io = flagIo({
			[SECTION_SELECT_PROMPT]: "vm",
			"Boot mode": "vm",
			"Guest memory (MiB)": "8192",
			"Overlay persist": "retain",
		});
		const result = await setSection(defaultSettings(), {
			io,
			stream: silentStream,
			sections: [vmSectionWithGolden(true)],
		});
		expect(result).toMatchObject({
			ok: true,
			value: {
				vm: { mode: "vm", memoryMb: 8192, persist: "retain", cpus: 4 }, // unspecified fields unchanged
			},
		});
	});

	it("setSection with only ONE field answered still applies — the `config set vm.mode` engine path (27b)", async () => {
		// The single-field shape: the picker + the target field's label. The
		// section's OTHER select ("Overlay persist") is never answered; flagIo's
		// initialValue fallback keeps it at the seeded current value instead of a
		// null cancelling the whole write.
		const io = flagIo({ [SECTION_SELECT_PROMPT]: "vm", "Boot mode": "vm" });
		const s = withVm({ mode: "agent", memoryMb: 6144, cpus: 8, persist: "retain" });
		const result = await setSection(s, { io, stream: silentStream, sections: [vmSectionWithGolden(true)] });
		expect(result).toMatchObject({
			ok: true,
			value: {
				vm: { mode: "vm", memoryMb: 6144, cpus: 8, persist: "retain" }, // only mode changed
			},
		});
	});

	it("the engine path hits the no-golden guard too — the write throws and setSection rejects", async () => {
		const io = flagIo({ [SECTION_SELECT_PROMPT]: "vm", "Boot mode": "vm" });
		await expect(
			setSection(defaultSettings(), { io, stream: silentStream, sections: [vmSectionWithGolden(false)] }),
		).rejects.toThrow(NO_GOLDEN_GUARD_MESSAGE);
	});
});
