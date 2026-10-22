import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { defineConfig, type ViteUserConfig } from "vitest/config";

// scripts/test-db.ts writes .env.test; CI sets DATABASE_URL itself.
const envFile = fileURLToPath(new URL(".env.test", import.meta.url));
const env =
  process.env["DATABASE_URL"] === undefined && existsSync(envFile)
    ? parseEnv(readFileSync(envFile, "utf8"))
    : {};

const config: ViteUserConfig = defineConfig({
  test: {
    env,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "scripts/**/*.ts"],
      exclude: ["**/*.test.ts", "**/*.test-helper.ts"],
      thresholds: { lines: 90, statements: 90, functions: 90, branches: 90 },
    },
  },
});

export default config;
