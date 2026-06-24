import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type ClientInfo, type IssuedClient, listClients } from "../auth/oauth/clients.ts";
import { type CredentialValues, getCredentials } from "../config/credentials.ts";
import type { PromptIo } from "../tui/prompts.ts";
import { type AuthIo, authCommand, formatClientList, formatSecretReveal } from "./auth.ts";

/** A recording `BannerStream` — collects writes as a string. */
function recordingStream() {
	const chunks: string[] = [];
	const stream = {
		write(chunk: string | Uint8Array): boolean {
			chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
			return true;
		},
	};
	return { stream, text: () => chunks.join("") };
}

/** A recording {@link AuthIo} (stdout + stderr both captured). */
function recordingIo(): { io: AuthIo; out: () => string; err: () => string } {
	const out = recordingStream();
	const err = recordingStream();
	return { io: { stdout: out.stream, stderr: err.stream }, out: out.text, err: err.text };
}

/**
 * A recording fake {@link PromptIo} — no TTY, no clack. `text` shifts its next
 * answer from a queue (`null` simulates cancel); the other primitives are unused
 * by `add-client`. Mirrors wizard/channel.test.ts's per-kind shape — no casts.
 */
function fakeTextIo(answers: (string | null)[]): { io: PromptIo; messages: string[] } {
	const q = [...answers];
	const messages: string[] = [];
	const io: PromptIo = {
		async select() {
			return null;
		},
		async text(o) {
			messages.push(o.message);
			const v = q.shift();
			return v === undefined ? null : v;
		},
		async password() {
			return null;
		},
		async confirm() {
			return null;
		},
		intro() {},
		outro() {},
	};
	return { io, messages };
}

/** A fresh temp `credentials.json` path under a temp dir (the dir is removed by `cleanup`). */
function tempCredPath(): { path: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "oh-auth-"));
	return { path: join(dir, "credentials.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const issued = (id: string, secret: string): IssuedClient => ({ clientId: id, plaintextSecret: secret });

describe("formatSecretReveal", () => {
	it("includes the client_id + plaintext secret + the one-shot warning", () => {
		const text = formatSecretReveal(issued("oh_abc", "s3cr3t"), "ci-deploy");
		expect(text).toContain("client_id:     oh_abc");
		expect(text).toContain("client_secret: s3cr3t");
		expect(text).toContain('Issued OAuth client "ci-deploy".');
		expect(text).toContain("will NOT be shown again");
	});

	it("omits the quoted label suffix when the label is blank", () => {
		const text = formatSecretReveal(issued("oh_abc", "s3cr3t"), "   ");
		expect(text).toContain("Issued OAuth client.");
		expect(text).not.toContain('client "');
	});
});

describe("formatClientList", () => {
	it("hints at add-client when there are no clients", () => {
		expect(formatClientList([])).toContain("No OAuth clients registered");
	});

	it("lists clients with id + label + createdAt", () => {
		const clients: ClientInfo[] = [
			{ clientId: "oh_a", label: "alpha", createdAt: "2026-01-01T00:00:00.000Z" },
			{ clientId: "oh_b", label: "beta", createdAt: "2026-02-01T00:00:00.000Z" },
		];
		const text = formatClientList(clients);
		expect(text).toContain("OAuth clients:");
		expect(text).toContain("oh_a  alpha  2026-01-01T00:00:00.000Z");
		expect(text).toContain("oh_b  beta  2026-02-01T00:00:00.000Z");
	});

	it("renders a blank label as (no label)", () => {
		const text = formatClientList([{ clientId: "oh_a", label: "", createdAt: "2026-01-01T00:00:00.000Z" }]);
		expect(text).toContain("oh_a  (no label)");
	});
});

describe("authCommand — add-client", () => {
	it("issues a client from the prompted label + reveals the plaintext secret once (exit 0)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const prompt = fakeTextIo(["ci-deploy"]);
			const { io, out } = recordingIo();
			const code = await authCommand("add-client", [], io, { io: prompt.io, credPath: path });
			expect(code).toBe(0);
			expect(prompt.messages).toContain("Label (optional, press Enter to skip)");
			const text = out();
			expect(text).toContain("client_id:     oh_");
			expect(text).toContain("client_secret:");
			expect(text).toContain('Issued OAuth client "ci-deploy".');
			// The client is persisted (findable by id), and the plaintext is NOT stored.
			const listed = listClients(path);
			expect(listed).toHaveLength(1);
			expect(listed[0]?.label).toBe("ci-deploy");
			// The persisted bag holds only the hash, never the plaintext the reveal showed.
			const revealedSecret = text.match(/client_secret:\s+(\S+)/)?.[1] ?? "<no-secret-in-output>";
			const bag: CredentialValues = getCredentials("__openhammer_oauth__", path);
			expect(JSON.stringify(bag)).not.toContain(revealedSecret);
		} finally {
			cleanup();
		}
	});

	it("accepts a blank label (the client is issued without one)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const prompt = fakeTextIo([""]);
			const { io, out } = recordingIo();
			const code = await authCommand("add-client", [], io, { io: prompt.io, credPath: path });
			expect(code).toBe(0);
			expect(out()).toContain("Issued OAuth client.");
			expect(listClients(path)[0]?.label).toBe("");
		} finally {
			cleanup();
		}
	});

	it("cancel (prompt resolves null) writes nothing and exits 0", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const prompt = fakeTextIo([null]);
			const { io, out, err } = recordingIo();
			const code = await authCommand("add-client", [], io, { io: prompt.io, credPath: path });
			expect(code).toBe(0);
			expect(out()).toBe("");
			expect(err()).toBe("");
			expect(listClients(path)).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	it("surfaces a write failure as exit 1 and issues nothing", async () => {
		// ENOTDIR blocker: a regular file on the path makes the cred dir unwritable
		// (root-safe — root bypasses perms, not ENOTDIR).
		const dir = mkdtempSync(join(tmpdir(), "oh-auth-block-"));
		const blocker = join(dir, "blocker");
		writeFileSync(blocker, "");
		const badPath = join(blocker, "credentials.json");
		try {
			const prompt = fakeTextIo(["ci-deploy"]);
			const { io, out, err } = recordingIo();
			const code = await authCommand("add-client", [], io, { io: prompt.io, credPath: badPath });
			expect(code).toBe(1);
			expect(out()).toBe("");
			expect(err().length).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("authCommand — add-client (non-interactive, spec 20g)", () => {
	it("`--label` issues a client with no prompt and prints only the id (no --print-secret)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io, out } = recordingIo();
			const code = await authCommand("add-client", ["--label", "ci-bot"], io, { credPath: path });
			expect(code).toBe(0);
			const text = out();
			expect(text).toContain("Added OAuth client oh_");
			// The secret is withheld (stdout may be logged)…
			expect(text).not.toContain("client_secret:");
			expect(text).toContain("--print-secret");
			// …but the client is persisted with the label (same issueClient path as interactive).
			const listed = listClients(path);
			expect(listed).toHaveLength(1);
			expect(listed[0]?.label).toBe("ci-bot");
		} finally {
			cleanup();
		}
	});

	it("`--label --print-secret` reveals the plaintext secret to stdout (capturable in CI)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io, out } = recordingIo();
			const code = await authCommand("add-client", ["--label", "ci-bot", "--print-secret"], io, { credPath: path });
			expect(code).toBe(0);
			const text = out();
			expect(text).toContain("client_id:     oh_");
			expect(text).toContain("client_secret:");
			expect(text).toContain('Issued OAuth client "ci-bot".');
			// The persisted bag holds only the hash, never the revealed plaintext.
			const revealedSecret = text.match(/client_secret:\s+(\S+)/)?.[1] ?? "<no-secret>";
			const bag: CredentialValues = getCredentials("__openhammer_oauth__", path);
			expect(JSON.stringify(bag)).not.toContain(revealedSecret);
		} finally {
			cleanup();
		}
	});

	it("`--label=` (equals form) issues a client (parseSubFlags handles both forms)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io } = recordingIo();
			await authCommand("add-client", ["--label=equals-form"], io, { credPath: path });
			expect(listClients(path)[0]?.label).toBe("equals-form");
		} finally {
			cleanup();
		}
	});

	it("a blank `--label` issues a client without one (parity with the interactive blank label)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io } = recordingIo();
			await authCommand("add-client", ["--label", ""], io, { credPath: path });
			expect(listClients(path)).toHaveLength(1);
			expect(listClients(path)[0]?.label).toBe("");
		} finally {
			cleanup();
		}
	});

	it("the flag path persists a client identical to the interactive path (≡ on the same label)", async () => {
		// Same label via flag vs interactive prompt → same registry shape (id minted, hash stored).
		const { path: flagPath, cleanup: flagCleanup } = tempCredPath();
		const { path: promptPath, cleanup: promptCleanup } = tempCredPath();
		try {
			const flagIo = recordingIo();
			await authCommand("add-client", ["--label", "same", "--print-secret"], flagIo.io, { credPath: flagPath });
			const promptIo = fakeTextIo(["same"]);
			const promptRec = recordingIo();
			await authCommand("add-client", [], promptRec.io, { io: promptIo.io, credPath: promptPath });

			const flagClients = listClients(flagPath);
			const promptClients = listClients(promptPath);
			expect(flagClients).toHaveLength(1);
			expect(promptClients).toHaveLength(1);
			expect(flagClients[0]?.label).toBe(promptClients[0]?.label);
			// Both store a secret hash under the same reserved credId bag shape.
			const flagBag = getCredentials("__openhammer_oauth__", flagPath);
			const promptBag = getCredentials("__openhammer_oauth__", promptPath);
			expect(Object.keys(flagBag).sort()).toEqual(Object.keys(promptBag).sort());
		} finally {
			flagCleanup();
			promptCleanup();
		}
	});
});

describe("authCommand — list", () => {
	it("prints the empty hint when no clients are registered (exit 0)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io, out } = recordingIo();
			const code = await authCommand("list", [], io, { credPath: path });
			expect(code).toBe(0);
			expect(out()).toContain("No OAuth clients registered");
		} finally {
			cleanup();
		}
	});

	it("lists registered clients", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			// Issue two clients via the command itself, then list.
			const { io: io1 } = recordingIo();
			await authCommand("add-client", [], io1, { io: fakeTextIo(["alpha"]).io, credPath: path });
			const { io: io2 } = recordingIo();
			await authCommand("add-client", [], io2, { io: fakeTextIo(["beta"]).io, credPath: path });
			const { io, out } = recordingIo();
			const code = await authCommand("list", [], io, { credPath: path });
			expect(code).toBe(0);
			const text = out();
			expect(text).toContain("alpha");
			expect(text).toContain("beta");
		} finally {
			cleanup();
		}
	});
});

describe("authCommand — remove", () => {
	it("removes an existing client (exit 0)", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io: addIo } = recordingIo();
			await authCommand("add-client", [], addIo, { io: fakeTextIo(["gone"]).io, credPath: path });
			const id = listClients(path)[0]?.clientId;
			expect(id).toBeDefined();

			const { io, out } = recordingIo();
			const code = await authCommand("remove", [id ?? ""], io, { credPath: path });
			expect(code).toBe(0);
			expect(out()).toContain(`Removed client ${id}`);
			expect(listClients(path)).toHaveLength(0);
			expect(existsSync(path)).toBe(true); // the file remains (other state may live there)
		} finally {
			cleanup();
		}
	});

	it("reports exit 1 for an unknown client id", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io, out, err } = recordingIo();
			const code = await authCommand("remove", ["oh_nope"], io, { credPath: path });
			expect(code).toBe(1);
			expect(out()).toBe("");
			expect(err()).toContain("No OAuth client with id oh_nope");
		} finally {
			cleanup();
		}
	});

	it("is a usage error (exit 2) when no id is given", async () => {
		const { path, cleanup } = tempCredPath();
		try {
			const { io, err } = recordingIo();
			const code = await authCommand("remove", [], io, { credPath: path });
			expect(code).toBe(2);
			expect(err()).toContain("Usage: openhammer auth remove");
		} finally {
			cleanup();
		}
	});
});

describe("authCommand — routing", () => {
	it("an unknown subcommand is a usage error (exit 2)", async () => {
		const { io, err } = recordingIo();
		const code = await authCommand("frobnicate", [], io);
		expect(code).toBe(2);
		expect(err()).toContain("Usage: openhammer auth");
	});

	it("no subcommand is a usage error (exit 2)", async () => {
		const { io, err } = recordingIo();
		const code = await authCommand(undefined, [], io);
		expect(code).toBe(2);
		expect(err()).toContain("Usage: openhammer auth");
	});
});
