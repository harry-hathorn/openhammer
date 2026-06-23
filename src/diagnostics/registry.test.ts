import { afterEach, describe, expect, it } from "vitest";
import {
	DIAGNOSTICS,
	type DiagnosticCheck,
	getDiagnostics,
	registerDiagnostic,
	unregisterDiagnostic,
} from "./registry.ts";

/** Build a fake check whose `run` resolves to the given status + message. */
function fakeCheck(id: string, status: "pass" | "warn" | "fail" = "pass", message = `${id} ok`): DiagnosticCheck {
	return { id, run: async () => ({ status, message }) };
}

/** Restore the registry to empty after each test (the global array is module-shared within this file). */
afterEach(() => {
	DIAGNOSTICS.length = 0;
});

describe("diagnostics registry", () => {
	it("getDiagnostics returns an empty array for a fresh registry", () => {
		expect(getDiagnostics()).toEqual([]);
	});

	it("registerDiagnostic appends a check and getDiagnostics returns it", async () => {
		const check = fakeCheck("a");
		registerDiagnostic(check);
		expect(getDiagnostics()).toEqual([check]);
		const [report] = await Promise.all([check.run()]);
		expect(report).toEqual({ status: "pass", message: "a ok" });
	});

	it("getDiagnostics returns a copy — mutating the result does not change the registry", () => {
		registerDiagnostic(fakeCheck("a"));
		const result = getDiagnostics();
		result.push(fakeCheck("intruder"));
		expect(getDiagnostics()).toHaveLength(1);
		expect(getDiagnostics()[0]?.id).toBe("a");
	});

	it("registerDiagnostic replaces a check with the same id (last-wins), preserving position", () => {
		registerDiagnostic(fakeCheck("a"));
		registerDiagnostic(fakeCheck("b"));
		registerDiagnostic(fakeCheck("c"));
		const replacement = fakeCheck("b", "fail", "b replaced");
		registerDiagnostic(replacement);
		const ids = getDiagnostics().map((c) => c.id);
		expect(ids).toEqual(["a", "b", "c"]); // b kept its first-insert position
		const b = getDiagnostics().find((c) => c.id === "b");
		expect(b).toBe(replacement);
	});

	it("unregisterDiagnostic removes a check by id", () => {
		registerDiagnostic(fakeCheck("a"));
		registerDiagnostic(fakeCheck("b"));
		unregisterDiagnostic("a");
		expect(getDiagnostics().map((c) => c.id)).toEqual(["b"]);
	});

	it("unregisterDiagnostic is a no-op for an unknown id", () => {
		registerDiagnostic(fakeCheck("a"));
		unregisterDiagnostic("nope");
		expect(getDiagnostics().map((c) => c.id)).toEqual(["a"]);
	});

	it("preserves insertion order across register/unregister", () => {
		registerDiagnostic(fakeCheck("config"));
		registerDiagnostic(fakeCheck("credentials"));
		registerDiagnostic(fakeCheck("rg"));
		unregisterDiagnostic("credentials");
		registerDiagnostic(fakeCheck("fd"));
		expect(getDiagnostics().map((c) => c.id)).toEqual(["config", "rg", "fd"]);
	});
});
