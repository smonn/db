import { describe, expect, test, vi } from "vitest";
import {
  type Child,
  formatTicket,
  formatUnlinked,
  isTakeable,
  parseIssuePages,
  pickFrontier,
  unlinkedClosed,
} from "./frontier.ts";

const ticket: Child = {
  number: 11,
  title: "Config file and CLI for v0.1",
  url: "https://github.com/smonn/db/issues/11",
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
    html_url: "https://github.com/smonn/db/issues/3",
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

const closed = (number: number): Child => ({
  ...ticket,
  number,
  url: `https://github.com/smonn/db/issues/${number}`,
  state: "closed",
});

describe("unlinkedClosed", () => {
  test("returns the closed children whose URL the body lacks", () => {
    const body = "- [Linked](https://github.com/smonn/db/issues/8): done";
    const missing = unlinkedClosed([closed(8), closed(9), ticket], () => body);
    expect(missing.map((child) => child.number)).toEqual([9]);
  });

  test("does not count a longer issue number as a link", () => {
    const body = "[x](https://github.com/smonn/db/issues/380)";
    expect(unlinkedClosed([closed(38)], () => body)).toHaveLength(1);
    expect(unlinkedClosed([closed(380)], () => body)).toHaveLength(0);
  });

  test("accepts a link that follows a longer one", () => {
    const body =
      "https://github.com/smonn/db/issues/380 and https://github.com/smonn/db/issues/38.";
    expect(unlinkedClosed([closed(38)], () => body)).toHaveLength(0);
  });

  test("reads the body only when a child is closed", () => {
    const readBody = vi.fn<() => string>(() => "");
    expect(unlinkedClosed([ticket], readBody)).toEqual([]);
    expect(readBody).not.toHaveBeenCalled();
  });
});

describe("formatUnlinked", () => {
  test("names the ticket and its URL", () => {
    expect(formatUnlinked({ ...ticket, state: "closed" })).toBe(
      "warning: closed #11 Config file and CLI for v0.1 [wayfinder:grilling] is not linked in the map body (https://github.com/smonn/db/issues/11)",
    );
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
