/**
 * Prints the frontier: open, unassigned tickets whose blockers are all closed, one per line. With a
 * wayfinder map number it lists the map's children in map order; without one, every open issue
 * oldest first. See "Wayfinding operations" in docs/agents/issue-tracker.md.
 *
 * Run it with `node scripts/frontier.ts [map issue number]` from a clone with `gh` signed in.
 */
import { spawnSync } from "node:child_process";
import {
  array,
  field,
  literal,
  number,
  optionalField,
  parseJson,
  record,
  string,
  type Reader,
} from "./github-json.ts";

export type Child = {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
};

export function isTakeable(child: Child): boolean {
  return child.state === "open" && child.assignees.length === 0;
}

export function pickFrontier(tickets: Child[], blocked: (ticket: number) => boolean): Child[] {
  return tickets.filter((child) => isTakeable(child) && !blocked(child.number));
}

export function formatTicket(child: Child): string {
  const type = child.labels.find((label) => label.startsWith("wayfinder:"));
  return `#${child.number} ${child.title}${type === undefined ? "" : ` [${type}]`}`;
}

type ApiIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
  user: { login: string };
  pull_request?: object | undefined;
  sub_issues_summary?: { total: number } | undefined;
};

const readName: Reader<{ name: string }> = (value, path) => ({
  name: field(record(value, path), "name", string, path),
});

const readLogin: Reader<{ login: string }> = (value, path) => ({
  login: field(record(value, path), "login", string, path),
});

const readSummary: Reader<{ total: number }> = (value, path) => ({
  total: field(record(value, path), "total", number, path),
});

const readIssue: Reader<ApiIssue> = (value, path) => {
  const issue = record(value, path);
  return {
    number: field(issue, "number", number, path),
    title: field(issue, "title", string, path),
    state: field(issue, "state", literal("open", "closed"), path),
    labels: field(issue, "labels", array(readName), path),
    assignees: field(issue, "assignees", array(readLogin), path),
    user: field(issue, "user", readLogin, path),
    pull_request: optionalField(issue, "pull_request", record, path),
    sub_issues_summary: optionalField(issue, "sub_issues_summary", readSummary, path),
  };
};

export function parseIssuePages(text: string, source: string): ApiIssue[] {
  return array(array(readIssue))(parseJson(text, source), "$").flat();
}

function ghApi(path: string): ApiIssue[] {
  const result = spawnSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh api ${path} failed:\n${result.stderr.trim()}`);
  return parseIssuePages(result.stdout, `gh api ${path}`);
}

function toChild(issue: ApiIssue): Child {
  return {
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
  };
}

function children(map: number): Child[] {
  return ghApi(`repos/{owner}/{repo}/issues/${map}/sub_issues`).map((issue) => toChild(issue));
}

// The issues endpoint also returns pull requests. Maps and other parents group tickets rather
// than being one. The dashboard title is Renovate's default; .github/renovate.json keeps it.
function isTicket(issue: ApiIssue): boolean {
  return (
    issue.pull_request === undefined &&
    (issue.sub_issues_summary?.total ?? 0) === 0 &&
    !issue.labels.some((label) => label.name === "wayfinder:map") &&
    !(issue.user.login === "renovate[bot]" && issue.title === "Dependency Dashboard")
  );
}

function openTickets(): Child[] {
  return ghApi("repos/{owner}/{repo}/issues?state=open&sort=created&direction=asc&per_page=100")
    .filter((issue) => isTicket(issue))
    .map((issue) => toChild(issue));
}

function hasOpenBlocker(ticket: number): boolean {
  const blockers = ghApi(`repos/{owner}/{repo}/issues/${ticket}/dependencies/blocked_by`);
  return blockers.some((blocker) => blocker.state === "open");
}

export function main(arg: string | undefined = process.argv[2]): void {
  const map = Number(arg);
  if (arg !== undefined && (!Number.isInteger(map) || map <= 0)) {
    console.error("Usage: node scripts/frontier.ts [map issue number]");
    process.exit(2);
  }
  try {
    const frontier = pickFrontier(
      arg === undefined ? openTickets() : children(map),
      hasOpenBlocker,
    );
    console.log(
      frontier.length > 0
        ? frontier.map((child) => formatTicket(child)).join("\n")
        : "No frontier tickets.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) main();
