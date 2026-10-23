import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main } from "./frontier.ts";
import { ghReturns, issue } from "./frontier.test-helper.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

describe("main", () => {
  const spawn = vi.mocked(spawnSync);
  const openIssues =
    "repos/{owner}/{repo}/issues?state=open&sort=created&direction=asc&per_page=100";

  beforeEach(() => {
    spawn.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
  });

  const argv = process.argv;

  afterEach(() => {
    process.argv = argv;
    vi.restoreAllMocks();
  });

  test("prints the takeable children that have no open blocker", () => {
    ghReturns(spawn, {
      "repos/{owner}/{repo}/issues/5/sub_issues": [
        issue(8),
        issue(9, { assignees: [{ login: "smonn" }] }),
        issue(10),
        issue(12, { labels: [] }),
      ],
      "repos/{owner}/{repo}/issues/8/dependencies/blocked_by": [issue(1, { state: "closed" })],
      "repos/{owner}/{repo}/issues/10/dependencies/blocked_by": [issue(2)],
      "repos/{owner}/{repo}/issues/12/dependencies/blocked_by": [],
    });
    main("5");
    expect(console.log).toHaveBeenCalledWith("#8 Ticket 8 [wayfinder:grilling]\n#12 Ticket 12");
    expect(spawn.mock.calls[0]).toEqual([
      "gh",
      ["api", "--paginate", "--slurp", "repos/{owner}/{repo}/issues/5/sub_issues"],
      { encoding: "utf8" },
    ]);
  });

  test("says so when no child is on the frontier", () => {
    ghReturns(spawn, {
      "repos/{owner}/{repo}/issues/5/sub_issues": [issue(8, { state: "closed" })],
    });
    main("5");
    expect(console.log).toHaveBeenCalledWith("No frontier tickets.");
  });

  test("with no map, prints every open ticket that has no open blocker", () => {
    const renovate = { login: "renovate[bot]" };
    ghReturns(spawn, {
      [openIssues]: [
        issue(8, { labels: [] }),
        issue(9, { assignees: [{ login: "smonn" }] }),
        issue(10),
        issue(30, { pull_request: {} }),
        issue(44, { sub_issues_summary: { total: 6 } }),
        issue(45, { sub_issues_summary: { total: 0 } }),
        issue(50, { labels: [{ name: "wayfinder:map" }] }),
        issue(89, { title: "Dependency Dashboard", user: renovate }),
        issue(90, { title: "Dependency Dashboard" }),
        issue(91, { title: "Action Required: Fix Renovate Configuration", user: renovate }),
      ],
      "repos/{owner}/{repo}/issues/8/dependencies/blocked_by": [issue(1, { state: "closed" })],
      "repos/{owner}/{repo}/issues/10/dependencies/blocked_by": [issue(2)],
      "repos/{owner}/{repo}/issues/45/dependencies/blocked_by": [],
      "repos/{owner}/{repo}/issues/90/dependencies/blocked_by": [],
      "repos/{owner}/{repo}/issues/91/dependencies/blocked_by": [],
    });
    process.argv = ["node", "scripts/frontier.ts"];
    main();
    expect(console.log).toHaveBeenCalledWith(
      [
        "#8 Ticket 8",
        "#45 Ticket 45 [wayfinder:grilling]",
        "#90 Dependency Dashboard [wayfinder:grilling]",
        "#91 Action Required: Fix Renovate Configuration [wayfinder:grilling]",
      ].join("\n"),
    );
  });

  test("with no map, lists open issues oldest first", () => {
    ghReturns(spawn, { [openIssues]: [] });
    process.argv = ["node", "scripts/frontier.ts"];
    main();
    expect(console.log).toHaveBeenCalledWith("No frontier tickets.");
    expect(spawn.mock.calls[0]?.[1]).toEqual(["api", "--paginate", "--slurp", openIssues]);
  });

  test("prints usage and exits 2 for a map number that is not a positive integer", () => {
    for (const arg of ["", "abc", "0", "-3", "1.5"]) {
      expect(() => {
        main(arg);
      }).toThrow("exit 2");
    }
    expect(console.error).toHaveBeenCalledWith(
      "Usage: node scripts/frontier.ts [map issue number]",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  test("prints the gh error and exits 1 when gh fails", () => {
    ghReturns(spawn, {});
    expect(() => {
      main("5");
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith(
      "gh api repos/{owner}/{repo}/issues/5/sub_issues failed:\nno route repos/{owner}/{repo}/issues/5/sub_issues",
    );
  });

  test("prints a thrown non-Error value as is", () => {
    spawn.mockImplementation(() => {
      // oxlint-disable-next-line eslint/no-throw-literal, typescript/only-throw-error -- main's non-Error branch is the subject.
      throw "boom";
    });
    expect(() => {
      main("5");
    }).toThrow("exit 1");
    expect(console.error).toHaveBeenCalledWith("boom");
  });
});
