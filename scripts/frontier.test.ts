import { describe, expect, test } from "vitest";
import { type Child, formatTicket, isTakeable, parseIssuePages, pickFrontier } from "./frontier.ts";

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

describe("parseIssuePages", () => {
  const valid = {
    number: 3,
    title: "T",
    state: "open",
    labels: [{ name: "a" }],
    assignees: [],
    user: { login: "smonn" },
  };

  test("flattens pages and keeps optional fields when present", () => {
    const extra = { ...valid, number: 4, pull_request: {}, sub_issues_summary: { total: 2 } };
    const issues = parseIssuePages(JSON.stringify([[valid], [extra]]), "gh");
    expect(issues.map((issue) => issue.number)).toEqual([3, 4]);
    expect(issues[1]?.sub_issues_summary).toEqual({ total: 2 });
  });

  test("names the path of a malformed issue", () => {
    const bad = JSON.stringify([[valid, { ...valid, state: "merged" }]]);
    expect(() => parseIssuePages(bad, "gh")).toThrow('$[0][1].state: expected "open" | "closed"');
    const noUser = JSON.stringify([[{ ...valid, user: null }]]);
    expect(() => parseIssuePages(noUser, "gh")).toThrow("$[0][0].user: expected object, got null");
  });

  test("rejects an unpaginated array and non-JSON output", () => {
    expect(() => parseIssuePages(JSON.stringify([valid]), "gh")).toThrow(
      "$[0]: expected array, got object",
    );
    expect(() => parseIssuePages("oops", "gh api x")).toThrow("gh api x: invalid JSON");
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
