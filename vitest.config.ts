import { defineConfig } from "vitest/config";

// Hermetic-trio include (spec 15): Tier-0 units co-located next to source
// (src/**/*.test.ts) + Tier-1 in-process MCP / Tier-2 boot E2E under
// test/e2e-hermetic/**. Containerized tiers (test/compose/**) run out-of-band
// via `docker compose`, never loaded here — so the trio stays Node-only.
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts", "test/e2e-hermetic/**/*.test.ts"],
	},
});
