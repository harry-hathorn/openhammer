import { describe, expect, it } from "vitest";
import { listenErrorMessage } from "./main.ts";

/** Build a Node-shaped errno error (an `Error` carrying a string `code`). */
function errnoError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code });
}

describe("listenErrorMessage", () => {
	it("maps EADDRINUSE to an actionable message naming the port and host", () => {
		const error = errnoError("listen EADDRINUSE: address already in use", "EADDRINUSE");
		const message = listenErrorMessage(error, 3000, "127.0.0.1");
		expect(message).toContain("3000");
		expect(message).toContain("127.0.0.1");
		expect(message).toContain("PORT=");
	});

	it("maps EACCES to a privileged-port hint", () => {
		const error = errnoError("listen EACCES: permission denied", "EACCES");
		const message = listenErrorMessage(error, 80, "0.0.0.0");
		expect(message).toContain("80");
		expect(message).toContain(">=1024");
	});

	it("returns undefined for other error codes (left for main to rethrow verbatim)", () => {
		const refused = errnoError("connect failed", "ECONNREFUSED");
		expect(listenErrorMessage(refused, 3000, "127.0.0.1")).toBeUndefined();
		expect(listenErrorMessage(new Error("no code here"), 3000, "127.0.0.1")).toBeUndefined();
	});

	it("returns undefined for non-Error throws", () => {
		expect(listenErrorMessage("nope", 3000, "127.0.0.1")).toBeUndefined();
		expect(listenErrorMessage(null, 3000, "127.0.0.1")).toBeUndefined();
		expect(listenErrorMessage(undefined, 3000, "127.0.0.1")).toBeUndefined();
	});
});
