import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";
import { measure } from "./tsc-cost.ts";
import {
  createFixture,
  diagnostics,
  removeFixture,
  runDirs,
  type Fixture,
} from "./tsc-cost.test-helper.ts";

// Real git and the fake tsc against a temp repo; any other command (such as gh) is refused.
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./tsc-cost.test-helper.ts")).guardChildProcess(await importOriginal()),
);

const thrownBy = async (run: () => Promise<unknown>): Promise<Error> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("did not throw");
};

describe("measure against a real git repository and a fake tsc", () => {
  let fixture: Fixture;
  let dir: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };

  const firstRunDir = (): string => {
    const [first] = runDirs(fixture);
    if (first === undefined) throw new Error("tsc never ran");
    return first;
  };
  const worktrees = (): string[] =>
    git("worktree", "list", "--porcelain").match(/^worktree .*/gmu) ?? [];

  beforeEach(() => {
    isolateGitEnv();
    fixture = createFixture();
    dir = fixture.dir;
    git("init", "--quiet");
  });

  afterEach(() => {
    removeFixture(fixture);
    vi.unstubAllEnvs();
  });

  test("prints the median of three interleaved runs of the base and the working tree", async () => {
    commit("base");
    writeFileSync(join(dir, "cost.txt"), diagnostics(150, 900));

    expect(await measure(dir, "HEAD")).toBe(
      [
        "                  base    head  change",
        "types              100     150  +50.0%",
        "instantiations    1000     900  -10.0%",
        "check time      0.300s  0.400s  +33.3%",
      ].join("\n"),
    );

    const dirs = runDirs(fixture);
    expect(dirs).toHaveLength(6);
    expect(dirs.filter((_, index) => index % 2 === 1)).toEqual([dir, dir, dir]);
    expect(new Set(dirs.filter((_, index) => index % 2 === 0)).size).toBe(1);
    expect(dirs[0]).not.toBe(dir);
  });

  test("checks out the base ref, not the current commit", async () => {
    const base = commit("base");
    writeFileSync(join(dir, "cost.txt"), diagnostics(200, 2000));
    commit("head");

    expect(await measure(dir, base)).toContain("types              100     200  +100.0%");
  });

  test("removes the temporary worktree and leaves node_modules alone", async () => {
    commit("base");
    await measure(dir, "HEAD");

    expect(existsSync(dirname(firstRunDir()))).toBe(false);
    expect(worktrees()).toEqual([`worktree ${dir}`]);
    expect(existsSync(join(dir, "node_modules", "marker"))).toBe(true);
  });

  test("removes the temporary worktree when tsc fails on the working tree", async () => {
    commit("base");
    writeFileSync(join(dir, "fail.txt"), "");

    await expect(measure(dir, "HEAD")).rejects.toThrow(/tsc failed in .*:\nerror TS1: boom/u);

    expect(existsSync(dirname(firstRunDir()))).toBe(false);
    expect(worktrees()).toEqual([`worktree ${dir}`]);
    expect(existsSync(join(dir, "node_modules", "marker"))).toBe(true);
  });

  test("removes the temporary worktree when tsc fails on the base", async () => {
    writeFileSync(join(dir, "fail.txt"), "");
    commit("base");
    rmSync(join(dir, "fail.txt"));

    await expect(measure(dir, "HEAD")).rejects.toThrow("tsc failed in");

    expect(runDirs(fixture)).toHaveLength(1);
    expect(existsSync(dirname(firstRunDir()))).toBe(false);
    expect(worktrees()).toEqual([`worktree ${dir}`]);
  });

  test("names the tree when tsc cannot start, and keeps the cause", async () => {
    commit("base");
    rmSync(join(dir, "node_modules", ".bin", "tsc"));

    const error = await thrownBy(() => measure(dir, "HEAD"));

    expect(error.message).toMatch(/^tsc failed in [^\n]+:\n$/u);
    expect(error.cause).toBeInstanceOf(Error);
    expect(worktrees()).toEqual([`worktree ${dir}`]);
  });

  test("names a base ref that is not a commit, and keeps the cause", async () => {
    commit("base");

    const error = await thrownBy(() => measure(dir, "nope"));

    expect(error.message).toBe('Base ref "nope" is not a commit');
    expect(error.cause).toBeInstanceOf(Error);
    expect(existsSync(fixture.log)).toBe(false);
  });

  test("refuses a base ref that reads as an option", async () => {
    commit("base");

    await expect(measure(dir, "--help")).rejects.toThrow(
      'Base ref "--help" must not start with "-"',
    );
  });
});
