import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Mock, vi } from "vitest";
import { MARKER, main, type ParentEvent } from "./check-issue-parent.ts";
import { array, parseJson, record } from "./github-json.ts";

export type ApiIssue = Record<string, unknown>;
export type Gh = Mock<(args: string[]) => string>;

export const milestonePath = "repos/smonn/db/issues?milestone=1&state=open&per_page=100";
export const issueRoute = "repos/smonn/db/issues/7";
export const commentsRoute = "repos/smonn/db/issues/7/comments?per_page=100";

/**
 * An issue as `GET /repos/{repo}/issues/{n}` returns it when it has no parent: GitHub leaves
 * `parent_issue_url` out entirely (#89) and sends it only once a parent exists (#325).
 */
export function fetched(overrides: ApiIssue = {}): ApiIssue {
  return {
    number: 7,
    state: "open",
    milestone: { number: 1 },
    labels: labelled("area:tooling"),
    sub_issues_summary: { total: 0 },
    ...overrides,
  };
}

export const orphan: ApiIssue = fetched();

const dir = mkdtempSync(join(tmpdir(), "check-issue-parent-"));

// `gh api --paginate --slurp` output for the open v0.1 issues, trimmed to the fields the check
// reads. Every recorded issue has a parent or is a parent (#44, #46), bar #227.
const fixture = new URL("./fixtures/issue-parent/milestone-v0.1.json", import.meta.url);
export const recorded: ApiIssue[][] = array(array(record))(
  parseJson(readFileSync(fixture, "utf8"), "fixture"),
  "$",
);

// `GET /repos/smonn/db/issues/89`, an issue with no parent, trimmed to the fields the check reads.
const parentlessFixture = new URL(
  "./fixtures/issue-parent/issue-89-parentless.json",
  import.meta.url,
);
export const recordedParentless: ApiIssue = record(
  parseJson(readFileSync(parentlessFixture, "utf8"), "fixture"),
  "$",
);

export function recordedIssue(number: number): ApiIssue {
  const found = recorded.flat().find((issue) => issue["number"] === number);
  if (found === undefined) throw new Error(`#${number} is not in the fixture`);
  return found;
}

export function labelled(...names: string[]): { name: string }[] {
  return names.map((name) => ({ name }));
}

export function event(
  issue: Partial<ParentEvent["issue"]> = {},
  rest: Partial<Omit<ParentEvent, "issue">> = {},
): ParentEvent {
  return {
    action: "labeled",
    issue: {
      number: 7,
      state: "open",
      milestone: { number: 1 },
      labels: labelled("area:tooling"),
      user: { type: "User" },
      ...issue,
    },
    repository: { full_name: "smonn/db" },
    ...rest,
  };
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

export function run(payload: ParentEvent, routes: Record<string, unknown>): Gh {
  const gh = fakeGh(routes);
  main({ GITHUB_EVENT_PATH: writeEvent(payload) }, gh);
  return gh;
}

export function posted(gh: Gh): string[][] {
  return gh.mock.calls.map(([args]) => args).filter((args) => args[0] === "issue");
}

export function parentIssue(number: number, ...areas: string[]): ApiIssue {
  return { number, labels: labelled(...areas), sub_issues_summary: { total: 3 } };
}

export function comment(parents: string): string[] {
  return [
    "issue",
    "comment",
    "7",
    "--repo",
    "smonn/db",
    "--body",
    `${MARKER}\nThis issue has no parent, and its milestone has a parent for its area: ${parents}. If it belongs there, attach it as a sub-issue (\`gh issue edit <parent> --add-sub-issue 7\`). Not every issue needs a parent, so ignore this if it doesn't.`,
  ];
}
