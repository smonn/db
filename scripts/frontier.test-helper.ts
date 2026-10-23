import { spawnSync } from "node:child_process";
import { vi } from "vitest";

type Issue = {
  number: number;
  title: string;
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
    state: "open",
    labels: [{ name: "wayfinder:grilling" }],
    assignees: [],
    user: { login: "smonn" },
    ...overrides,
  };
}

/** Answers each `gh api` call from `responses`, keyed by the request path, and fails the rest. */
export function ghReturns(responses: Record<string, Issue[]>): void {
  vi.mocked(spawnSync).mockImplementation((_command, args) => {
    const path = args?.at(-1) ?? "";
    const pages = responses[path];
    const result = { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
    if (pages === undefined) return { ...result, status: 1, stderr: ` no route ${path} ` };
    return { ...result, stdout: JSON.stringify([pages]) };
  });
}
