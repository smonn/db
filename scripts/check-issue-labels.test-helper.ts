import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, vi } from "vitest";
import { MARKER, main, type LabelledIssue, type LabelsEvent } from "./check-issue-labels.ts";

export type Gh = Mock<(args: string[]) => string>;

export const issueRoute = "repos/smonn/db/issues/7";
export const commentsRoute = "repos/smonn/db/issues/7/comments?per_page=100";

const dir = mkdtempSync(join(tmpdir(), "check-issue-labels-"));

export function labelled(...names: string[]): LabelledIssue["labels"] {
  return names.map((name) => ({ name }));
}

/** An issue as `GET /repos/{repo}/issues/{n}` returns it, trimmed to what the check reads. */
export function fetched(overrides: Partial<LabelledIssue> = {}): LabelledIssue {
  return {
    number: 7,
    state: "open",
    labels: labelled("ready-for-agent", "priority:medium", "enhancement"),
    user: { type: "User" },
    ...overrides,
  };
}

export function event(current: LabelledIssue, action = "labeled"): LabelsEvent {
  return { action, issue: current, repository: { full_name: "smonn/db" } };
}

/** Answers each call from `routes`, keyed by its last argument; a list route holds its pages. */
export function fakeGh(routes: Record<string, unknown>): Gh {
  return vi.fn<(args: string[]) => string>(
    (args) => JSON.stringify(routes[args.at(-1) ?? ""]) ?? "",
  );
}

export function writeEvent(payload: unknown, name = "event.json"): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

/** Fires `payload` with the live issue and comment pages GitHub would return. */
export function run(
  payload: LabelsEvent,
  live: LabelledIssue = payload.issue,
  pages: string[][] = [[]],
): Gh {
  const gh = fakeGh({
    [issueRoute]: live,
    [commentsRoute]: pages.map((page) => page.map((body) => ({ body }))),
  });
  main({ GITHUB_EVENT_PATH: writeEvent(payload) }, gh);
  return gh;
}

export function posted(gh: Gh): string[][] {
  return gh.mock.calls.map(([args]) => args).filter((args) => args[0] === "issue");
}

export function comment(gap: string): string[] {
  return [
    "issue",
    "comment",
    "7",
    "--repo",
    "smonn/db",
    "--body",
    `${MARKER}\nThis ready issue breaks the label rule in \`docs/agents/triage-labels.md\`: ${gap}. Give it exactly one \`priority:*\` label and exactly one of \`bug\` or \`enhancement\`.`,
  ];
}
