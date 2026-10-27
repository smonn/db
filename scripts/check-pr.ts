/**
 * Checks that a pull request title is a Conventional Commit, since release-please builds releases
 * from squash-merged titles (ADR-0018), and that its head branch is a Conventional Branch. A
 * `docs(adr): propose ...` title must not add or change an ADR to `status: accepted`, and a
 * `docs(adr): accept ...` title must not add or change one to `proposed` and needs one to become
 * accepted. An ADR whose status the PR leaves as it was on the base is not judged. An ADR the PR adds must not
 * share its number with one another open PR adds (docs/adr/TEMPLATE.md numbers one past the highest
 * on `main` or in an open PR, and nothing else catches a clash before the second merge).
 *
 * A closing keyword in `PR_BODY` must not name an issue outside `smonn/db` (`check-closing-keywords.ts`).
 *
 * Run with `PR_TITLE` and `PR_BRANCH` set, as `pnpm check:pr`; CI runs it in the Metadata job (`.github/workflows/pr.yml`).
 * Set `PR_DIFF_BASE` to a git revision (CI uses `HEAD^1`, the base side of the merge commit) to
 * also check the ADRs the PR changes; without it the ADR check is skipped. Set `PR_NUMBER` as well
 * to compare the ADRs it adds with those other open PRs add, read through `gh` (needs `GH_TOKEN`
 * and `GH_REPO` in CI).
 * `check-branch.ts` applies the branch rule to the checked-out branch before a push.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checkClosingKeywords } from "./check-closing-keywords.ts";
import { checkAdrClash, readOpenPrAdds, type OpenPrAdd } from "./check-adr-clash.ts";

const titlePattern =
  /^(build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(\([a-z0-9-]+\))?!?: \S/u;

const adrTitlePattern = /^docs\(adr\)!?: (propose|accept)\b/u;
const adrPathPattern = /^docs\/adr\/\d{4}-.+\.md$/u;
const frontmatterPattern = /^---\n([\s\S]*?)\n---/u;
const statusPattern = /^status:\s*(\S+)\s*$/mu;

const branchPattern = /^(feature|bugfix|hotfix|release|chore)\/[a-z0-9]+([.-][a-z0-9]+)*$/u;
const botBranchPrefixes = ["renovate/", "release-please--"];

/** `baseStatus` is the status on the diff base, absent for an ADR the PR adds. */
export type ChangedAdr = { file: string; status: string; added: boolean; baseStatus?: string };

export function checkBranch(branch: string): string[] {
  const isBot = botBranchPrefixes.some((prefix) => branch.startsWith(prefix));
  if (isBot || branchPattern.test(branch)) return [];
  return [
    `Branch "${branch}" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>`,
  ];
}

export function parseAdrStatus(text: string): string {
  return frontmatterPattern.exec(text)?.[1]?.match(statusPattern)?.[1] ?? "missing";
}

export function checkAdrTitle(title: string, adrs: readonly ChangedAdr[]): string[] {
  const verb = adrTitlePattern.exec(title)?.[1];
  if (verb === undefined) return [];
  const changed = adrs.filter((adr) => adr.added || adr.baseStatus !== adr.status);
  const wrong = verb === "propose" ? "accepted" : "proposed";
  const problems = changed
    .filter((adr) => adr.status === wrong)
    .map((adr) => `PR title says "${verb}" but ${adr.file} has status: ${adr.status}`);
  if (verb === "accept" && !changed.some((adr) => adr.status === "accepted")) {
    problems.push('PR title says "accept" but no ADR became accepted');
  }
  return problems;
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
  // Without rename detection, a renamed ADR is one added file, so it counts as added.
  const diff = execFileSync(
    "git",
    ["diff", "--name-status", "--no-renames", "--diff-filter=d", base, "HEAD"],
    { cwd, encoding: "utf8" },
  );
  return diff.split("\n").flatMap((line): ChangedAdr[] => {
    const tab = line.indexOf("\t");
    const file = line.slice(tab + 1);
    if (!adrPathPattern.test(file)) return [];
    const status = parseAdrStatus(readFileSync(join(cwd, file), "utf8"));
    const baseStatus = line.slice(0, tab) === "A" ? undefined : readBaseStatus(base, file, cwd);
    if (baseStatus === undefined) return [{ file, status, added: true }];
    return [{ file, status, added: false, baseStatus }];
  });
}

// git show's wording when the path is absent on the base ref.
const missingPathPattern = /path '.*' (does not exist in|exists on disk, but not in) '/u;

// A file the base lacks (any status but M can leave one) counts as added.
// Any other git failure propagates rather than reading as "added".
function readBaseStatus(base: string, file: string, cwd: string): string | undefined {
  try {
    return parseAdrStatus(
      execFileSync("git", ["show", `${base}:${file}`], { cwd, encoding: "utf8" }),
    );
  } catch (error) {
    if (error instanceof Error && missingPathPattern.test(error.message)) return undefined;
    throw error;
  }
}

function clashProblems(
  adrs: readonly ChangedAdr[],
  number: string | undefined,
  readOpenAdds: (exclude: string) => OpenPrAdd[],
): string[] {
  if (number === undefined || !adrs.some((adr) => adr.added)) return [];
  return checkAdrClash(adrs, readOpenAdds(number));
}

function report(problems: readonly string[]): void {
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) process.exitCode = 1;
}

function allProblems(
  env: NodeJS.ProcessEnv,
  { title, branch }: { title: string; branch: string },
  readAdrs: (base: string) => ChangedAdr[],
  readOpenAdds: (exclude: string) => OpenPrAdd[],
): string[] {
  const { PR_DIFF_BASE: base, PR_NUMBER: number, PR_BODY: body } = env;
  const adrs = base === undefined ? [] : readAdrs(base);
  return [
    ...checkPr(title, branch, adrs),
    ...checkClosingKeywords(body ?? ""),
    ...clashProblems(adrs, number, readOpenAdds),
  ];
}

export function main(
  env: NodeJS.ProcessEnv = process.env,
  readAdrs: (base: string) => ChangedAdr[] = readChangedAdrs,
  readOpenAdds: (exclude: string) => OpenPrAdd[] = readOpenPrAdds,
): void {
  const { PR_TITLE: title, PR_BRANCH: branch } = env;
  if (title === undefined || branch === undefined) {
    console.error("Set PR_TITLE and PR_BRANCH");
    process.exitCode = 1;
    return;
  }
  report(allProblems(env, { title, branch }, readAdrs, readOpenAdds));
}

if (import.meta.main) main();
