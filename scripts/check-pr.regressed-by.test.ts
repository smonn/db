import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkRegressedBy, main } from "./check-pr.ts";

const message =
  "A fix PR needs a body line `Regressed by: #<pr>` (the PR that introduced the defect) or `Regressed by: n/a` (the defect predates every PR, or the code never worked)";

describe("checkRegressedBy", () => {
  test.each([
    "fix: order drops",
    "fix(diff): order drops",
    "fix!: order drops",
    "fix(diff)!: order drops",
  ])("needs the line on %s", (title) => {
    expect(checkRegressedBy(title, "## Issue\n\nCloses #1")).toEqual([message]);
  });

  test.each([
    "feat: add where",
    "chore(tooling): fix check",
    "docs: fix typo",
    "docs: fix: typo",
    "fixup: order drops",
    "fixes: order drops",
    "refactor(fix): x",
  ])("leaves %s alone", (title) => {
    expect(checkRegressedBy(title, "no line")).toEqual([]);
  });

  test.each([
    "Regressed by: #123",
    "Regressed by: n/a",
    "## Issue\n\nCloses #1\nRegressed by: #7\n\n## Why",
    "Regressed by: #123  ",
    "Regressed by: #123\r\nmore",
  ])("accepts %j", (body) => {
    expect(checkRegressedBy("fix: x", body)).toEqual([]);
  });

  test.each([
    "",
    "Regressed by: 123",
    "Regressed by:",
    "Regressed by: ",
    "Regressed by: #",
    "Regressed by: #12a",
    "Regressed by: N/A",
    "Regressed by: n/a because old",
    "Regressed by: #1 and #2",
    "regressed by: #123",
    "- Regressed by: #123",
    "see Regressed by: #123",
    "Regressed by:#123",
  ])("rejects %j", (body) => {
    expect(checkRegressedBy("fix: x", body)).toEqual([message]);
  });
});

describe("main Regressed by", () => {
  const fix = { PR_TITLE: "fix: x", PR_BRANCH: "bugfix/x" };

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("fails a fix PR whose body lacks the line", () => {
    main({ ...fix, PR_BODY: "Closes #1" });
    expect(console.error).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
  });

  test("fails a fix PR with an empty body, which CI passes for a PR with none", () => {
    main({ ...fix, PR_BODY: "" });
    expect(console.error).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
  });

  test("passes a fix PR whose body has the line", () => {
    main({ ...fix, PR_BODY: "Regressed by: n/a" });
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("skips the line without PR_BODY, as in a local run", () => {
    main(fix);
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
