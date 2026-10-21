import { describe, expect, test } from "vitest";
import { type Child, formatTicket, isTakeable, pickFrontier } from "./frontier.ts";

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
