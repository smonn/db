/**
 * Comments on and labels `needs-triage` an open issue without a milestone, since AGENTS.md asks
 * for one on every issue. Skips the comment when the issue already has `needs-triage`, so a
 * repeated demilestone doesn't stack comments. Skips issues a bot opened, such as Renovate's
 * Dependency Dashboard.
 *
 * Run with `GITHUB_EVENT_PATH` set to an `issues` event payload and `gh` authenticated, as
 * `pnpm check:issue`; the Issue milestone workflow runs it on `opened` and `demilestoned`.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { array, field, number, parseJson, record, string, type Reader } from "./github-json.ts";

export type IssueEvent = {
  issue: {
    number: number;
    state: string;
    milestone: unknown;
    labels: { name: string }[];
    user: { type: string };
  };
  repository: { full_name: string; html_url: string };
};

const readIssueEvent: Reader<IssueEvent> = (value, path) => {
  const event = record(value, path);
  const issuePath = `${path}.issue`;
  const issue = field(event, "issue", record, path);
  const repoPath = `${path}.repository`;
  const repository = field(event, "repository", record, path);
  return {
    issue: {
      number: field(issue, "number", number, issuePath),
      state: field(issue, "state", string, issuePath),
      milestone: issue["milestone"],
      labels: field(
        issue,
        "labels",
        array((label, p) => ({ name: field(record(label, p), "name", string, p) })),
        issuePath,
      ),
      user: field(
        issue,
        "user",
        (user, p) => ({ type: field(record(user, p), "type", string, p) }),
        issuePath,
      ),
    },
    repository: {
      full_name: field(repository, "full_name", string, repoPath),
      html_url: field(repository, "html_url", string, repoPath),
    },
  };
};

type Gh = (args: string[]) => void;

export function needsMilestone(issue: IssueEvent["issue"]): boolean {
  return issue.state === "open" && issue.milestone === null && issue.user.type !== "Bot";
}

const runGh: Gh = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const { GITHUB_EVENT_PATH: eventPath } = env;
  if (eventPath === undefined) {
    console.error("Set GITHUB_EVENT_PATH");
    process.exitCode = 1;
    return;
  }
  const { issue, repository } = readIssueEvent(
    parseJson(readFileSync(eventPath, "utf8"), eventPath),
    "$",
  );
  if (!needsMilestone(issue)) return;
  const target = [String(issue.number), "--repo", repository.full_name];
  const body = `This issue has no milestone. Every issue needs one: pick it by the milestone descriptions at ${repository.html_url}/milestones.`;
  if (!issue.labels.some((label) => label.name === "needs-triage")) {
    gh(["issue", "comment", ...target, "--body", body]);
  }
  gh(["issue", "edit", ...target, "--add-label", "needs-triage"]);
}

if (import.meta.main) main();
