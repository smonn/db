/**
 * Checks a new or edited `issues` event two ways. A title that starts lowercase gets a comment
 * asking for a capitalised plain word first. An open issue without a milestone gets a comment and
 * the `needs-triage` label, since AGENTS.md asks for a milestone on every issue.
 *
 * The title is checked on `opened` and on an `edited` event that changed it, so a body edit or a
 * demilestone doesn't repeat the comment. The milestone comment is skipped when the issue already
 * has `needs-triage`, so a repeated demilestone doesn't stack comments, and an edit never runs the
 * milestone check. Both checks skip issues a bot opened, such as Renovate's Dependency Dashboard.
 *
 * Run with `GITHUB_EVENT_PATH` set to an `issues` event payload and `gh` authenticated, as
 * `pnpm check:issue`; the Issue milestone workflow runs it on `opened`, `edited`, and
 * `demilestoned`.
 */
import { execFileSync } from "node:child_process";
import {
  array,
  field,
  nullable,
  number,
  optionalField,
  readEventPayload,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export type IssueEvent = {
  action: string;
  changes?: Record<string, unknown> | undefined;
  issue: {
    number: number;
    title: string;
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
    changes: optionalField(event, "changes", record, path),
    issue: {
      number: field(issue, "number", number, issuePath),
      title: field(issue, "title", string, issuePath),
      state: field(issue, "state", string, issuePath),
      milestone: field(issue, "milestone", nullable(record), issuePath),
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
    action: field(event, "action", string, path),
  };
};

type Gh = (args: string[]) => void;

export function needsMilestone(issue: IssueEvent["issue"]): boolean {
  return issue.state === "open" && issue.milestone === null && issue.user.type !== "Bot";
}

function titleWasChecked({ action, changes }: IssueEvent): boolean {
  return action === "opened" || (action === "edited" && changes?.["title"] !== undefined);
}

export function needsCapitalTitle(event: IssueEvent): boolean {
  const { issue } = event;
  return (
    titleWasChecked(event) &&
    issue.state === "open" &&
    issue.user.type !== "Bot" &&
    /^\p{Ll}/u.test(issue.title)
  );
}

const runGh: Gh = (args) => {
  execFileSync("gh", args, { stdio: "inherit" });
};

function readEnvEvent(env: NodeJS.ProcessEnv): IssueEvent | undefined {
  const payload = readEventPayload(env);
  return payload === undefined ? undefined : readIssueEvent(payload, "$");
}

function requestCapitalTitle(target: string[], gh: Gh): void {
  const body = `This title starts with a lowercase letter. Titles are sentence case: start with a capitalised plain word and keep identifiers verbatim, so reorder instead of recasing (\`generate drops tables\` becomes \`Command generate drops tables\`).`;
  gh(["issue", "comment", ...target, "--body", body]);
}

function requestMilestone(event: IssueEvent, target: string[], gh: Gh): void {
  const { issue, repository } = event;
  const body = `This issue has no milestone. Every issue needs one: pick it by the milestone descriptions at ${repository.html_url}/milestones.`;
  if (!issue.labels.some((label) => label.name === "needs-triage")) {
    gh(["issue", "comment", ...target, "--body", body]);
  }
  gh(["issue", "edit", ...target, "--add-label", "needs-triage"]);
}

function requestFixes(event: IssueEvent, gh: Gh): void {
  const { issue, repository } = event;
  const target = [String(issue.number), "--repo", repository.full_name];
  if (needsCapitalTitle(event)) requestCapitalTitle(target, gh);
  if (event.action === "edited" || !needsMilestone(issue)) return;
  requestMilestone(event, target, gh);
}

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const event = readEnvEvent(env);
  if (event !== undefined) requestFixes(event, gh);
}

if (import.meta.main) main();
