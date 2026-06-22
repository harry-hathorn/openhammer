import { defineConfig } from "vitest/config";

// Tier-0 unit tests are co-located next to their source (src/**/*.test.ts).
// T-harness extends `include` with the in-process/boot E2E suite under test/e2e-hermetic/**.
export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
	},
});
