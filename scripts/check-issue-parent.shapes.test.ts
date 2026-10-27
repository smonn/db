import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { MARKER, MISMATCH_MARKER, main } from "./check-issue-parent.ts";
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

const parentUrl = "https://api.github.com/repos/smonn/db/issues/45";
const parentRoute = "repos/smonn/db/issues/45";

const bodyOf = (gh: ReturnType<typeof fakeGh>): string => String(posted(gh)[0]?.[6]);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("the markers", () => {
  test("stay the strings already posted on issues", () => {
    expect(MARKER).toBe("<!-- smonn-db:missing-parent -->");
    expect(MISMATCH_MARKER).toBe("<!-- smonn-db:parent-area-mismatch -->");
  });
});

describe("reads of the API", () => {
  test("ask gh for the issue, its comments, and the milestone, in that order", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling")]],
    });
    expect(gh.mock.calls.map(([args]) => args)).toEqual([
      ["api", issueRoute],
      ["api", "--paginate", "--slurp", commentsRoute],
      ["api", "--paginate", "--slurp", milestonePath],
      ["api", issueRoute],
      comment("#44"),
    ]);
  });

  test("name the request when gh does not answer with JSON", () => {
    expect(() => run(event(), {})).toThrow(`gh api ${issueRoute}: invalid JSON`);
    expect(() =>
      run(event(), {
        [issueRoute]: orphan,
      }),
    ).toThrow(`gh api ${commentsRoute}: invalid JSON`);
  });

  test("name the repository when the event's repository has no name", () => {
    const path = writeEvent({ ...event(), repository: { full_name: 5 } }, "no-name.json");
    expect(() => {
      main({ GITHUB_EVENT_PATH: path }, fakeGh({}));
    }).toThrow("$.repository.full_name: expected string, got number");
  });

  test("let a listed issue come without labels", () => {
    const unlabelled = { number: 51, sub_issues_summary: { total: 2 } };
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[unlabelled]],
    });
    expect(posted(gh)).toEqual([]);
  });
});

describe("matching parents", () => {
  test("names a parent that has other areas besides the issue's", () => {
    const gh = run(event(), {
      [issueRoute]: orphan,
      [commentsRoute]: [[]],
      [milestonePath]: [[parentIssue(44, "area:tooling", "area:diff")]],
    });
    expect(posted(gh)).toEqual([comment("#44")]);
  });
});

const routes = (overrides: Record<string, unknown> = {}, parentAreas = ["area:diff"]) => ({
  [issueRoute]: fetched({ parent_issue_url: parentUrl, ...overrides }),
  [parentRoute]: fetched({ number: 45, labels: labelled(...parentAreas) }),
  [commentsRoute]: [[]],
  [milestonePath]: [[parentIssue(46, "area:tooling"), parentIssue(44, "area:tooling")]],
});

describe("a sub-issue's parent", () => {
  test("is left alone when it has one area the sub-issue shares among several", () => {
    const gh = run(event(), routes({}, ["area:diff", "area:tooling"]));
    expect(posted(gh)).toEqual([]);
  });

  test("lists every area and every candidate parent, comma separated", () => {
    const labels = labelled("area:tooling", "area:definition");
    const gh = run(event({ labels }), {
      ...routes({ labels }, ["area:diff", "area:ui"]),
      [milestonePath]: [[parentIssue(46, "area:definition"), parentIssue(44, "area:tooling")]],
    });
    expect(bodyOf(gh)).toBe(
      `${MISMATCH_MARKER}\nThis sub-issue shares no area with its parent #45 (area:diff, area:ui). It has area:tooling, area:definition. Open parents in its milestone for its area: #44, #46. If it belongs under one of them, move it; otherwise ignore this.`,
    );
  });

  test("never counts the sub-issue itself as a candidate parent", () => {
    const itself = { ...parentIssue(7, "area:tooling"), sub_issues_summary: { total: 2 } };
    const gh = run(event(), { ...routes(), [milestonePath]: [[itself]] });
    expect(bodyOf(gh)).toContain("No open parent in its milestone matches its area.");
  });
});
