import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { main, parsePushedBranches } from "./check-branch.ts";

const zeros = "0".repeat(40);
const sha = "a".repeat(40);

function line(localRef: string, localSha: string, remoteRef: string): string {
  return `${localRef} ${localSha} ${remoteRef} ${zeros}\n`;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("parsePushedBranches", () => {
  test("returns the branch name of each pushed remote ref", () => {
    const stdin =
      line("refs/heads/a", sha, "refs/heads/feature/a") + line("HEAD", sha, "refs/heads/docs/z");
    expect(parsePushedBranches(stdin)).toEqual(["feature/a", "docs/z"]);
  });

  test("skips a delete, whose local sha is all zeros", () => {
    expect(parsePushedBranches(line("(delete)", zeros, "refs/heads/docs/bad"))).toEqual([]);
  });

  test("skips a tag and any other ref outside refs/heads/", () => {
    const stdin =
      line("refs/tags/v1", sha, "refs/tags/v1") + line("refs/heads/a", sha, "refs/notes/commits");
    expect(parsePushedBranches(stdin)).toEqual([]);
  });

  test("returns nothing for empty stdin", () => {
    expect(parsePushedBranches("")).toEqual([]);
    expect(parsePushedBranches("\n")).toEqual([]);
  });

  test("ignores a line that does not have four fields", () => {
    expect(parsePushedBranches("garbage\n")).toEqual([]);
  });
});

describe("main", () => {
  test("passes a pushed Conventional Branch", () => {
    main(line("refs/heads/a", sha, "refs/heads/chore/pre-push-branch-check"));
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("passes a research or prototype branch, which is pushed but never opens a PR", () => {
    main(
      line("a", sha, "refs/heads/research/pg-depend-scan") +
        line("b", sha, "refs/heads/prototype/foreign-keys"),
    );
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("fails a pushed branch the CI rule rejects, whatever the local branch", () => {
    main(line("HEAD", sha, "refs/heads/docs/z"));
    expect(console.error).toHaveBeenCalledWith(
      'Branch "docs/z" is not a Conventional Branch: feature|bugfix|hotfix|release|chore/<lowercase-kebab>',
    );
    expect(process.exitCode).toBe(1);
  });

  test("reports every bad branch in one push", () => {
    main(
      line("a", sha, "refs/heads/docs/y") +
        line("b", sha, "refs/heads/feature/ok") +
        line("c", sha, "refs/heads/docs/z"),
    );
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(process.exitCode).toBe(1);
  });

  test("passes the delete of a bad branch, the recovery path", () => {
    main(line("(delete)", zeros, "refs/heads/docs/bad"));
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  test("passes a tag push", () => {
    main(line("refs/tags/v1", sha, "refs/tags/v1"));
    expect(process.exitCode).toBeUndefined();
  });

  test("passes empty stdin", () => {
    main("");
    expect(console.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });
});
