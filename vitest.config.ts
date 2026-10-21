import { defineConfig, type ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-helper.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});

export default config;
