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

const headsPrefix = "refs/heads/";
// docs/agents/issue-tracker.md: research notes and prototypes live on branches that never open a PR.
const throwawayPrefixes = ["research/", "prototype/"];
const zeroSha = /^0+$/u;

export function parsePushedBranches(stdin: string): string[] {
  const branches: string[] = [];
  for (const line of stdin.split("\n")) {
    const [, localSha, remoteRef] = line.trim().split(/\s+/u);
    if (localSha === undefined || remoteRef === undefined) continue;
    if (zeroSha.test(localSha) || !remoteRef.startsWith(headsPrefix)) continue;
    branches.push(remoteRef.slice(headsPrefix.length));
  }
  return branches;
}

function readStdin(): string {
  return process.stdin.isTTY ? "" : readFileSync(0, "utf8");
}

export function main(stdin: string = readStdin()): void {
  const problems = parsePushedBranches(stdin)
    .filter((branch) => !throwawayPrefixes.some((prefix) => branch.startsWith(prefix)))
    .flatMap((branch) => checkBranch(branch));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
