import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  type IssueEvent,
  main,
  needsCapitalTitle,
  needsMilestone,
} from "./check-issue-milestone.ts";

function event(
  issue: Partial<IssueEvent["issue"]> = {},
  rest: Partial<Omit<IssueEvent, "issue">> = {},
): IssueEvent {
  return {
    action: "opened",
    issue: {
      number: 7,
      title: "Nothing flags a lowercase title",
      state: "open",
      milestone: null,
      labels: [],
      user: { type: "User" },
      ...issue,
    },
    repository: { full_name: "smonn/db", html_url: "https://github.com/smonn/db" },
    ...rest,
  };
}

const titleComment = [
  "issue",
  "comment",
  "7",
  "--repo",
  "smonn/db",
  "--body",
  "This title starts with a lowercase letter. Titles are sentence case: start with a capitalised plain word and keep identifiers verbatim, so reorder instead of recasing (`generate drops tables` becomes `Command generate drops tables`).",
];

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

describe("needsCapitalTitle", () => {
  test("flags a title that starts lowercase", () => {
    expect(needsCapitalTitle(event({ title: "generate drops tables" }))).toBe(true);
    expect(needsCapitalTitle(event({ title: "v0.1 CLI" }))).toBe(true);
  });

  test("passes a title that starts uppercase or with a non-letter", () => {
    expect(needsCapitalTitle(event())).toBe(false);
    expect(needsCapitalTitle(event({ title: "3 tables clash" }))).toBe(false);
    expect(needsCapitalTitle(event({ title: "`generate` drops tables" }))).toBe(false);
  });

  test("skips a lowercase title from a bot", () => {
    const bot = event({ title: "dependency dashboard", user: { type: "Bot" } });
    expect(needsCapitalTitle(bot)).toBe(false);
  });

  test("skips a closed issue", () => {
    expect(needsCapitalTitle(event({ title: "lowercase", state: "closed" }))).toBe(false);
  });

  test("checks a retitle but not other edits or a demilestone", () => {
    const issue = { title: "lowercase" };
    expect(needsCapitalTitle(event(issue, { action: "edited", changes: { title: {} } }))).toBe(
      true,
    );
    expect(needsCapitalTitle(event(issue, { action: "edited", changes: { body: {} } }))).toBe(
      false,
    );
    expect(needsCapitalTitle(event(issue, { action: "demilestoned" }))).toBe(false);
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

  test("fails naming the field when the payload is malformed", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const path = join(dir, "bad.json");
    writeFileSync(path, JSON.stringify({ issue: { number: "7" }, repository: {} }));
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("$.issue.number: expected number");
    writeFileSync(path, "not json");
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("invalid JSON");
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails naming the field when the payload has no title or action", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const path = join(dir, "no-title.json");
    const { title: _title, ...issue } = event().issue;
    writeFileSync(path, JSON.stringify({ ...event(), issue }));
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("$.issue.title: expected string");
    const { action: _action, ...rest } = event();
    writeFileSync(path, JSON.stringify(rest));
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("$.action: expected string");
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails instead of skipping when the payload has no milestone key", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const path = join(dir, "no-milestone.json");
    const { milestone: _milestone, ...issue } = event().issue;
    writeFileSync(path, JSON.stringify({ ...event(), issue }));
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("$.issue.milestone: expected object, got undefined");
    expect(gh).not.toHaveBeenCalled();
  });

  test("only ensures the label when the issue already carries it", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ labels: [{ name: "needs-triage" }] })) }, gh);
    expect(gh.mock.calls).toEqual([
      [["issue", "edit", "7", "--repo", "smonn/db", "--add-label", "needs-triage"]],
    ]);
  });

  test("comments on a lowercase title", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const milestone = { title: "v0.1" };
    main({ GITHUB_EVENT_PATH: write(event({ title: "generate drops tables", milestone })) }, gh);
    expect(gh.mock.calls).toEqual([[titleComment]]);
  });

  test("leaves an uppercase title with a milestone alone", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ milestone: { title: "v0.1" } })) }, gh);
    expect(gh).not.toHaveBeenCalled();
  });

  test("leaves the milestone alone on an edit", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({}, { action: "edited", changes: { body: {} } })) }, gh);
    expect(gh).not.toHaveBeenCalled();
  });

  test("posts only the title comment on a retitle without a milestone", () => {
    const gh = vi.fn<(args: string[]) => void>();
    const retitle = event(
      { title: "generate drops tables" },
      { action: "edited", changes: { title: {} } },
    );
    main({ GITHUB_EVENT_PATH: write(retitle) }, gh);
    expect(gh.mock.calls).toEqual([[titleComment]]);
  });

  test("skips a bot issue with a lowercase title and no milestone", () => {
    const gh = vi.fn<(args: string[]) => void>();
    main({ GITHUB_EVENT_PATH: write(event({ title: "dashboard", user: { type: "Bot" } })) }, gh);
    expect(gh).not.toHaveBeenCalled();
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
