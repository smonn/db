import { describe, expect, test } from "vitest";
import type { ParentEvent } from "./check-issue-parent.ts";
import {
  type ApiIssue,
  commentsRoute,
  comment,
  event,
  issueRoute,
  labelled,
  milestonePath,
  orphan,
  posted,
  recorded,
  recordedIssue,
  run,
} from "./check-issue-parent.test-helper.ts";

function onRecorded(issue: Partial<ParentEvent["issue"]>, current: ApiIssue): string[][] {
  const routes = { [issueRoute]: current, [commentsRoute]: [[]], [milestonePath]: recorded };
  return posted(run(event(issue), routes));
}

describe("against the recorded v0.1 milestone", () => {
  test("an area:tooling issue with no parent is pointed at #44", () => {
    const { parent_issue_url: _parent, ...free } = recordedIssue(55);
    expect(onRecorded({}, { ...free, number: 7 })).toEqual([comment("#44")]);
  });

  test("an area:definition and area:diff issue with no parent is pointed at #46", () => {
    const labels = labelled("area:definition", "area:diff");
    expect(onRecorded({ labels }, orphan)).toEqual([comment("#46")]);
  });

  test("an area:cli issue with no parent gets nothing, since no v0.1 parent covers cli", () => {
    expect(onRecorded({ labels: labelled("area:cli") }, orphan)).toEqual([]);
  });

  test("a recorded sub-issue passes because the API reports its parent", () => {
    const current = { number: 7, parent_issue_url: recordedIssue(55)["parent_issue_url"] };
    expect(onRecorded({}, current)).toEqual([]);
  });
});
