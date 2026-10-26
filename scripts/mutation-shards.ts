/**
 * Splits Stryker's run into the shards the Mutation workflow's matrix runs in parallel, since one
 * runner takes hours over all of `src/` and `scripts/`. `stryker.config.mjs` reads the shard from
 * `MUTATION_SHARD` and mutates every shard when it is unset.
 */

export const SHARDS: Record<string, string[]> = {
  diff: ["src/dev/diff/**/*.ts", "src/dev/generate/**/*.ts"],
  dev: ["src/dev/*.ts", "src/dev/{catalog,cli,config,introspect,shadow}/**/*.ts"],
  runtime: ["src/runtime/**/*.ts", "src/adapters/**/*.ts"],
  scripts: ["scripts/**/*.ts"],
};

export const EXCLUDE: string[] = [
  "!**/*.test.ts",
  "!**/*.test-helper.ts",
  // Its test reads the file's text for the action pins Renovate bumps, which instrumenting breaks.
  "!scripts/check-oidc-jobs.ts",
];

export function mutateGlobs(env: NodeJS.ProcessEnv = process.env): string[] {
  const { MUTATION_SHARD: shard } = env;
  if (shard === undefined || shard === "") return [...Object.values(SHARDS).flat(), ...EXCLUDE];
  const globs = SHARDS[shard];
  if (globs === undefined) {
    throw new Error(
      `Unknown MUTATION_SHARD "${shard}"; expected one of ${Object.keys(SHARDS).join(", ")}`,
    );
  }
  return [...globs, ...EXCLUDE];
}
