import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parsePushedBranches } from "./check-branch.ts";

const zeros = "0".repeat(40);
const sha = "a".repeat(40);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("parsePushedBranches whitespace", () => {
  test("reads a line with surrounding space and runs of space or tabs between fields", () => {
    const stdin = `  HEAD   ${sha}\t\trefs/heads/chore/a  ${zeros}\r\n`;
    expect(parsePushedBranches(stdin)).toEqual(["chore/a"]);
  });

  test("reads a branch whose local sha starts or ends with zeros", () => {
    const stdin = `a 0abc refs/heads/chore/a ${zeros}\nb abc0 refs/heads/chore/b ${zeros}\n`;
    expect(parsePushedBranches(stdin)).toEqual(["chore/a", "chore/b"]);
  });

  test("skips a delete whatever the length of its zero sha", () => {
    expect(parsePushedBranches(`(delete) 0 refs/heads/docs/z ${sha}`)).toEqual([]);
  });

  test("skips a line with a missing or extra field", () => {
    expect(parsePushedBranches(`a ${sha} refs/heads/chore/a`)).toEqual([]);
    expect(parsePushedBranches(`a ${sha} refs/heads/chore/a ${zeros} extra`)).toEqual([]);
    expect(parsePushedBranches(`${sha} refs/heads/chore/a ${zeros}`)).toEqual([]);
    expect(parsePushedBranches(`extra a ${sha} refs/heads/chore/a ${zeros}`)).toEqual([]);
  });

  test("skips a ref that only contains refs/heads/", () => {
    expect(parsePushedBranches(`a ${sha} x/refs/heads/chore/a ${zeros}`)).toEqual([]);
    expect(parsePushedBranches(`a ${sha} refs/heads/ ${zeros}`)).toEqual([]);
  });
});

const push = (branch: string): string => `a ${sha} refs/heads/${branch} ${zeros}`;

describe("main throwaway branches", () => {
  test.each(["docs/research/pg-scan", "research/pg_scan", "research/pg-scan/x"])(
    "fails the branch %s, which is not a research or prototype name",
    (branch) => {
      main(push(branch));
      expect(console.error).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(1);
    },
  );

  test.each(["research/pg-scan", "prototype/foreign-keys", "research/v1.2"])(
    "passes the branch %s",
    (branch) => {
      main(push(branch));
      expect(console.error).not.toHaveBeenCalled();
    },
  );
});
