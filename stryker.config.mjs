import { mutateGlobs } from "./scripts/mutation-shards.ts";

export default {
  // Stryker's default plugin scan looks beside its own install, where pnpm doesn't link the runner.
  plugins: ["@stryker-mutator/vitest-runner"],
  testRunner: "vitest",
  // Stryker's default `threads` pool segfaults on a native module the scripts/ tests load.
  vitest: { pool: "forks" },
  mutate: mutateGlobs(),
  reporters: ["clear-text", "progress", "json"],
  coverageAnalysis: "perTest",
  // Stryker rewrites the tsconfig through the TypeScript JS API, which TypeScript 7 doesn't ship.
  // Ours has no `extends` or `references` to rewrite, so name no file.
  tsconfigFile: "",
};
