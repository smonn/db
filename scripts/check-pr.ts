/**
 * Checks that a pull request title is a Conventional Commit, since release-please builds releases
 * from squash-merged titles (ADR-0018), and that its head branch is a Conventional Branch. A
 * `docs(adr): propose ...` title must not change an ADR to `status: accepted`, and a
 * `docs(adr): accept ...` title needs every changed ADR to be accepted.
 *
 * Run with `PR_TITLE` and `PR_BRANCH` set, as `pnpm check:pr`; CI runs it in the Metadata job (`.github/workflows/pr.yml`).
 * Set `PR_DIFF_BASE` to a git revision (CI uses `HEAD^1`, the base side of the merge commit) to
 * also check the ADRs the PR changes; without it the ADR check is skipped.
 * `check-branch.ts` applies the branch rule to the checked-out branch before a push.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

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

const adrTitlePattern = /^docs\(adr\)!?: (propose|accept)\b/u;
const adrPathPattern = /^docs\/adr\/\d{4}-.+\.md$/u;
const frontmatterPattern = /^---\n([\s\S]*?)\n---/u;
const statusPattern = /^status:\s*(\S+)\s*$/mu;

const branchPattern = /^(feature|bugfix|hotfix|release|chore)\/[a-z0-9]+([.-][a-z0-9]+)*$/u;
const botBranchPrefixes = ["renovate/", "release-please--"];

export type ChangedAdr = { file: string; status: string };

export function checkBranch(branch: string): string[] {
  const isBot = botBranchPrefixes.some((prefix) => branch.startsWith(prefix));
  if (isBot || branchPattern.test(branch)) return [];
  return [
    `Branch "${branch}" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>`,
  ];
}

export function parseAdrStatus(text: string): string {
  const frontmatter = frontmatterPattern.exec(text)?.[1] ?? "";
  return statusPattern.exec(frontmatter)?.[1] ?? "missing";
}

export function checkAdrTitle(title: string, adrs: readonly ChangedAdr[]): string[] {
  const verb = adrTitlePattern.exec(title)?.[1];
  if (verb === "propose") {
    return adrs
      .filter((adr) => adr.status === "accepted")
      .map((adr) => `PR title says "propose" but ${adr.file} has status: ${adr.status}`);
  }
  if (verb === "accept") {
    return adrs
      .filter((adr) => adr.status !== "accepted")
      .map((adr) => `PR title says "accept" but ${adr.file} has status: ${adr.status}`);
  }
  return [];
}

export function checkPr(title: string, branch: string, adrs: readonly ChangedAdr[] = []): string[] {
  const problems: string[] = [];
  if (!titlePattern.test(title)) {
    problems.push(`PR title "${title}" is not a Conventional Commit: type(scope): summary`);
  }
  problems.push(...checkBranch(branch), ...checkAdrTitle(title, adrs));
  return problems;
}

export function readChangedAdrs(base: string, cwd: string = process.cwd()): ChangedAdr[] {
  const diff = execFileSync("git", ["diff", "--name-only", "--diff-filter=d", base, "HEAD"], {
    cwd,
    encoding: "utf8",
  });
  return diff
    .split("\n")
    .filter((file) => adrPathPattern.test(file))
    .map((file) => ({ file, status: parseAdrStatus(readFileSync(join(cwd, file), "utf8")) }));
}

export function main(
  env: NodeJS.ProcessEnv = process.env,
  readAdrs: (base: string) => ChangedAdr[] = readChangedAdrs,
): void {
  const { PR_TITLE: title, PR_BRANCH: branch, PR_DIFF_BASE: base } = env;
  if (title === undefined || branch === undefined) {
    console.error("Set PR_TITLE and PR_BRANCH");
    process.exitCode = 1;
    return;
  }
  const problems = checkPr(title, branch, base === undefined ? [] : readAdrs(base));
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

if (import.meta.main) main();
