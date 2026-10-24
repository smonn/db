/**
 * Checks that the checked-out branch is a Conventional Branch, the rule CI's `check:pr` applies to a
 * PR's head branch, so a bad name fails on push instead of after the PR opens. A detached HEAD has
 * no branch name and passes.
 *
 * Run from the repo root with `pnpm check:branch`; lefthook runs it on pre-push.
 */
import { spawnSync } from "node:child_process";
import { checkBranch } from "./check-pr.ts";

type CurrentBranch = () => string;

const gitCurrentBranch: CurrentBranch = () => {
  const result = spawnSync("git", ["branch", "--show-current"], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git branch --show-current failed: ${result.stderr}`);
  return result.stdout.trim();
};

export function main(currentBranch: CurrentBranch = gitCurrentBranch): void {
  const branch = currentBranch();
  if (branch === "") return;
  const problems = checkBranch(branch);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
