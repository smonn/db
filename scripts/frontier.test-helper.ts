import type { spawnSync } from "node:child_process";
import type { MockedFunction } from "vitest";

type Issue = {
  number: number;
  title: string;
  html_url: string;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
  user: { login: string };
  pull_request?: object;
  sub_issues_summary?: { total: number };
};

export function issue(number: number, overrides: Partial<Issue> = {}): Issue {
  return {
    number,
    title: `Ticket ${number}`,
    html_url: `https://github.com/smonn/db/issues/${number}`,
    state: "open",
    labels: [{ name: "wayfinder:grilling" }],
    assignees: [],
    user: { login: "smonn" },
    ...overrides,
  };
}

/** An issue read on its own, as `gh api repos/{owner}/{repo}/issues/<n>` returns it. */
export type MapIssue = { body: string | null };

/**
 * Answers each `gh api` call to `spawn` from `responses`, keyed by the request path, and fails the
 * rest. A list is one page of a paginated, slurped read; a `MapIssue` is a plain read.
 */
export function ghReturns(
  spawn: MockedFunction<typeof spawnSync>,
  responses: Record<string, Issue[] | MapIssue>,
): void {
  spawn.mockImplementation((_command, args) => {
    const path = args?.at(-1) ?? "";
    const pages = responses[path];
    const result = { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
    if (pages === undefined) return { ...result, status: 1, stderr: ` no route ${path} ` };
    return { ...result, stdout: JSON.stringify(Array.isArray(pages) ? [pages] : pages) };
  });
}
