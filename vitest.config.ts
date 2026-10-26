import { globSync, readFileSync } from "node:fs";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { testEnv } from "./scripts/test-database-url.ts";

// A test file that imports useTestDatabase runs against Postgres, which slows down when several
// worktrees run their own test databases at once (#191).
const usesDatabase = /^(?:import .*|\}) from ".*\/test-database\.test-helper\.ts";$/mu;
const testFiles = globSync("{src,scripts}/**/*.test.ts", { cwd: import.meta.dirname });
const databaseTests = testFiles.filter((file) =>
  usesDatabase.test(readFileSync(new URL(file, import.meta.url), "utf8")),
);

const config: ViteUserConfig = defineConfig({
  test: {
    env: testEnv(),
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-helper.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
    projects: [
      {
        extends: true,
        test: { name: "unit", include: testFiles, exclude: databaseTests },
      },
      {
        extends: true,
        test: {
          name: "database",
          include: databaseTests,
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});

export default config;
