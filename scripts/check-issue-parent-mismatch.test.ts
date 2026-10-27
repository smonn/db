import { readFileSync } from "node:fs";
import { describe, expect, test, vi } from "vitest";
import { MISMATCH_MARKER, main } from "./check-issue-parent.ts";
import {
  type ApiIssue,
  commentsRoute,
  event,
  issueRoute,
  labelled,
  posted,
  refetchingGh,
  run,
  writeEvent,
} from "./check-issue-parent.test-helper.ts";
import { parseJson, record } from "./github-json.ts";

function recordedFile(name: string): ApiIssue {
  const url = new URL(`./fixtures/issue-parent/${name}`, import.meta.url);
  return record(parseJson(readFileSync(url, "utf8"), name), "$");
}

// #560 as GitHub returns it, parented under #431 (area:diff) after the fix; #432 is area:definition.
const subIssue = recordedFile("issue-560-subissue.json");
const parentDefinition = recordedFile("issue-432-parent.json");
const milestoneParents = parseJson(
  readFileSync(
    new URL("./fixtures/issue-parent/milestone-v0.2-parents.json", import.meta.url),
    "utf8",
  ),
  "fixture",
);

const underDefinition = "https://api.github.com/repos/smonn/db/issues/432";
const underDiff = "https://api.github.com/repos/smonn/db/issues/431";
const parentRoute = "repos/smonn/db/issues/432";
const milestonePath = "repos/smonn/db/issues?milestone=2&state=open&per_page=100";

const diffEvent = event({ milestone: { number: 2 }, labels: labelled("area:diff") });

function routes(overrides: ApiIssue = {}, parent: ApiIssue = parentDefinition) {
  return {
    [issueRoute]: { ...subIssue, number: 7, parent_issue_url: underDefinition, ...overrides },
    [parentRoute]: parent,
    [commentsRoute]: [[]],
    [milestonePath]: milestoneParents,
  };
}

function mismatch(areas: string, parent: string, candidates: string): string[] {
  return [
    "issue",
    "comment",
    "7",
    "--repo",
    "smonn/db",
    "--body",
    `${MISMATCH_MARKER}\nThis sub-issue shares no area with its parent ${parent}. It has ${areas}. Open parents in its milestone for its area: ${candidates}. If it belongs under one of them, move it; otherwise ignore this.`,
  ];
}

describe("a sub-issue under a parent of another area", () => {
  test("is pointed at the open parents of its own area", () => {
    const gh = run(diffEvent, routes());
    expect(posted(gh)).toEqual([mismatch("area:diff", "#432 (area:definition)", "#431")]);
  });

  test("is left alone when it shares an area with its parent", () => {
    const parent = { ...parentDefinition, number: 431, labels: labelled("area:diff") };
    const gh = run(diffEvent, {
      ...routes({ parent_issue_url: underDiff }),
      "repos/smonn/db/issues/431": parent,
    });
    expect(posted(gh)).toEqual([]);
  });

  test("is left alone when it shares any one area with its parent", () => {
    const labels = labelled("area:diff", "area:definition");
    const gh = run(event({ milestone: { number: 2 }, labels }), routes({ labels }));
    expect(posted(gh)).toEqual([]);
  });

  test("is commented on once", () => {
    const gh = run(diffEvent, { ...routes(), [commentsRoute]: [[{ body: MISMATCH_MARKER }]] });
    expect(posted(gh)).toEqual([]);
  });

  test("is not delayed by the grace wait", () => {
    const wait = vi.fn<(ms: number) => void>();
    run(diffEvent, routes(), wait);
    expect(wait).not.toHaveBeenCalled();
  });

  test("is skipped when it has no area label", () => {
    const gh = run(diffEvent, routes({ labels: [] }));
    expect(posted(gh)).toEqual([]);
  });

  test("is skipped when its parent has no area label", () => {
    const gh = run(diffEvent, routes({}, { ...parentDefinition, labels: [] }));
    expect(posted(gh)).toEqual([]);
  });

  test("is told that no open parent covers its area", () => {
    const labels = labelled("area:cli");
    const gh = run(event({ milestone: { number: 2 }, labels }), routes({ labels }));
    expect(posted(gh)).toEqual([
      [
        "issue",
        "comment",
        "7",
        "--repo",
        "smonn/db",
        "--body",
        `${MISMATCH_MARKER}\nThis sub-issue shares no area with its parent #432 (area:definition). It has area:cli. No open parent in its milestone matches its area. If it belongs under a parent, move it; otherwise ignore this.`,
      ],
    ]);
  });
});

describe("an issue attached to a parent during the grace wait", () => {
  test("is checked for an area mismatch after the wait", () => {
    const attached = JSON.stringify({ ...subIssue, number: 7, parent_issue_url: underDefinition });
    const base = routes({ parent_issue_url: null });
    const gh = refetchingGh(base, () => attached);
    const wait = vi.fn<(ms: number) => void>();
    main({ GITHUB_EVENT_PATH: writeEvent(diffEvent) }, gh, wait);
    expect(wait).toHaveBeenCalledOnce();
    expect(posted(gh)).toEqual([mismatch("area:diff", "#432 (area:definition)", "#431")]);
  });

  test("is checked after the wait even when no parent covers its area", () => {
    const attached = JSON.stringify({ ...subIssue, number: 7, parent_issue_url: underDefinition });
    const none = { ...routes({ parent_issue_url: null }), [milestonePath]: [[]] };
    const gh = refetchingGh(none, () => attached);
    const wait = vi.fn<(ms: number) => void>();
    main({ GITHUB_EVENT_PATH: writeEvent(diffEvent) }, gh, wait);
    expect(wait).toHaveBeenCalledOnce();
    expect(posted(gh)).toEqual([
      [
        "issue",
        "comment",
        "7",
        "--repo",
        "smonn/db",
        "--body",
        `${MISMATCH_MARKER}\nThis sub-issue shares no area with its parent #432 (area:definition). It has area:diff. No open parent in its milestone matches its area. If it belongs under a parent, move it; otherwise ignore this.`,
      ],
    ]);
  });
});
