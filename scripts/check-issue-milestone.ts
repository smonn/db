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
import { readFileSync } from "node:fs";

export type IssueEvent = {
  action: string;
  changes?: { title?: unknown; body?: unknown };
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

type Gh = (args: string[]) => void;

export function needsMilestone(issue: IssueEvent["issue"]): boolean {
  return issue.state === "open" && issue.milestone === null && issue.user.type !== "Bot";
}

export function needsCapitalTitle({ action, changes, issue }: IssueEvent): boolean {
  const checked = action === "opened" || (action === "edited" && changes?.title !== undefined);
  return (
    checked && issue.state === "open" && issue.user.type !== "Bot" && /^\p{Ll}/u.test(issue.title)
  );
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
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- Actions writes GitHub's documented issues event payload.
  const event: IssueEvent = JSON.parse(readFileSync(eventPath, "utf8"));
  const { issue, repository } = event;
  const target = [String(issue.number), "--repo", repository.full_name];
  if (needsCapitalTitle(event)) {
    const title = `This title starts with a lowercase letter. Titles are sentence case: start with a capitalised plain word and keep identifiers verbatim, so reorder instead of recasing (\`generate drops tables\` becomes \`Command generate drops tables\`).`;
    gh(["issue", "comment", ...target, "--body", title]);
  }
  if (event.action === "edited" || !needsMilestone(issue)) return;
  const body = `This issue has no milestone. Every issue needs one: pick it by the milestone descriptions at ${repository.html_url}/milestones.`;
  if (!issue.labels.some((label) => label.name === "needs-triage")) {
    gh(["issue", "comment", ...target, "--body", body]);
  }
  gh(["issue", "edit", ...target, "--add-label", "needs-triage"]);
}

if (import.meta.main) main();
