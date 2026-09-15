import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"trusted-agents-core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
			"trusted-agents-sdk": fileURLToPath(new URL("../sdk/src/index.ts", import.meta.url)),
			"trusted-agents-tapd": fileURLToPath(new URL("../tapd/src/index.ts", import.meta.url)),
		},
	},
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		testTimeout: 10000,
	},
});
