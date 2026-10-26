/**
 * Checks an `issues` event for an issue that sits under no parent while its milestone has one for
 * its area. A parent is any issue with sub-issues (#171); `area:*` labels say which parent an issue
 * belongs to. When an open, human-opened issue has a milestone and an area label, is neither a
 * sub-issue nor a parent itself, and shares an area label with an open parent in the same
 * milestone, it gets one comment naming the matching parents. Not every issue needs a parent, so
 * no match means no comment. The comment carries a marker, and an issue that already has one
 * gets no second comment.
 *
 * Run with `GITHUB_EVENT_PATH` set to an `issues` event payload and `gh` authenticated, as
 * `pnpm check:parent`; the Issue milestone workflow runs it on `opened`, `labeled`, and
 * `milestoned`. The event decides whether to check; the REST API answers the parent questions,
 * since a webhook payload's sub-issue fields are not documented.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  array,
  field,
  nullable,
  number,
  optionalField,
  parseJson,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export const MARKER = "<!-- smonn-db:missing-parent -->";

const CHECKED_ACTIONS = new Set(["opened", "labeled", "milestoned"]);

export type ParentEvent = {
  action: string;
  issue: {
    number: number;
    state: string;
    milestone: { number: number } | null;
    labels: { name: string }[];
    user: { type: string };
  };
  repository: { full_name: string };
};

const readName: Reader<{ name: string }> = (value, path) => ({
  name: field(record(value, path), "name", string, path),
});

const readEvent: Reader<ParentEvent> = (value, path) => {
  const event = record(value, path);
  const issuePath = `${path}.issue`;
  const issue = field(event, "issue", record, path);
  const repoPath = `${path}.repository`;
  const repository = field(event, "repository", record, path);
  return {
    action: field(event, "action", string, path),
    issue: {
      number: field(issue, "number", number, issuePath),
      state: field(issue, "state", string, issuePath),
      milestone: field(
        issue,
        "milestone",
        nullable((milestone, p) => ({ number: field(record(milestone, p), "number", number, p) })),
        issuePath,
      ),
      labels: field(issue, "labels", array(readName), issuePath),
      user: field(
        issue,
        "user",
        (user, p) => ({ type: field(record(user, p), "type", string, p) }),
        issuePath,
      ),
    },
    repository: { full_name: field(repository, "full_name", string, repoPath) },
  };
};

type ApiIssue = {
  number: number;
  labels: { name: string }[];
  pull_request?: object | undefined;
  parent_issue_url?: string | undefined;
  sub_issues_summary?: { total: number } | undefined;
};

type Current = {
  number: number;
  state: string;
  milestone: { number: number } | null;
  labels: { name: string }[];
  parent_issue_url: string | null;
  sub_issues_summary: { total: number };
};

const readSummary: Reader<{ total: number }> = (value, path) => ({
  total: field(record(value, path), "total", number, path),
});

// The issue list omits `parent_issue_url` and `sub_issues_summary` from issues that have neither.
const readApiIssue: Reader<ApiIssue> = (value, path) => {
  const issue = record(value, path);
  return {
    number: field(issue, "number", number, path),
    labels: optionalField(issue, "labels", array(readName), path) ?? [],
    pull_request: optionalField(issue, "pull_request", record, path),
    parent_issue_url: optionalField(issue, "parent_issue_url", nullable(string), path) ?? undefined,
    sub_issues_summary: optionalField(issue, "sub_issues_summary", readSummary, path),
  };
};

const readMilestone: Reader<{ number: number }> = (value, path) => ({
  number: field(record(value, path), "number", number, path),
});

// `GET /repos/{repo}/issues/{n}` leaves `parent_issue_url` out of an issue with no parent, so an
// absent one reads as no parent. It always sends `sub_issues_summary` for an issue, so a missing
// one means GitHub changed the API: fail rather than call the issue childless.
const readCurrent: Reader<Current> = (value, path) => {
  const issue = record(value, path);
  return {
    number: field(issue, "number", number, path),
    state: field(issue, "state", string, path),
    milestone: field(issue, "milestone", nullable(readMilestone), path),
    labels: field(issue, "labels", array(readName), path),
    parent_issue_url: optionalField(issue, "parent_issue_url", nullable(string), path) ?? null,
    sub_issues_summary: field(issue, "sub_issues_summary", readSummary, path),
  };
};

const readComment: Reader<{ body: string }> = (value, path) => ({
  body: field(record(value, path), "body", string, path),
});

/** Runs `gh` with `args` and returns its standard output. */
type Gh = (args: string[]) => string;

const runGh: Gh = (args) => execFileSync("gh", args, { encoding: "utf8" });

function getOne(gh: Gh, path: string): Current {
  return readCurrent(parseJson(gh(["api", path]), `gh api ${path}`), "$");
}

function getAll<T>(gh: Gh, path: string, read: Reader<T>): T[] {
  const pages = parseJson(gh(["api", "--paginate", "--slurp", path]), `gh api ${path}`);
  return array(array(read))(pages, "$").flat();
}

function areas(labels: { name: string }[]): string[] {
  return labels.map((label) => label.name).filter((name) => name.startsWith("area:"));
}

type Checkable = { state: string; milestone: unknown; labels: { name: string }[] };

function qualifies(issue: Checkable): boolean {
  return (
    issue.state === "open" &&
    issue.milestone !== null &&
    areas(issue.labels).length > 0 &&
    !issue.labels.some((label) => label.name === "wayfinder:map")
  );
}

/** A cheap pre-filter on the event; `main` re-checks the issue it fetches. */
export function needsParentCheck(event: ParentEvent): boolean {
  return (
    CHECKED_ACTIONS.has(event.action) && event.issue.user.type !== "Bot" && qualifies(event.issue)
  );
}

function matchingParents(self: Current, milestoneIssues: ApiIssue[]): number[] {
  const wanted = areas(self.labels);
  return milestoneIssues
    .filter(
      (candidate) =>
        candidate.pull_request === undefined &&
        candidate.number !== self.number &&
        (candidate.sub_issues_summary?.total ?? 0) > 0 &&
        areas(candidate.labels).some((area) => wanted.includes(area)),
    )
    .map((candidate) => candidate.number)
    .toSorted((a, b) => a - b);
}

function hasParentOrChildren(issue: Current): boolean {
  return issue.parent_issue_url !== null || issue.sub_issues_summary.total > 0;
}

export function main(env: NodeJS.ProcessEnv = process.env, gh: Gh = runGh): void {
  const { GITHUB_EVENT_PATH: eventPath } = env;
  if (eventPath === undefined) {
    console.error("Set GITHUB_EVENT_PATH");
    process.exitCode = 1;
    return;
  }
  const event = readEvent(parseJson(readFileSync(eventPath, "utf8"), eventPath), "$");
  if (!needsParentCheck(event)) return;
  const { issue, repository } = event;
  const issuePath = `repos/${repository.full_name}/issues/${issue.number}`;
  const current = getOne(gh, issuePath);
  if (!qualifies(current) || current.milestone === null) return;
  if (hasParentOrChildren(current)) return;
  const comments = getAll(gh, `${issuePath}/comments?per_page=100`, readComment);
  if (comments.some((comment) => comment.body.includes(MARKER))) return;
  const milestoneIssues = getAll(
    gh,
    `repos/${repository.full_name}/issues?milestone=${current.milestone.number}&state=open&per_page=100`,
    readApiIssue,
  );
  const parents = matchingParents(current, milestoneIssues);
  if (parents.length === 0) return;
  const named = parents.map((parent) => `#${parent}`).join(", ");
  const body = `${MARKER}\nThis issue has no parent, and its milestone has a parent for its area: ${named}. If it belongs there, attach it as a sub-issue (\`gh issue edit <parent> --add-sub-issue ${issue.number}\`). Not every issue needs a parent, so ignore this if it doesn't.`;
  gh(["issue", "comment", String(issue.number), "--repo", repository.full_name, "--body", body]);
}

if (import.meta.main) main();
