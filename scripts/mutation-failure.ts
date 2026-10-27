/**
 * Tells the open `mutation-report` issue that a Mutation run failed, since a failed shard skips
 * the Report job and leaves that issue showing last week's survivors. Comments the run URL, and
 * opens the issue when none is open so the failure isn't lost.
 *
 * Run with `GITHUB_REPOSITORY` and `RUN_URL` set and `gh` authenticated, as `pnpm mutation:failure`.
 */
import { type Gh, openReportIssue, runGh } from "./mutation-report.ts";

const LABEL = "mutation-report";
const TITLE = "Mutants survive the weekly Stryker run";

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const { GITHUB_REPOSITORY: repo, RUN_URL: url } = env;
  if (repo === undefined || url === undefined) {
    console.error("Set GITHUB_REPOSITORY and RUN_URL");
    process.exitCode = 1;
    return;
  }
  const body = `The Mutation run failed, so the survivors listed here may be out of date: ${url}`;
  const issue = openReportIssue(repo, gh);
  if (issue === undefined) {
    gh(
      ["issue", "create", "--repo", repo, "--title", TITLE, "--label", LABEL, "--body-file", "-"],
      body,
    );
  } else {
    gh(["issue", "comment", String(issue), "--repo", repo, "--body-file", "-"], body);
  }
}

if (import.meta.main) main();
