import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ToolOk } from "../mcp/types.ts";
import { fakeBackend } from "./backend.fake.ts";
import { createLocalBackend } from "./backend.ts";
import { readTool } from "./read.ts";
import { DEFAULT_MAX_BYTES } from "./truncate.ts";

// The read tool is a `ToolModule`; tests drive `execute` directly (Tier-0). Fixtures
// are real files under a throwaway tmpdir used as `rootDir` — `resolveToCwd` resolves
// relative paths under it, and absolute paths pass through (acceptance criteria).

// One local backend per file (spec 23) — LocalBackend is stateless, matching the
// boot-scoped seam without per-test machinery.
const backend = createLocalBackend();

let workdir: string;
let rootDir: string;

/**
 * Register the real-fs hooks for a LocalBackend describe: one throwaway workdir
 * per describe, a fresh isolated subdir as `rootDir` per test. Scoped to the
 * real-fs describes (not module level) so the FakeBackend suite below runs with
 * zero real-fs access and zero process spawns.
 */
function useRealFsRoot(): void {
	beforeAll(() => {
		workdir = mkdtempSync(join(tmpdir(), "openhammer-read-"));
	});
	afterAll(() => {
		rmSync(workdir, { recursive: true, force: true });
	});
	beforeEach(() => {
		// Each test gets an isolated subdir as `rootDir`.
		rootDir = mkdtempSync(join(workdir, "t-"));
	});
}

/** Unwrap a successful Result; throw (failing the test) if it was an err. */
function unwrap<T extends ToolOk>(r: { ok: true; value: T } | { ok: false; error: Error }): T {
	if (!r.ok) {
		throw new Error(`expected ok, got err: ${r.error.message}`);
	}
	return r.value;
}

/** The single text block of a `read` result (there is exactly one for text files). */
function textOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): string {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(1);
	const block = ok.content[0];
	if (block === undefined || block.type !== "text") {
		throw new Error(`expected a single text block, got ${JSON.stringify(block)}`);
	}
	return block.text;
}

/** The text note + image block of a `read` image result (exactly two blocks). */
function imageOf(r: { ok: true; value: ToolOk } | { ok: false; error: Error }): {
	note: { type: "text"; text: string };
	image: { type: "image"; data: string; mimeType: string };
} {
	const ok = unwrap(r);
	expect(ok.content).toHaveLength(2);
	const note = ok.content[0];
	const image = ok.content[1];
	if (note === undefined || note.type !== "text") {
		throw new Error(`expected a text note, got ${JSON.stringify(note)}`);
	}
	if (image === undefined || image.type !== "image") {
		throw new Error(`expected an image block, got ${JSON.stringify(image)}`);
	}
	return { note, image };
}

describe("read tool — text path", () => {
	useRealFsRoot();

	it("returns the full file with no line-number prefixes (spec acceptance)", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line-${i + 1}`);
		writeFileSync(join(rootDir, "a.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "a.txt" }, { rootDir, backend });

		// Raw content, exactly the 10 lines joined by \n — no `1\t`/`cat -n` prefixes.
		expect(textOf(r)).toBe(lines.join("\n"));
	});

	it("truncates a 3000-line file to the first 2000 and emits a continue notice (spec acceptance)", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
		writeFileSync(join(rootDir, "big.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "big.txt" }, { rootDir, backend });
		const text = textOf(r);

		// First 2000 lines present, line 2001 absent from the body.
		expect(text.startsWith(lines[0])).toBe(true);
		expect(text).toContain(lines[1999]!);
		expect(text).not.toContain(`\n${lines[2000]}`); // line 2001 not in the shown window
		// Actionable continuation notice pointing at the next window.
		expect(text).toContain("Showing lines 1-2000 of 3000.");
		expect(text).toContain("Use offset=2001 to continue.");
	});

	it("honors offset/limit and notes remaining lines (spec acceptance)", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
		writeFileSync(join(rootDir, "x.txt"), lines.join("\n"));

		// offset 5 (1-indexed) → array index 4; limit 3 → lines L5,L6,L7.
		const r = await readTool.execute({ path: "x.txt", offset: 5, limit: 3 }, { rootDir, backend });
		const text = textOf(r);

		expect(text.startsWith("L5\nL6\nL7")).toBe(true);
		// Limit stopped early with more remaining → continuation notice.
		expect(text).toContain("3 more lines in file. Use offset=8 to continue.");
	});

	it("emits no continue notice when offset/limit reaches EOF", async () => {
		const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
		writeFileSync(join(rootDir, "x.txt"), lines.join("\n"));

		const r = await readTool.execute({ path: "x.txt", offset: 8, limit: 3 }, { rootDir, backend });
		const text = textOf(r);

		expect(text).toBe("L8\nL9\nL10");
		expect(text).not.toContain("more lines in file");
	});

	it("errors when offset is past EOF (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "x.txt"), "only one line");

		const r = await readTool.execute({ path: "x.txt", offset: 99999 }, { rootDir, backend });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
		expect(r.error.message).toContain("beyond end of file");
	});

	it("errors on a missing file (spec acceptance)", async () => {
		const r = await readTool.execute({ path: "nope.txt" }, { rootDir, backend });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error).toBeInstanceOf(Error);
	});

	it("errors when path is absent or not a string", async () => {
		const noPath = await readTool.execute({}, { rootDir, backend });
		expect(noPath.ok).toBe(false);

		const badPath = await readTool.execute({ path: 42 }, { rootDir, backend });
		expect(badPath.ok).toBe(false);
	});

	it("resolves relative paths under rootDir (spec acceptance)", async () => {
		writeFileSync(join(rootDir, "rel.txt"), "relative");
		const r = await readTool.execute({ path: "rel.txt" }, { rootDir, backend });
		expect(textOf(r)).toBe("relative");
	});

	it("passes absolute paths through (spec acceptance)", async () => {
		const abs = join(rootDir, "abs.txt");
		writeFileSync(abs, "absolute");
		// Pass a different rootDir to prove the absolute path is used as-is.
		const r = await readTool.execute({ path: abs }, { rootDir: "/somewhere/else", backend });
		expect(textOf(r)).toBe("absolute");
	});

	it("points at a bash fallback when the first line alone exceeds the byte limit", async () => {
		// A single line larger than DEFAULT_MAX_BYTES (50KB) triggers firstLineExceedsLimit.
		const huge = "x".repeat(DEFAULT_MAX_BYTES + 1000);
		writeFileSync(join(rootDir, "huge.txt"), huge);

		const r = await readTool.execute({ path: "huge.txt" }, { rootDir, backend });
		const text = textOf(r);

		expect(text).toContain("exceeds");
		expect(text).toContain("Use bash: sed -n '1p'");
	});

	it("reads a file under a subdirectory of rootDir", async () => {
		mkdirSync(join(rootDir, "sub"));
		writeFileSync(join(rootDir, "sub", "nested.txt"), "nested");
		const r = await readTool.execute({ path: "sub/nested.txt" }, { rootDir, backend });
		expect(textOf(r)).toBe("nested");
	});
});

describe("read tool — image path", () => {
	useRealFsRoot();

	/** Write `bytes` to `name` under rootDir; return the Buffer written. */
	function writeImage(name: string, bytes: number[]): Buffer {
		const buf = Buffer.from(bytes);
		writeFileSync(join(rootDir, name), buf);
		return buf;
	}

	it("returns a text note + base64 image block for a .png (spec acceptance)", async () => {
		// Bytes are arbitrary — detection is extension-based, so the file need not be a valid PNG.
		const buf = writeImage("pic.png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
		const { note, image } = imageOf(await readTool.execute({ path: "pic.png" }, { rootDir, backend }));

		expect(note.text).toBe("Read image file [image/png]");
		expect(image.mimeType).toBe("image/png");
		expect(image.data).toBe(buf.toString("base64"));
	});

	it.each([
		["photo.jpg", "image/jpeg"],
		["photo.jpeg", "image/jpeg"],
		["anim.gif", "image/gif"],
		["drawing.webp", "image/webp"],
	])("maps extension %s → %s", async (name, mime) => {
		const buf = writeImage(name, [1, 2, 3, 4, 5]);
		const { image } = imageOf(await readTool.execute({ path: name }, { rootDir, backend }));

		expect(image.mimeType).toBe(mime);
		expect(image.data).toBe(buf.toString("base64"));
	});

	it("detects image extensions case-insensitively", async () => {
		const buf = writeImage("UPPER.PNG", [9, 9, 9]);
		const { image } = imageOf(await readTool.execute({ path: "UPPER.PNG" }, { rootDir, backend }));

		expect(image.mimeType).toBe("image/png");
		expect(image.data).toBe(buf.toString("base64"));
	});

	it("gates the image path behind the access check (missing image → err)", async () => {
		const r = await readTool.execute({ path: "missing.png" }, { rootDir, backend });

		expect(r.ok).toBe(false);
	});

	it("ignores offset/limit on images", async () => {
		writeImage("pic.png", [1, 2, 3, 4]);
		// offset 99999 would error on a text file's line count; images bypass the text path.
		const result = unwrap(await readTool.execute({ path: "pic.png", offset: 99999, limit: 5 }, { rootDir, backend }));

		expect(result.content).toHaveLength(2);
	});

	it("treats an unknown extension as a text file", async () => {
		writeFileSync(join(rootDir, "data.csv"), "a,b,c\n1,2,3");
		expect(textOf(await readTool.execute({ path: "data.csv" }, { rootDir, backend }))).toBe("a,b,c\n1,2,3");
	});
});

// Spec 23: the shaping suite — same tool, FakeBackend instead of LocalBackend, so
// truncate caps, footers, the image branch, and error text are pinned with zero
// real-fs access and zero process spawns. Seeded paths are fake-absolute; the
// fake's errno messages match `node:fs` verbatim (backend.fake.ts fidelity rules).
describe("read via FakeBackend", () => {
	it("happy path: seeded file → exact content, no line-number prefixes", async () => {
		const fake = fakeBackend({ files: { "/work/hello.txt": "line1\nline2\nline3" } });

		const r = await readTool.execute({ path: "hello.txt" }, { rootDir: "/work", backend: fake });

		expect(textOf(r)).toBe("line1\nline2\nline3");
	});

	it("missing file → err with the exact ENOENT access message", async () => {
		const fake = fakeBackend({ dirs: ["/work"] });

		const r = await readTool.execute({ path: "nope.txt" }, { rootDir: "/work", backend: fake });

		expect(r.ok).toBe(false);
		if (r.ok) throw new Error("unreachable");
		expect(r.error.message).toBe("ENOENT: no such file or directory, access '/work/nope.txt'");
	});

	it("line cap: a 3000-line seed truncates at 2000 lines with the continue footer", async () => {
		const lines = Array.from({ length: 3000 }, (_, i) => `line-${i + 1}`);
		const fake = fakeBackend({ files: { "/work/big.txt": lines.join("\n") } });

		const text = textOf(await readTool.execute({ path: "big.txt" }, { rootDir: "/work", backend: fake }));

		expect(text).toContain(lines[1999]!);
		expect(text).not.toContain(`\n${lines[2000]}`); // line 2001 not in the shown window
		expect(text).toContain("[Showing lines 1-2000 of 3000. Use offset=2001 to continue.]");
	});

	it("byte cap: a >50KB seed truncates by bytes with the '(50.0KB limit)' footer", async () => {
		// 300 lines × 200 bytes = 60,299 bytes total, each line far under the 50KB
		// per-line bar, so the byte branch (not firstLineExceedsLimit) fires. Lines
		// cost 200 (first) + 201 (rest) bytes joined → exactly 254 fit under 51,200.
		const lines = Array.from({ length: 300 }, (_, i) => `${String(i).padStart(4, "0")}${"x".repeat(196)}`);
		const fake = fakeBackend({ files: { "/work/wide.txt": lines.join("\n") } });

		const text = textOf(await readTool.execute({ path: "wide.txt" }, { rootDir: "/work", backend: fake }));

		expect(text).toContain(lines[253]!);
		expect(text).not.toContain(`\n${lines[254]}`); // line 255 not in the shown window
		expect(text).toContain("[Showing lines 1-254 of 300 (50.0KB limit). Use offset=255 to continue.]");
	});

	it("image branch: a PNG-magic seed → text note + base64 image content block", async () => {
		// Detection is extension-based; the magic bytes just make the seed an honest PNG.
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		const fake = fakeBackend({ files: { "/work/pic.png": png } });

		const { note, image } = imageOf(await readTool.execute({ path: "pic.png" }, { rootDir: "/work", backend: fake }));

		expect(note.text).toBe("Read image file [image/png]");
		expect(image.mimeType).toBe("image/png");
		expect(image.data).toBe(png.toString("base64"));
	});
});
