import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { type Child, formatTicket, isTakeable, main, pickFrontier } from "./frontier.ts";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn<typeof spawnSync>() }));

const ticket: Child = {
  number: 11,
  title: "Config file and CLI for v0.1",
  state: "open",
  labels: ["wayfinder:grilling"],
  assignees: [],
};

describe("isTakeable", () => {
  test("takes an open, unassigned ticket", () => {
    expect(isTakeable(ticket)).toBe(true);
  });

  test("skips a closed ticket", () => {
    expect(isTakeable({ ...ticket, state: "closed" })).toBe(false);
  });

  test("skips a claimed ticket", () => {
    expect(isTakeable({ ...ticket, assignees: ["smonn"] })).toBe(false);
  });
});

describe("pickFrontier", () => {
  const children = [
    { ...ticket, number: 8 },
    { ...ticket, number: 13 },
    { ...ticket, number: 14 },
  ];

  test("drops tickets with an open blocker and keeps map order", () => {
    const frontier = pickFrontier(children, (n) => n === 13);
    expect(frontier.map((child) => child.number)).toEqual([8, 14]);
  });

  test("looks up blockers only for takeable tickets", () => {
    const checked: number[] = [];
    pickFrontier([{ ...ticket, number: 8, state: "closed" }, ticket], (n) => {
      checked.push(n);
      return false;
    });
    expect(checked).toEqual([11]);
  });
});

describe("formatTicket", () => {
  test("prints the number, title, and wayfinder type", () => {
    expect(formatTicket(ticket)).toBe("#11 Config file and CLI for v0.1 [wayfinder:grilling]");
  });

  test("omits the type when the ticket has no wayfinder label", () => {
    expect(formatTicket({ ...ticket, labels: [] })).toBe("#11 Config file and CLI for v0.1");
  });
});

describe("main", () => {
  const spawn = vi.mocked(spawnSync);
  const openIssues =
    "repos/{owner}/{repo}/issues?state=open&sort=created&direction=asc&per_page=100";

  type Issue = {
    number: number;
    title: string;
    state: "open" | "closed";
    labels: { name: string }[];
    assignees: { login: string }[];
    user: { login: string };
    pull_request?: object;
    sub_issues_summary?: { total: number };
  };

  function issue(number: number, overrides: Partial<Issue> = {}): Issue {
    return {
      number,
      title: `Ticket ${number}`,
      state: "open",
      labels: [{ name: "wayfinder:grilling" }],
      assignees: [],
      user: { login: "smonn" },
      ...overrides,
    };
  }

  function ghReturns(responses: Record<string, Issue[]>): void {
    spawn.mockImplementation((_command, args) => {
      const path = args?.at(-1) ?? "";
      const pages = responses[path];
      const result = { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      if (pages === undefined) return { ...result, status: 1, stderr: ` no route ${path} ` };
      return { ...result, stdout: JSON.stringify([pages]) };
    });
  }

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
    ghReturns({
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
    ghReturns({ "repos/{owner}/{repo}/issues/5/sub_issues": [issue(8, { state: "closed" })] });
    main("5");
    expect(console.log).toHaveBeenCalledWith("No frontier tickets.");
  });

  test("with no map, prints every open ticket that has no open blocker", () => {
    ghReturns({
      [openIssues]: [
        issue(8, { labels: [] }),
        issue(9, { assignees: [{ login: "smonn" }] }),
        issue(10),
        issue(30, { pull_request: {} }),
        issue(44, { sub_issues_summary: { total: 6 } }),
        issue(45, { sub_issues_summary: { total: 0 } }),
        issue(50, { labels: [{ name: "wayfinder:map" }] }),
        issue(89, { user: { login: "renovate[bot]" } }),
      ],
      "repos/{owner}/{repo}/issues/8/dependencies/blocked_by": [issue(1, { state: "closed" })],
      "repos/{owner}/{repo}/issues/10/dependencies/blocked_by": [issue(2)],
      "repos/{owner}/{repo}/issues/45/dependencies/blocked_by": [],
    });
    process.argv = ["node", "scripts/frontier.ts"];
    main();
    expect(console.log).toHaveBeenCalledWith("#8 Ticket 8\n#45 Ticket 45 [wayfinder:grilling]");
  });

  test("with no map, lists open issues oldest first", () => {
    ghReturns({ [openIssues]: [] });
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
    ghReturns({});
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
