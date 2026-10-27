/**
 * Swaps each `Stryker disable` comment in the files Stryker mutates for an inert marker on the same
 * line (`stryker-directive.ts`), so the weekly Mutation run tests the mutants those comments hide
 * and `mutation-report.ts` can list a comment that no longer hides a surviving mutant.
 *
 * It rewrites files in place, so run it only in a throwaway checkout: the Mutation workflow runs
 * `pnpm mutation:mark` before `pnpm mutation`, with the same `MUTATION_SHARD`.
 */
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { mutateGlobs } from "./mutation-shards.ts";
import { markDisables } from "./stryker-directive.ts";

/**
 * The files Stryker's `mutate` globs name, relative to `cwd`; a `!` glob excludes. Node's glob
 * reads a leading `!` literally, so a `!` glob left among the patterns matches nothing.
 */
export function mutatedFiles(globs: string[], cwd: string): string[] {
  const exclude = globs.filter((glob) => glob.startsWith("!")).map((glob) => glob.slice(1));
  return globSync(globs, { cwd, exclude }).toSorted();
}

export function main(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): void {
  const marked = mutatedFiles(mutateGlobs(env), cwd).filter((file) => {
    const path = join(cwd, file);
    const text = readFileSync(path, "utf8");
    const rewritten = markDisables(text);
    if (rewritten === text) return false;
    writeFileSync(path, rewritten);
    return true;
  });
  console.log(`Marked the Stryker disable comments in ${marked.length} files`);
  for (const file of marked) console.log(`  ${file}`);
}

if (import.meta.main) main();
