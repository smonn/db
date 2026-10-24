import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { type LabelledIssue, labelGaps, main, readIssue } from "./check-issue-labels.ts";
import { array, parseJson } from "./github-json.ts";
import {
  comment,
  commentsRoute,
  event,
  fakeGh,
  issueRoute,
  posted,
  writeEvent,
} from "./check-issue-labels.test-helper.ts";

// `gh api` output for the open ready issues on 2026-10-23, trimmed to the fields the check reads.
const fixture = new URL("./fixtures/issue-labels/ready-issues.json", import.meta.url);
const recorded: LabelledIssue[] = array(array(readIssue))(
  parseJson(readFileSync(fixture, "utf8"), "fixture"),
  "$",
).flat();

function recordedIssue(number: number): LabelledIssue {
  const found = recorded.find((issue) => issue.number === number);
  if (found === undefined) throw new Error(`#${number} is not in the fixture`);
  return found;
}

function without(issue: LabelledIssue, unwanted: (name: string) => boolean): LabelledIssue {
  return { ...issue, labels: issue.labels.filter((label) => !unwanted(label.name)) };
}

describe("against the recorded ready issues", () => {
  test("every recorded issue passes the rule", () => {
    expect(recorded.length).toBeGreaterThan(0);
    for (const issue of recorded) expect(labelGaps(issue)).toEqual([]);
  });

  test("a recorded issue that loses its priority is named", () => {
    const stripped = without(recordedIssue(325), (name) => name.startsWith("priority:"));
    expect(labelGaps(stripped)).toEqual(["no `priority:*` label"]);
  });

  test("a recorded issue that loses its category is named", () => {
    const stripped = without(recordedIssue(325), (name) => name === "enhancement");
    expect(labelGaps(stripped)).toEqual(["no category label"]);
  });

  test("an unlabeled event on a recorded issue posts the comment once", () => {
    const stripped = {
      ...without(recordedIssue(325), (name) => name === "enhancement"),
      number: 7,
    };
    const gh = fakeGh({ [issueRoute]: stripped, [commentsRoute]: [[]] });
    main({ GITHUB_EVENT_PATH: writeEvent(event(stripped, "unlabeled")) }, gh);
    expect(posted(gh)).toEqual([comment("no category label")]);
  });
});
