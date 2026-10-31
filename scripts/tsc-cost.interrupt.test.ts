import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";
import type { OnInterrupt } from "../src/dev/shadow/index.ts";
import { measure } from "./tsc-cost.ts";
import { createFixture, removeFixture, runDirs, type Fixture } from "./tsc-cost.test-helper.ts";

// Real git and the fake tsc against a temp repo; any other command (such as gh) is refused.
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./tsc-cost.test-helper.ts")).guardChildProcess(await importOriginal()),
);

describe("measure when the process is interrupted", () => {
  let fixture: Fixture;
  let dir: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  const worktrees = (): string[] =>
    git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((line) => line.startsWith("worktree "));

  beforeEach(() => {
    isolateGitEnv();
    fixture = createFixture();
    dir = fixture.dir;
    git("init", "--quiet");
    writeFileSync(join(dir, "slow.txt"), "");
    git("add", "-A");
    git("commit", "--quiet", "-m", "base");
  });

  afterEach(() => {
    removeFixture(fixture);
    vi.unstubAllEnvs();
  });

  test("the registered cleanup stops tsc and removes the temporary worktree", async () => {
    const registered = Promise.withResolvers<() => Promise<void>>();
    const unregister = vi.fn<() => void>();
    const onInterrupt: OnInterrupt = (cleanup) => {
      registered.resolve(cleanup);
      return unregister;
    };

    const run = measure(dir, "HEAD", onInterrupt);
    run.catch(() => {});
    const interrupt = await registered.promise;
    await vi.waitFor(() => {
      expect(existsSync(fixture.log)).toBe(true);
    });
    expect(worktrees()).toHaveLength(2);

    await interrupt();

    expect(worktrees()).toEqual([`worktree ${dir}`]);
    expect(runDirs(fixture).map((tree) => existsSync(dirname(tree)))).toEqual([false]);
    await expect(run).rejects.toThrow("tsc failed in");
    expect(unregister).toHaveBeenCalledTimes(1);
    expect(runDirs(fixture)).toHaveLength(1);
  });
});
