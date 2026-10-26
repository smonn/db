/**
 * Runs every check CI runs, in sequence, so a contributor or agent needn't hand-write a loop.
 * Keeps going after a failure, then lists the failed scripts and exits non-zero if any failed.
 * Leaves out `check:pr` (needs a PR title and branch) and `check:issue`, `check:labels`, `check:parent`, and
 * `clear:review` (each needs an event payload).
 *
 * Run from the repo root with `pnpm check`. Like `pnpm coverage`, it needs a reachable test database:
 * run `node scripts/test-db.ts` first, or it fails `coverage` with that hint instead of running it.
 * It never starts Postgres itself.
 * When a CI job gains a step, add its script here.
 * `pnpm check:static` (`--static`) skips `coverage`, so it needs no database; pre-push runs it.
 */
import { spawnSync } from "node:child_process";
import { isReachable, testDatabaseUrl } from "./test-database-url.ts";

export const checks = [
  "format:check",
  "check:docs",
  "check:mermaid",
  "check:node-version",
  "check:oidc",
  "typecheck",
  "lint",
  "lint:actions",
  "check:imports",
  "check:index",
  "knip",
  "deps",
  "fta",
  "coverage",
] as const;

type Run = (script: string) => boolean;

const runScript: Run = (script) =>
  spawnSync("pnpm", ["run", script], { stdio: "inherit" }).status === 0;

export function runChecks(scripts: readonly string[], run: Run = runScript): string[] {
  return scripts.filter((script) => {
    console.log(`\n> pnpm run ${script}`);
    return !run(script);
  });
}

const noDatabaseHint =
  "No test database is reachable. Run `node scripts/test-db.ts` to start one, or set DATABASE_URL.";

// Same lookup as vitest.config.ts; a stale .env.test (its server gone) counts as missing.
const hasTestDatabase = async (): Promise<boolean> => {
  const url = testDatabaseUrl();
  return url !== undefined && (await isReachable(url));
};

export async function main(
  run: Run = runScript,
  args: readonly string[] = process.argv.slice(2),
  hasDatabase: () => Promise<boolean> = hasTestDatabase,
): Promise<void> {
  const unknown = args.filter((arg) => arg !== "--static");
  if (unknown.length > 0)
    throw new Error(`Unknown argument "${unknown.join(" ")}"; expected --static.`);
  const scripts: readonly string[] = args.includes("--static")
    ? checks.filter((script) => script !== "coverage")
    : checks;
  const databaseMissing = scripts.includes("coverage") && !(await hasDatabase());
  const failed = runChecks(scripts, (script) => {
    if (script !== "coverage" || !databaseMissing) return run(script);
    console.error("Skipped: no reachable test database.");
    return false;
  });
  if (failed.length === 0) {
    console.log(`\nAll ${scripts.length} checks passed`);
    return;
  }
  console.error(`\n${failed.length} of ${scripts.length} checks failed: ${failed.join(", ")}`);
  if (failed.includes("format:check")) console.error("Run `pnpm run format` to fix formatting.");
  if (databaseMissing) console.error(noDatabaseHint);
  process.exitCode = 1;
}

if (import.meta.main) await main();
