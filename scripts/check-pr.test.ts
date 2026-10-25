import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkPr, main } from "./check-pr.ts";

describe("checkPr title", () => {
  const branch = "chore/53-pr-title-check";

  test.each([
    "feat: add where",
    "fix(diff): order drops before creates",
    "build(deps): update dependency oxlint to v1.90.0",
    "chore(main): release 0.1.0",
    "feat(cli)!: rename generate",
  ])("accepts %s", (title) => {
    expect(checkPr(title, branch)).toEqual([]);
  });

  test.each([
    "add where",
    "feature: add where",
    "Feat: add where",
    "feat:add where",
    "feat: ",
    "feat(): add where",
    "feat(cli) : add where",
  ])("rejects %s", (title) => {
    expect(checkPr(title, branch)).toEqual([
      `PR title "${title}" is not a Conventional Commit: type(scope): summary`,
    ]);
  });
});

describe("checkPr branch", () => {
  const title = "feat: add where";

  test.each([
    "feature/57-typed-query",
    "bugfix/diff-drop-order",
    "hotfix/1.2.1",
    "release/v0.1.0",
    "chore/area-labels",
    "renovate/devdependencies-(non-major)",
    "release-please--branches--main",
  ])("accepts %s", (branch) => {
    expect(checkPr(title, branch)).toEqual([]);
  });

  test.each([
    "docs/config-and-cli",
    "claude/typed-query",
    "feature/Typed-Query",
    "feature/typed_query",
    "feature/",
    "feature/-typed",
    "feature/typed-",
    "feature/typed--query",
    "feature/typed/query",
    "research/pg-depend-scan",
    "prototype/foreign-keys",
    "main",
  ])("rejects %s", (branch) => {
    expect(checkPr(title, branch)).toEqual([
      `Branch "${branch}" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>`,
    ]);
  });

  test("still checks the title on a bot branch", () => {
    expect(checkPr("Update oxlint", "renovate/oxlint-1.x")).toEqual([
      'PR title "Update oxlint" is not a Conventional Commit: type(scope): summary',
    ]);
  });

  test("reports a bad title and a bad branch together", () => {
    expect(checkPr("add where", "main")).toHaveLength(2);
  });
});

describe("main", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("passes a conforming title and branch", () => {
    main({ PR_TITLE: "feat: add where", PR_BRANCH: "feature/where" });
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("prints each problem and fails", () => {
    main({ PR_TITLE: "add where", PR_BRANCH: "main" });
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  test("fails when PR_TITLE or PR_BRANCH is unset", () => {
    main({ PR_TITLE: "feat: add where" });
    expect(console.error).toHaveBeenCalledWith("Set PR_TITLE and PR_BRANCH");
    expect(process.exitCode).toBe(1);
  });
});
