import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { checkClosingKeywords } from "./check-closing-keywords.ts";
import { main } from "./check-pr.ts";

test.each([
  ["Closes giantswarm/devctl#2956", "giantswarm/devctl#2956"],
  ["fixes: Other/Repo#7", "Other/Repo#7"],
  ["Resolved https://github.com/giantswarm/devctl/issues/2956", "giantswarm/devctl#2956"],
  ["closed https://github.com/a/b/pull/3", "a/b#3"],
  ["Closes #1\n\nfix a/b#9", "a/b#9"],
])("rejects %s", (body, reference) => {
  const problems = checkClosingKeywords(body);
  expect(problems).toHaveLength(1);
  expect(problems[0]).toContain(`closes ${reference} outside smonn/db`);
});

test.each([
  "Closes #505",
  "Closes smonn/db#505",
  "Fixes SMONN/DB#5",
  "Closes https://github.com/smonn/db/issues/505",
  "Cited giantswarm/devctl#2956 in passing",
  "See https://github.com/giantswarm/devctl/issues/2956",
  "prefix a/b#1 closes nothing here",
  "",
])("accepts %j", (body) => {
  expect(checkClosingKeywords(body)).toEqual([]);
});

test("rejects every offending reference", () => {
  expect(checkClosingKeywords("Closes a/b#1 and fixes c/d#2")).toHaveLength(2);
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

test("main fails on PR_BODY with an outside closing keyword", () => {
  main({ PR_TITLE: "feat: add where", PR_BRANCH: "feature/where", PR_BODY: "Closes a/b#1" });
  expect(console.error).toHaveBeenCalledTimes(1);
  expect(process.exitCode).toBe(1);
});

test("main passes without PR_BODY", () => {
  main({ PR_TITLE: "feat: add where", PR_BRANCH: "feature/where" });
  expect(console.error).not.toHaveBeenCalled();
});
