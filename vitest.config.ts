import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		pool: "forks",
		typecheck: {
			enabled: true,
			include: ["test/**/*.test-d.ts"],
			tsconfig: "./tsconfig.test.json",
		},
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts", "src/index.ts", "src/types.ts"],
			thresholds: {
				lines: 90,
				functions: 90,
				branches: 85,
				statements: 90,
			},
			reporter: ["text", "html"],
		},
	},
});
