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
      { ...open, [issueRoute]: fetched({ parent_issue_url: "https://api.github.com/x/45" }) },
    ],
    [
      "an issue with sub-issues",
      event(),
      { ...open, [issueRoute]: fetched({ sub_issues_summary: { total: 2 } }) },
    ],
    ["a marker comment", event(), { ...open, [commentsRoute]: [[{ body: MARKER }]] }],
    ["no matching parent", event(), { ...open, [milestonePath]: [[parentIssue(46, "area:diff")]] }],
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
