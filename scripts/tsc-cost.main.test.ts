import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolateGitEnv } from "../src/dev/cli/git-env.test-helper.ts";
import { main } from "./tsc-cost.ts";
import { createFixture, diagnostics, removeFixture, type Fixture } from "./tsc-cost.test-helper.ts";

// Real git and the fake tsc against a temp repo; any other command (such as gh) is refused.
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./tsc-cost.test-helper.ts")).guardChildProcess(await importOriginal()),
);

describe("main against a real git repository and a fake tsc", () => {
  let fixture: Fixture;
  let dir: string;

  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();

  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };

  beforeEach(() => {
    isolateGitEnv();
    fixture = createFixture();
    dir = fixture.dir;
    git("init", "--quiet");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    removeFixture(fixture);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  test("prints the table against origin/main by default, from a subdirectory", async () => {
    const base = commit("base");
    git("update-ref", "refs/remotes/origin/main", base);
    mkdirSync(join(dir, "sub"));

    await main([], join(dir, "sub"));

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("types              100     100    0.0%"),
    );
    expect(process.exitCode).toBeUndefined();
  });

  test("reads its arguments and directory from the process by default", async () => {
    commit("base");
    vi.spyOn(process, "argv", "get").mockReturnValue(["node", "tsc-cost.ts", "HEAD"]);
    vi.spyOn(process, "cwd").mockReturnValue(dir);

    await main();

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("types              100"));
  });

  test("takes the base ref from its argument", async () => {
    commit("base");
    writeFileSync(join(dir, "cost.txt"), diagnostics(110, 1000));

    await main(["HEAD"], dir);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("+10.0%"));
  });

  test("fails with a usage line on more than one argument", async () => {
    await main(["a", "b"], dir);

    expect(console.error).toHaveBeenCalledWith("Usage: node scripts/tsc-cost.ts [base-ref]");
    expect(process.exitCode).toBe(1);
    expect(existsSync(fixture.log)).toBe(false);
  });

  test("reports a failure and sets the exit code", async () => {
    commit("base");

    await main(["nope"], dir);

    expect(console.error).toHaveBeenCalledWith('Base ref "nope" is not a commit');
    expect(process.exitCode).toBe(1);
    expect(console.log).not.toHaveBeenCalled();
  });
});
