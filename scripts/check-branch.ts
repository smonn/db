/**
 * Checks that every branch a push creates or updates is a Conventional Branch, the rule CI's
 * `check:pr` applies to a PR's head branch, so a bad name fails on push instead of after the PR
 * opens. Reads git's pre-push stdin (`<local ref> <local sha> <remote ref> <remote sha>` per line).
 * A delete and a ref outside `refs/heads/` (a tag) pass, so a bad branch can still be deleted. A
 * `research/` or `prototype/` branch passes too; `check:pr` still refuses one as a PR head.
 *
 * Run by lefthook on pre-push (`use_stdin`); `pnpm check:branch` by hand has no stdin and passes.
 */
import { readFileSync } from "node:fs";
import { checkBranch } from "./check-pr.ts";

// `<local ref> <local sha> refs/heads/<branch> <remote sha>`, where an all-zero local sha is a delete.
const pushedBranchPattern = /^\S+\s+(?!0+\s)\S+\s+refs\/heads\/(\S+)\s+\S+$/u;
// Pushed but never opened as a PR: research notes (docs/agents/issue-tracker.md) and prototypes
// (the prototype skill).
const throwawayPattern = /^(research|prototype)\/[a-z0-9]+([.-][a-z0-9]+)*$/u;

export function parsePushedBranches(stdin: string): string[] {
  return stdin.split("\n").flatMap((line) => {
    const branch = pushedBranchPattern.exec(line.trim())?.[1];
    return branch === undefined ? [] : [branch];
  });
}

function readStdin(): string {
  // Stryker disable next-line StringLiteral: no other text parses as a pushed branch either, so a mutated empty string is indistinguishable.
  if (process.stdin.isTTY) return "";
  return readFileSync(0, "utf8");
}

export function main(stdin: string = readStdin()): void {
  const problems = parsePushedBranches(stdin)
    .filter((branch) => !throwawayPattern.test(branch))
    .flatMap((branch) => checkBranch(branch));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
