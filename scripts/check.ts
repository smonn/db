/**
 * Runs every check CI runs, in sequence, so a contributor or agent needn't hand-write a loop.
 * Keeps going after a failure, then lists the failed scripts and exits non-zero if any failed.
 * Leaves out `check:pr` (needs a PR title and branch) and `check:issue`, `check:labels`, `check:parent`, and
 * `clear:review` (each needs an event payload).
 *
 * Run from the repo root with `pnpm check`. Like `pnpm coverage`, it needs the test database:
 * run `node scripts/test-db.ts` first, or it fails `coverage` with that hint instead of running it.
 * When a CI job gains a step, add its script here.
 * `pnpm check:static` (`--static`) skips `coverage`, so it needs no database; pre-push runs it.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

// Same lookup as vitest.config.ts: CI sets DATABASE_URL, scripts/test-db.ts writes .env.test.
const hasTestDatabase = (): boolean =>
  process.env["DATABASE_URL"] !== undefined ||
  existsSync(fileURLToPath(new URL("../.env.test", import.meta.url)));

export function main(
  run: Run = runScript,
  args: readonly string[] = process.argv.slice(2),
  hasDatabase: () => boolean = hasTestDatabase,
): void {
  const unknown = args.filter((arg) => arg !== "--static");
  if (unknown.length > 0)
    throw new Error(`Unknown argument "${unknown.join(" ")}"; expected --static.`);
  const scripts = args.includes("--static")
    ? checks.filter((script) => script !== "coverage")
    : checks;
  const failed = runChecks(scripts, (script) => {
    if (script !== "coverage" || hasDatabase()) return run(script);
    console.error("Skipped: no test database. Run `node scripts/test-db.ts`, or set DATABASE_URL.");
    return false;
  });
  if (failed.length === 0) {
    console.log(`\nAll ${scripts.length} checks passed`);
    return;
  }
  console.error(`\n${failed.length} of ${scripts.length} checks failed: ${failed.join(", ")}`);
  if (failed.includes("format:check")) console.error("Run `pnpm run format` to fix formatting.");
  process.exitCode = 1;
}

if (import.meta.main) main();
