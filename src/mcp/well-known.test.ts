import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerWellKnown } from "./well-known.ts";

const BASE_URL = "http://127.0.0.1:3000";

/** Minimal Fastify with only the well-known route registered. */
async function buildApp(baseUrl = BASE_URL): Promise<FastifyInstance> {
	const app = Fastify({ logger: false });
	registerWellKnown(app, baseUrl);
	await app.ready();
	return app;
}

describe("registerWellKnown", () => {
	let app: FastifyInstance;

	beforeEach(async () => {
		app = await buildApp();
	});

	afterEach(async () => {
		await app.close();
	});

	it("responds 200 with the resource URL + bearer_methods", async () => {
		const res = await app.inject({ method: "GET", url: "/.well-known/oauth-protected-resource" });

		expect(res.statusCode).toBe(200);
		expect(JSON.parse(res.body)).toEqual({
			resource: `${BASE_URL}/mcp`,
			bearer_methods: ["header"],
		});
	});

	it("is reachable without an Authorization header (discovery precedes auth)", async () => {
		// The well-known pointer must be reachable pre-auth: a client has no other
		// way to learn the bearer requirement. No 401 even with no Authorization.
		const res = await app.inject({
			method: "GET",
			url: "/.well-known/oauth-protected-resource",
			// deliberately no Authorization header
		});

		expect(res.statusCode).toBe(200);
	});

	it("derives the resource URL from a custom baseUrl (tunnel-shaped)", async () => {
		const custom = await buildApp("https://tunnel.example:9999");
		try {
			const res = await custom.inject({
				method: "GET",
				url: "/.well-known/oauth-protected-resource",
			});

			expect(JSON.parse(res.body)).toEqual({
				resource: "https://tunnel.example:9999/mcp",
				bearer_methods: ["header"],
			});
		} finally {
			await custom.close();
		}
	});
});
