import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10000,
	},
	resolve: {
		alias: {
			"trusted-agents-core": path.resolve(import.meta.dirname, "../core/src/index.ts"),
		},
	},
});
