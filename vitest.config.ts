import { globSync, readFileSync } from "node:fs";
import { defineConfig, type ViteUserConfig } from "vitest/config";
import { testEnv } from "./scripts/test-database-url.ts";

// A test file that imports useTestDatabase runs against Postgres, which slows down when several
// worktrees run their own test databases at once (#191).
const usesDatabase = /^(?:import .*|\}) from ".*\/test-database\.test-helper\.ts";$/mu;
// A test that packs the package builds the source, and Stryker's mutated source fails
// isolatedDeclarations, so Stryker's workers skip those tests.
const packs = /^(?:import .*|\}) from ".*\/packed-package\.test-helper\.ts";$/mu;
const underStryker = process.env["STRYKER_MUTATOR_WORKER"] !== undefined;
const read = (file: string): string => readFileSync(new URL(file, import.meta.url), "utf8");
const testFiles = globSync("{src,scripts}/**/*.test.ts", { cwd: import.meta.dirname }).filter(
  (file) => !(underStryker && packs.test(read(file))),
);
const databaseTests = testFiles.filter((file) => usesDatabase.test(read(file)));

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
        // Under Stryker's bail a static mutant reruns its related tests until one fails, and Vitest
        // would run the database project first, by name. Unit tests kill most of those mutants in
        // seconds, so they go first (#605).
        test: {
          name: "unit",
          include: testFiles,
          exclude: databaseTests,
          sequence: { groupOrder: underStryker ? 1 : 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "database",
          include: databaseTests,
          testTimeout: 30_000,
          hookTimeout: 30_000,
          sequence: { groupOrder: underStryker ? 2 : 0 },
        },
      },
    ],
  },
});

export default config;
