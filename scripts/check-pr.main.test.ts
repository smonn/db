import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenPrAdd } from "./check-adr-clash.ts";
import { main, type ChangedAdr } from "./check-pr.ts";

const env = { PR_TITLE: "docs(adr): propose x", PR_BRANCH: "chore/x" };
const adds = (file: string): ChangedAdr => ({ file, status: "proposed", added: true });
const adrs: ChangedAdr[] = [
  { file: "docs/adr/0030-x.md", status: "proposed", added: false, baseStatus: "proposed" },
  adds("docs/adr/0031-x.md"),
];

describe("main inputs", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("fails when only PR_BRANCH is set", () => {
    main({ PR_BRANCH: "chore/x" });
    expect(console.error).toHaveBeenCalledWith("Set PR_TITLE and PR_BRANCH");
    expect(process.exitCode).toBe(1);
  });

  test("leaves the ADR title rule unchecked without PR_DIFF_BASE", () => {
    main({ ...env, PR_TITLE: "docs(adr): accept x" });
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("reports a closing keyword in PR_BODY that names another repository", () => {
    main({ ...env, PR_BODY: "Closes other/repo#7" });
    expect(console.error).toHaveBeenCalledWith(
      'PR body closes other/repo#7 outside smonn/db: "Closes other/repo#7"',
    );
    expect(process.exitCode).toBe(1);
  });

  test("passes a PR_BODY that closes an issue here", () => {
    main({ ...env, PR_BODY: "Closes smonn/db#7" });
    expect(console.error).not.toHaveBeenCalled();
  });

  test("lists open PRs when the PR adds one ADR among others", () => {
    const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => [
      { pr: 9, file: "docs/adr/0031-y.md" },
    ]);
    main({ ...env, PR_DIFF_BASE: "HEAD^1", PR_NUMBER: "5" }, () => adrs, readOpenAdds);
    expect(readOpenAdds).toHaveBeenCalledWith("5");
    expect(console.error).toHaveBeenCalledWith(
      "docs/adr/0031-x.md reuses ADR number 0031, which open PR #9 adds as docs/adr/0031-y.md",
    );
  });

  test("reports no clash when the PR adds no ADR", () => {
    const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => []);
    main({ ...env, PR_DIFF_BASE: "HEAD^1", PR_NUMBER: "5" }, () => adrs.slice(0, 1), readOpenAdds);
    expect(console.error).not.toHaveBeenCalled();
  });

  test("lists no open PRs without PR_DIFF_BASE", () => {
    const readOpenAdds = vi.fn<(exclude: string) => OpenPrAdd[]>(() => []);
    main({ ...env, PR_NUMBER: "5" }, () => [adds("docs/adr/0031-x.md")], readOpenAdds);
    expect(readOpenAdds).not.toHaveBeenCalled();
  });
});
