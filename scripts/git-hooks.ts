/**
 * Runs the checks behind the hooks in `.githooks/`, which `scripts/install-hooks.ts` installs.
 * pre-commit checks formatting and lint on the staged files; pre-push runs typecheck and knip.
 * Tests stay in CI. Every check runs before the hook fails, so one run lists every violation.
 * The checks read the working tree, so a partly staged file is checked as it is on disk.
 *
 * Git runs it as `node scripts/git-hooks.ts <hook>`.
 */
import { spawnSync } from "node:child_process";

type Check = { name: string; args: string[]; fix: string };

export function preCommitChecks(staged: string[]): Check[] {
  if (staged.length === 0) return [];
  return [
    {
      name: "oxfmt",
      args: ["exec", "oxfmt", "--check", "--no-error-on-unmatched-pattern", ...staged],
      fix: "Run `pnpm format`, then stage the result.",
    },
    {
      name: "oxlint",
      args: ["exec", "oxlint", "--no-error-on-unmatched-pattern", ...staged],
      fix: "Fix the errors it lists.",
    },
  ];
}

export const prePushChecks: Check[] = [
  { name: "typecheck", args: ["run", "typecheck"], fix: "Fix the errors it lists." },
  { name: "knip", args: ["run", "knip"], fix: "Remove or use what it lists." },
];

function stagedFiles(cwd: string): string[] {
  const result = spawnSync("git", ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`git diff --cached failed: ${result.stderr.trim()}`);
  return result.stdout.split("\0").filter(Boolean);
}

function runChecks(checks: Check[], cwd: string): boolean {
  const failed: Check[] = [];
  for (const check of checks) {
    if (spawnSync("pnpm", check.args, { cwd, stdio: "inherit" }).status !== 0) failed.push(check);
  }
  for (const check of failed) console.error(`${check.name} failed. ${check.fix}`);
  return failed.length === 0;
}

export function main(
  hook: string | undefined = process.argv[2],
  cwd: string = process.cwd(),
): void {
  let checks: Check[];
  if (hook === "pre-commit") checks = preCommitChecks(stagedFiles(cwd));
  else if (hook === "pre-push") checks = prePushChecks;
  else throw new Error(`Unknown hook "${hook}"; expected pre-commit or pre-push.`);
  if (!runChecks(checks, cwd)) process.exitCode = 1;
}

if (import.meta.main) main();
