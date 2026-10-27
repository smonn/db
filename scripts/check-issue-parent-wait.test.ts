import { describe, expect, test, vi } from "vitest";
import { MARKER, main } from "./check-issue-parent.ts";
import {
  commentsRoute,
  event,
  fetched,
  issueRoute,
  milestonePath,
  orphan,
  parentIssue,
  posted,
  refetchingGh,
  run,
  writeEvent,
} from "./check-issue-parent.test-helper.ts";

const open = {
  [issueRoute]: orphan,
  [commentsRoute]: [[]],
  [milestonePath]: [[parentIssue(44, "area:tooling")]],
};

function boom(): string {
  throw new Error("gh: boom");
}

function wrongShape(): string {
  return JSON.stringify({ number: 7 });
}

describe("the grace wait", () => {
  test.each([
    ["a bot issue", event({ user: { type: "Bot" } }), {}],
    ["an event that needs no check", event({}, { action: "edited" }), {}],
    ["a closed issue", event(), { ...open, [issueRoute]: fetched({ state: "closed" }) }],
    ["a lost milestone", event(), { ...open, [issueRoute]: fetched({ milestone: null }) }],
    [
      "an issue that is already a sub-issue",
      event(),
      {
        ...open,
        [issueRoute]: fetched({ parent_issue_url: "https://api.github.com/x/45" }),
        "x/45": fetched({ number: 45 }),
      },
    ],
    [
      "an issue with sub-issues",
      event(),
      { ...open, [issueRoute]: fetched({ sub_issues_summary: { total: 2 } }) },
    ],
    ["a marker comment", event(), { ...open, [commentsRoute]: [[{ body: MARKER }]] }],
  ])("is skipped for %s", (_name, payload, routes) => {
    const wait = vi.fn<(ms: number) => void>();
    const gh = run(payload, routes, wait);
    expect(wait).not.toHaveBeenCalled();
    expect(posted(gh)).toEqual([]);
  });

  test.each([
    ["the refetch call throws", boom, "gh: boom"],
    ["the refetch answers with the wrong shape", wrongShape, "$.state: expected"],
  ])("fails the run without a comment when %s", (_name, refetch, message) => {
    const gh = refetchingGh(open, refetch);
    const wait = vi.fn<(ms: number) => void>();
    expect(() => {
      main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh, wait);
    }).toThrow(message);
    expect(wait).toHaveBeenCalledOnce();
    expect(posted(gh)).toEqual([]);
  });
});

describe("an issue that changes during the grace wait", () => {
  const attached = "https://api.github.com/repos/smonn/db/issues/45";
  const routes = { ...open, "repos/smonn/db/issues/45": fetched({ number: 45 }) };

  test.each([
    ["loses its area label", { labels: [] }],
    ["loses its milestone", { milestone: null }],
    ["is closed", { state: "closed" }],
  ])("is skipped when it %s and is attached", (_name, change) => {
    const again = JSON.stringify(fetched({ ...change, parent_issue_url: attached }));
    const gh = refetchingGh(routes, () => again);
    const wait = vi.fn<(ms: number) => void>();
    main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh, wait);
    expect(wait).toHaveBeenCalledOnce();
    expect(posted(gh)).toEqual([]);
  });

  test("waits and stays quiet for a parentless issue when no parent covers its area", () => {
    const wait = vi.fn<(ms: number) => void>();
    const gh = run(event(), { ...open, [milestonePath]: [[parentIssue(46, "area:diff")]] }, wait);
    expect(wait).toHaveBeenCalledOnce();
    expect(posted(gh)).toEqual([]);
  });
});
