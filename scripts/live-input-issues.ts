/**
 * The issue checks over the open issues: `check:issue`, `check:labels`, and `check:parent` read an
 * `issues` event, so each issue becomes one, run with a `gh` that records its writes
 * (`readOnlyGh`). `check:upstream` runs `closedCitations` on each issue, since its `main` catches a
 * throw and exits 1 as it does for a refusal.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { closedCitations, readIssue } from "./check-closed-upstream.ts";
import { main as checkLabels } from "./check-issue-labels.ts";
import { main as checkMilestone } from "./check-issue-milestone.ts";
import { main as checkParent } from "./check-issue-parent.ts";
import { readOnlyGh, type Check, type Gh, type Probe } from "./live-input-probe.ts";
import type { IssueSample, Source } from "./live-input-source.ts";

type IssueMain = (env: NodeJS.ProcessEnv, gh: Gh) => void;

const issueSample = ({ number: n, title }: IssueSample): string => `#${n} ${title}`;

function eventProbes(name: string, action: string, run: IssueMain): Check["probes"] {
  return (source) =>
    source.issues().map((issue) => ({
      check: name,
      sample: issueSample(issue),
      run: () => {
        const writes: string[] = [];
        const path = join(source.scratch(), `${name}-${issue.number}.json`);
        const repository = {
          full_name: source.repo,
          html_url: `https://github.com/${source.repo}`,
        };
        writeFileSync(path, JSON.stringify({ action, issue: issue.raw, repository }));
        run({ GITHUB_EVENT_PATH: path }, readOnlyGh(source.gh, writes));
        return writes;
      },
    }));
}

function upstreamProbes(source: Source): Probe[] {
  return source.issues().map((issue) => ({
    check: "check:upstream",
    sample: issueSample(issue),
    run: () => closedCitations([readIssue(issue.raw, "$")]).closed,
  }));
}

// The check waits 30 seconds before it comments, so a run over every issue would take far longer.
const skipGraceWait = (): void => {
  // Nothing to wait for: the issue is already filed.
};

export const ISSUE_CHECKS: Check[] = [
  {
    name: "check:issue",
    files: ["scripts/check-issue-milestone.ts", "scripts/github-json.ts"],
    probes: eventProbes("check:issue", "opened", checkMilestone),
  },
  {
    name: "check:labels",
    files: ["scripts/check-issue-labels.ts", "scripts/github-json.ts"],
    probes: eventProbes("check:labels", "labeled", checkLabels),
  },
  {
    name: "check:parent",
    files: ["scripts/check-issue-parent.ts", "scripts/github-json.ts"],
    probes: eventProbes("check:parent", "opened", (env, gh) => {
      checkParent(env, gh, skipGraceWait);
    }),
  },
  {
    name: "check:upstream",
    files: ["scripts/check-closed-upstream.ts", "scripts/github-json.ts"],
    probes: upstreamProbes,
  },
];
