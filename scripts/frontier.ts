/**
 * Prints a wayfinder map's frontier: its open, unassigned child tickets whose blockers are all
 * closed, in map order, one per line. See "Wayfinding operations" in docs/agents/issue-tracker.md.
 *
 * Run it with `node scripts/frontier.ts <map issue number>` from a clone with `gh` signed in.
 */
import { spawnSync } from "node:child_process";

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

export function pickFrontier(
  children: Child[],
  hasOpenBlocker: (ticket: number) => boolean,
): Child[] {
  return children.filter(isTakeable).filter((child) => !hasOpenBlocker(child.number));
}

export function formatTicket(child: Child): string {
  const type = child.labels.find((label) => label.startsWith("wayfinder:"));
  return `#${child.number} ${child.title}${type ? ` [${type}]` : ""}`;
}

function ghApi(path: string): unknown {
  const result = spawnSync("gh", ["api", "--paginate", "--slurp", path], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`gh api ${path} failed:\n${result.stderr.trim()}`);
  return (JSON.parse(result.stdout) as unknown[][]).flat();
}

type ApiIssue = {
  number: number;
  title: string;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
};

function children(map: number): Child[] {
  return (ghApi(`repos/{owner}/{repo}/issues/${map}/sub_issues`) as ApiIssue[]).map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    assignees: issue.assignees.map((assignee) => assignee.login),
  }));
}

function hasOpenBlocker(ticket: number): boolean {
  const blockers = ghApi(`repos/{owner}/{repo}/issues/${ticket}/dependencies/blocked_by`);
  return (blockers as ApiIssue[]).some((blocker) => blocker.state === "open");
}

export function main(arg = process.argv[2]): void {
  const map = Number(arg);
  if (!Number.isInteger(map) || map <= 0) {
    console.error("Usage: node scripts/frontier.ts <map issue number>");
    process.exit(2);
  }
  try {
    const frontier = pickFrontier(children(map), hasOpenBlocker);
    console.log(frontier.length ? frontier.map(formatTicket).join("\n") : "No frontier tickets.");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

if (import.meta.main) main();
