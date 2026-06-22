import { describe, expect, it } from "vitest";
import { andThen, combine, err, getOrElse, map, ok, type Result } from "./result.ts";

describe("ok", () => {
	it("wraps a value as a success", () => {
		const r = ok(2);
		expect(r).toEqual({ ok: true, value: 2 });
		expect(r.ok).toBe(true);
	});
});

describe("err", () => {
	it("wraps a value as a failure", () => {
		const e = new Error("boom");
		const r = err(e);
		expect(r).toEqual({ ok: false, error: e });
		expect(r.ok).toBe(false);
	});
});

describe("map", () => {
	it("transforms a success value (spec acceptance: map(ok(2)) → ok(3))", () => {
		expect(map(ok(2), (x) => x + 1)).toEqual(ok(3));
	});

	it("leaves a failure untouched (short-circuits on err)", () => {
		const e = new Error("boom");
		expect(map(err(e), (x: number) => x + 1)).toEqual(err(e));
	});
});

describe("andThen", () => {
	it("chains a Result-returning function on success", () => {
		const r = andThen(ok(2), (x) => ok(x.toString()));
		expect(r).toEqual(ok("2"));
	});

	it("propagates a chained failure", () => {
		const e = new Error("downstream");
		expect(andThen(ok(2), () => err(e))).toEqual(err(e));
	});

	it("short-circuits on err without calling the function (spec acceptance)", () => {
		const e = new Error("boom");
		let called = false;
		const r = andThen(err(e), () => {
			called = true;
			return ok(99);
		});
		expect(r).toEqual(err(e));
		expect(called).toBe(false);
	});
});

describe("getOrElse", () => {
	it("returns the success value", () => {
		expect(getOrElse(ok(7), 0)).toBe(7);
	});

	it("returns the fallback on failure", () => {
		expect(getOrElse(err(new Error("x")), 0)).toBe(0);
	});
});

describe("combine", () => {
	it("collects all successes into an array (success propagation)", () => {
		expect(combine([ok(1), ok(2), ok(3)])).toEqual(ok([1, 2, 3]));
	});

	it("short-circuits on the first err (spec acceptance)", () => {
		const e = new Error("middle");
		expect(combine([ok(1), err(e), ok(3)])).toEqual(err(e));
	});

	it("returns the verbatim err without touching later elements", () => {
		const e = new Error("first");
		const later: Result<number, Error>[] = [ok(999)];
		const result = combine([err(e), ...later]);
		expect(result).toEqual(err(e));
	});

	it("yields ok([]) for an empty list", () => {
		expect(combine([])).toEqual(ok([]));
	});
});
