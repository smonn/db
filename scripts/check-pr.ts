/**
 * Checks that a pull request title is a Conventional Commit, since release-please builds releases
 * from squash-merged titles (ADR-0018), and that its head branch is a Conventional Branch.
 *
 * Run with `PR_TITLE` and `PR_BRANCH` set, as `pnpm check:pr`; CI runs it in the Metadata job (`.github/workflows/pr.yml`).
 * `check-branch.ts` applies the branch rule to the checked-out branch before a push.
 */

const types = [
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
];
const titlePattern = new RegExp(`^(${types.join("|")})(\\([a-z0-9-]+\\))?!?: \\S`, "u");

const branchPattern = /^(feature|bugfix|hotfix|release|chore)\/[a-z0-9]+([.-][a-z0-9]+)*$/u;
const botBranchPrefixes = ["renovate/", "release-please--"];

export function checkBranch(branch: string): string[] {
  const isBot = botBranchPrefixes.some((prefix) => branch.startsWith(prefix));
  if (isBot || branchPattern.test(branch)) return [];
  return [
    `Branch "${branch}" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>`,
  ];
}

export function checkPr(title: string, branch: string): string[] {
  const problems: string[] = [];
  if (!titlePattern.test(title)) {
    problems.push(`PR title "${title}" is not a Conventional Commit: type(scope): summary`);
  }
  problems.push(...checkBranch(branch));
  return problems;
}

export function main(env: NodeJS.ProcessEnv = process.env): void {
  const { PR_TITLE: title, PR_BRANCH: branch } = env;
  if (title === undefined || branch === undefined) {
    console.error("Set PR_TITLE and PR_BRANCH");
    process.exitCode = 1;
    return;
  }
  const problems = checkPr(title, branch);
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
