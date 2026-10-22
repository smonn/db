import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type IssueEvent, main, needsMilestone } from "./check-issue-milestone.ts";

function event(issue: Partial<IssueEvent["issue"]> = {}): IssueEvent {
  return {
    issue: {
      number: 7,
      state: "open",
      milestone: null,
      labels: [],
      user: { type: "User" },
      ...issue,
    },
    repository: { full_name: "smonn/db", html_url: "https://github.com/smonn/db" },
  };
}

describe("needsMilestone", () => {
  test("flags an open issue without a milestone", () => {
    expect(needsMilestone(event().issue)).toBe(true);
  });

  test("passes an issue with a milestone", () => {
    expect(needsMilestone(event({ milestone: { title: "v0.1" } }).issue)).toBe(false);
  });

  test("skips an issue a bot opened", () => {
    expect(needsMilestone(event({ user: { type: "Bot" } }).issue)).toBe(false);
  });

  test("skips a closed issue", () => {
    expect(needsMilestone(event({ state: "closed" }).issue)).toBe(false);
  });
});

describe("main", () => {
  let dir: string;
  const write = (payload: IssueEvent): string => {
    const path = join(dir, "event.json");
    writeFileSync(path, JSON.stringify(payload));
    return path;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-issue-milestone-"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("comments on and labels an issue without a milestone", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event()) }, gh);
    expect(gh.mock.calls).toEqual([
      [
        [
          "issue",
          "comment",
          "7",
          "--repo",
          "smonn/db",
          "--body",
          "This issue has no milestone. Every issue needs one: pick it by the milestone descriptions at https://github.com/smonn/db/milestones.",
        ],
      ],
      [["issue", "edit", "7", "--repo", "smonn/db", "--add-label", "needs-triage"]],
    ]);
  });

  test("only ensures the label when the issue already carries it", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ labels: [{ name: "needs-triage" }] })) }, gh);
    expect(gh.mock.calls).toEqual([
      [["issue", "edit", "7", "--repo", "smonn/db", "--add-label", "needs-triage"]],
    ]);
  });

  test("leaves an issue with a milestone alone", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ milestone: { title: "v0.1" } })) }, gh);
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails when GITHUB_EVENT_PATH is unset", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({}, gh);
    expect(console.error).toHaveBeenCalledWith("Set GITHUB_EVENT_PATH");
    expect(process.exitCode).toBe(1);
    expect(gh).not.toHaveBeenCalled();
  });
});
