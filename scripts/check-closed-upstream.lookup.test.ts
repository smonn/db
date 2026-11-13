import { describe, expect, test, vi } from "vitest";
import { closedCitations, memoized, type Issue, type Lookup } from "./check-closed-upstream.ts";

const issue = (overrides: Partial<Issue>): Issue => ({
  number: 3,
  title: "Waiting",
  html_url: "https://github.com/smonn/db/issues/3",
  repository_url: "https://api.github.com/repos/smonn/db",
  body: "Waits on pnpm/pnpm#9",
  comments: 0,
  ...overrides,
});
const closed = { state: "closed", html_url: "https://github.com/pnpm/pnpm/issues/9" } as const;

describe("closedCitations", () => {
  test("refuses a closed citation through the lookup it is given", () => {
    const lookup = vi.fn<Lookup>(() => closed);
    expect(closedCitations([issue({})], lookup)).toEqual({
      closed: [
        "#3 cites pnpm/pnpm#9, closed (https://github.com/pnpm/pnpm/issues/9); cited in https://github.com/smonn/db/issues/3",
      ],
      unreadable: [],
    });
    expect(lookup).toHaveBeenCalledWith({ repo: "pnpm/pnpm", number: 9 });
  });

  test("passes an open citation and reports an unreadable one by its status", () => {
    const lookup = vi
      .fn<Lookup>()
      .mockReturnValueOnce({ state: "open", html_url: "x" })
      .mockReturnValueOnce({ unreadable: 403 });
    const found = closedCitations([issue({ body: "pnpm/pnpm#9 and pnpm/pnpm#10" })], lookup);
    expect(found).toEqual({
      closed: [],
      unreadable: ["#3 cites pnpm/pnpm#10, which GitHub does not return (403)"],
    });
  });

  test("skips a pull request", () => {
    const lookup = vi.fn<Lookup>(() => closed);
    closedCitations([issue({ pull_request: {} })], lookup);
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe("memoized", () => {
  test("asks about a reference once, in any case, and keeps each answer", () => {
    const lookup = vi.fn<Lookup>(({ number }) => ({ unreadable: number }));
    const memo = memoized(lookup);
    expect(memo({ repo: "pnpm/pnpm", number: 9 })).toEqual({ unreadable: 9 });
    expect(memo({ repo: "PNPM/pnpm", number: 9 })).toEqual({ unreadable: 9 });
    expect(memo({ repo: "pnpm/pnpm", number: 10 })).toEqual({ unreadable: 10 });
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});
