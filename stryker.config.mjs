import { mutateGlobs } from "./scripts/mutation-shards.ts";

export default {
  // Stryker's default plugin scan looks beside its own install, where pnpm doesn't link the runner.
  plugins: ["@stryker-mutator/vitest-runner", "./scripts/stryker-ignorer.ts"],
  ignorers: ["unreachable-in-tests"],
  testRunner: "vitest",
  // Stryker's default `threads` pool segfaults on a native module the scripts/ tests load.
  vitest: { pool: "forks" },
  mutate: mutateGlobs(),
  reporters: ["clear-text", "progress", "json"],
  coverageAnalysis: "perTest",
  // A static mutant reruns every related test, timed against the dry run's one worker. With all
  // workers sharing the runner, a full run often outlasts the default factor of 1.5, and the
  // mutant reads as a timeout though it would be killed or survive (#605).
  timeoutFactor: 3,
  // Stryker rewrites the tsconfig through the TypeScript JS API, which TypeScript 7 doesn't ship.
  // Ours has no `extends` or `references` to rewrite, so name no file.
  tsconfigFile: "",
};
