import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MARKER, main } from "./check-issue-parent.ts";
import {
  comment,
  commentsRoute,
  event,
  fakeGh,
  fetched,
  issueRoute,
  labelled,
  milestonePath,
  orphan,
  parentIssue,
  posted,
  run,
  writeEvent,
} from "./check-issue-parent.test-helper.ts";

describe("main", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("names the parent for the issue's area and posts once", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling"), parentIssue(46, "area:diff")]],
    });
    expect(posted(gh)).toEqual([comment("#44")]);
  });

  test("names both parents when two area labels match two parents", () => {
    const labels = labelled("area:tooling", "area:diff");
    const gh = run(event({ labels }), {
      [issueRoute]: fetched({ labels }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(46, "area:diff"), parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([comment("#44, #46")]);
  });

  test("names a parent once when it shares two area labels", () => {
    const labels = labelled("area:definition", "area:diff");
    const gh = run(event({ labels }), {
      [issueRoute]: fetched({ labels }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(46, "area:definition", "area:diff")]],
    });
    expect(posted(gh)).toEqual([comment("#46")]);
  });

  test("finds a parent on a later page of the milestone", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(50, "area:diff")], [parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([comment("#44")]);
  });

  test("stays quiet when no issue in the milestone parents the area", () => {
    const childless = { ...parentIssue(50, "area:tooling"), sub_issues_summary: { total: 0 } };
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(46, "area:diff"), childless, { number: 51, labels: [] }]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("ignores a pull request that shares the milestone and area", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[{ ...parentIssue(44, "area:tooling"), pull_request: {} }]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("stays quiet when the issue is already a sub-issue", () => {
    const parentUrl = "https://api.github.com/repos/smonn/db/issues/45";
    const gh = run(event(), {
      [issueRoute]: fetched({ parent_issue_url: parentUrl }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("treats a null parent_issue_url as no parent", () => {
    const gh = run(event(), {
      [issueRoute]: fetched({ parent_issue_url: null }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([comment("#44")]);
  });

  test("stays quiet when the issue has sub-issues itself", () => {
    const gh = run(event(), {
      [issueRoute]: fetched({ sub_issues_summary: { total: 2 } }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("stays quiet when a marker comment exists on any page", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[{ body: "Thanks" }], [{ body: `${MARKER}\nearlier` }]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("stays quiet when the fetched issue lost its milestone", () => {
    const gh = run(event(), {
      [issueRoute]: fetched({ milestone: null }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("stays quiet when the fetched issue lost its area label", () => {
    const gh = run(event(), {
      [issueRoute]: fetched({ labels: labelled("bug") }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("stays quiet when the fetched issue is closed", () => {
    const gh = run(event(), {
      [issueRoute]: fetched({ state: "closed" }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(posted(gh)).toEqual([]);
  });

  test("matches parents by the fetched labels and milestone, not the event's", () => {
    const route = "repos/smonn/db/issues?milestone=2&state=open&per_page=100";
    const gh = run(event(), {
      [issueRoute]: fetched({ milestone: { number: 2 }, labels: labelled("area:diff") }),
      [commentsRoute]: [[]],
      [route]: [[parentIssue(44, "area:tooling"), parentIssue(46, "area:diff")]],
    });
    expect(posted(gh)).toEqual([comment("#46")]);
  });

  test("fails when the fetched issue has neither parent field", () => {
    const { parent_issue_url: _parent, sub_issues_summary: _summary, ...renamed } = fetched();
    const gh = fakeGh({
      [issueRoute]: renamed,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(() => {
      main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh);
    }).toThrow("$.parent_issue_url: expected");
    expect(posted(gh)).toEqual([]);
  });

  test("fails when the fetched issue lacks sub_issues_summary", () => {
    const { sub_issues_summary: _summary, ...partial } = fetched();
    const gh = fakeGh({
      [issueRoute]: partial,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(() => {
      main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh);
    }).toThrow("$.sub_issues_summary: expected");
    expect(posted(gh)).toEqual([]);
  });

  // GitHub returns both parent fields as null for a pull request. The check throws on that shape
  // today; it is unreachable while the workflow reacts only to `issues` events.
  test("fails when both parent fields are null, as GitHub returns them for a pull request", () => {
    const gh = fakeGh({
      [issueRoute]: fetched({ parent_issue_url: null, sub_issues_summary: null }),
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(() => {
      main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh);
    }).toThrow("$.sub_issues_summary: expected");
    expect(posted(gh)).toEqual([]);
  });

  test("skips a bot issue without calling the API", () => {
    const gh = run(event({ user: { type: "Bot" } }), {});
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails naming the field when the API answers with the wrong shape", () => {
    const gh = fakeGh({
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[{ number: "44" }]],
    });
    expect(() => {
      main({ GITHUB_EVENT_PATH: writeEvent(event()) }, gh);
    }).toThrow("$[0][0].number: expected number");
    expect(posted(gh)).toEqual([]);
  });

  test("fails when the payload has no milestone key", () => {
    const gh = fakeGh({});
    const { milestone: _milestone, ...issue } = event().issue;
    const path = writeEvent({ ...event(), issue }, "no-milestone.json");
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, gh);
    }).toThrow("$.issue.milestone: expected object, got undefined");
    expect(gh).not.toHaveBeenCalled();
  });

  test("fails when GITHUB_EVENT_PATH is unset", () => {
    const gh = fakeGh({});
    main({}, gh);
    expect(console.error).toHaveBeenCalledWith("Set GITHUB_EVENT_PATH");
    expect(process.exitCode).toBe(1);
    expect(gh).not.toHaveBeenCalled();
  });
});
