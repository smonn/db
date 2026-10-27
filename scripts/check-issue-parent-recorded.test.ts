import { describe, expect, test } from "vitest";
import type { ParentEvent } from "./check-issue-parent.ts";
import {
  type ApiIssue,
  commentsRoute,
  comment,
  event,
  fetched,
  issueRoute,
  labelled,
  milestonePath,
  orphan,
  posted,
  recorded,
  recordedIssue,
  recordedParentless,
  run,
} from "./check-issue-parent.test-helper.ts";

function onRecorded(issue: Partial<ParentEvent["issue"]>, current: ApiIssue): string[][] {
  const routes = { [issueRoute]: current, [commentsRoute]: [[]], [milestonePath]: recorded };
  return posted(run(event(issue), routes));
}

describe("against the recorded v0.1 milestone", () => {
  test("an area:tooling issue with no parent is pointed at #44", () => {
    expect(onRecorded({}, orphan)).toEqual([comment("#44")]);
  });

  test("an area:definition and area:diff issue with no parent is pointed at #46", () => {
    const labels = labelled("area:definition", "area:diff");
    expect(onRecorded({ labels }, fetched({ labels }))).toEqual([comment("#46")]);
  });

  test("an area:cli issue with no parent gets nothing, since no v0.1 parent covers cli", () => {
    expect(
      onRecorded({ labels: labelled("area:cli") }, fetched({ labels: labelled("area:cli") })),
    ).toEqual([]);
  });

  test("a recorded parentless payload, with no parent_issue_url key, is pointed at #44", () => {
    expect(recordedParentless).not.toHaveProperty("parent_issue_url");
    const current = {
      ...recordedParentless,
      milestone: { number: 1 },
      labels: labelled("area:tooling"),
    };
    expect(onRecorded({}, current)).toEqual([comment("#44")]);
  });

  test("a recorded sub-issue passes because the API reports its parent", () => {
    const parentUrl = String(recordedIssue(55)["parent_issue_url"]);
    const current = fetched({ parent_issue_url: parentUrl });
    const parent = fetched({ number: 44 });
    const routes = {
      [issueRoute]: current,
      [parentUrl.replace("https://api.github.com/", "")]: parent,
      [commentsRoute]: [[]],
      [milestonePath]: recorded,
    };
    expect(posted(run(event(), routes))).toEqual([]);
  });
});
