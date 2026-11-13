/**
 * Runs the PR's version of each repo check it changes over a live sample, so a check that breaks on
 * input a hand-built fixture never held fails the PR instead of a later run (#807: #307, #403, #471).
 * Report-only: a check that writes to GitHub (a comment, a label) is handed a `gh` that records the
 * write and sends nothing, and the workflow's token can only read.
 *
 * A sample the check refuses is listed in the job summary for the reviewer to judge; the job still
 * passes. A check that throws on a sample fails the job. The samples: open issues for the issue
 * checks, the last merged pull requests for `check:pr`, remote branch names for `check:branch`,
 * and the workflow files for `check:oidc`.
 *
 * Run as `pnpm check:live` in the checkout of a pull request's merge commit with `GITHUB_REPOSITORY`
 * and `GH_TOKEN` set: it diffs `PR_DIFF_BASE` (default `HEAD^1`, the base) against `HEAD` to choose
 * the checks. It writes to the file `GITHUB_STEP_SUMMARY` names, or to stdout when that is unset.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { ISSUE_CHECKS } from "./live-input-issues.ts";
import { runProbe, type Check, type Outcome, type Result } from "./live-input-probe.ts";
import { REPO_CHECKS } from "./live-input-repo.ts";
import { realSource, type Source } from "./live-input-source.ts";

export const CHECKS: Check[] = ISSUE_CHECKS.concat(REPO_CHECKS);

/** A change to the runner or its workflow can break any check's run, so it selects them all. */
export const RUNNER_FILES: string[] = [
  ".github/workflows/live-input-checks.yml",
  "scripts/live-input-checks.ts",
  "scripts/live-input-issues.ts",
  "scripts/live-input-probe.ts",
  "scripts/live-input-repo.ts",
  "scripts/live-input-source.ts",
];

export function selectChecks(
  changed: readonly string[],
  checks: readonly Check[] = CHECKS,
): Check[] {
  if (changed.some((file) => RUNNER_FILES.includes(file))) return [...checks];
  return checks.filter((check) => check.files.some((file) => changed.includes(file)));
}

const MAX_LISTED = 100;

function listing(heading: string, results: Result[]): string[] {
  if (results.length === 0) return [];
  const shown = results
    .slice(0, MAX_LISTED)
    .flatMap(({ check, sample, lines }) =>
      [`- \`${check}\` on ${sample}`].concat(lines.map((line) => `  - ${line}`)),
    );
  const hidden = results.length - MAX_LISTED;
  const more = hidden > 0 ? ["", `${hidden} more not shown.`] : [];
  return ["", `### ${heading} (${results.length})`, "", ...shown, ...more];
}

function countRow(name: string, results: readonly Result[]): string {
  const own = results.filter((result) => result.check === name);
  const count = (outcome: Outcome): number => own.filter((r) => r.outcome === outcome).length;
  return `| \`${name}\` | ${own.length} | ${count("passed")} | ${count("refused")} | ${count("threw")} |`;
}

export function summary(checks: readonly Check[], results: readonly Result[]): string {
  const threw = results.filter((result) => result.outcome === "threw");
  const refused = results.filter((result) => result.outcome === "refused");
  return [
    "## Live input checks",
    "",
    "| Check | Samples | Passed | Refused | Threw |",
    "| --- | --- | --- | --- | --- |",
    ...checks.map(({ name }) => countRow(name, results)),
    ...listing("Threw (fails the job)", threw),
    ...listing("Refused (for the reviewer to judge)", refused),
    "",
  ].join("\n");
}

export type Deps = {
  git: (args: string[]) => string;
  source: () => Source;
  write: (text: string) => void;
};

export function realDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  const { GITHUB_STEP_SUMMARY: summaryPath } = env;
  return {
    git: (args) => execFileSync("git", args, { encoding: "utf8" }),
    source: () => realSource(env),
    write: (text) => {
      if (summaryPath === undefined || summaryPath === "") process.stdout.write(text);
      else appendFileSync(summaryPath, text);
    },
  };
}

function runAll(checks: readonly Check[], source: Source): Result[] {
  try {
    return checks.flatMap((check) => check.probes(source).map((probe) => runProbe(probe)));
  } finally {
    source.close();
  }
}

function changedFiles(env: NodeJS.ProcessEnv, deps: Deps): string[] {
  const { PR_DIFF_BASE: base = "HEAD^1" } = env;
  return deps.git(["diff", "--name-only", "--no-renames", base, "HEAD"]).split("\n");
}

function failOnThrow(results: readonly Result[]): void {
  if (results.some((result) => result.outcome === "threw")) process.exitCode = 1;
}

export function main(
  env: NodeJS.ProcessEnv = process.env,
  deps: Deps = realDeps(env),
  available: readonly Check[] = CHECKS,
): void {
  const checks = selectChecks(changedFiles(env, deps), available);
  if (checks.length === 0) {
    deps.write("No check that reads live input changed.\n");
    return;
  }
  const results = runAll(checks, deps.source());
  deps.write(summary(checks, results));
  failOnThrow(results);
}

if (import.meta.main) main();
