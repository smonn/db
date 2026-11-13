import { rm } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";
import { A, B, useRebaseProject } from "./rebase-project.test-helper.ts";

const project = useRebaseProject();
const { cli, git, commitFiles, forkedRepo, migrationNames } = project;

const RESET_HINT =
  "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset";

describe("main rebase", () => {
  it("moves the branch's file onto --onto's tip, then verifies", async () => {
    await forkedRepo();

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual(["000001-a.sql", "000002-b.sql", "000003-x.sql"]);
    project.clearStdout();
    expect(await main(["verify", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe("verified 3 migrations\n");
  });

  it("defaults to the remote's default branch", async () => {
    await forkedRepo();
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    expect(await main(["rebase", "--config", project.config])).toBe(0);
    expect(project.stdout).toContain("rewrote 000002-x.sql as 000003-x.sql\n");
  });

  it("does nothing on a straight chain", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe("nothing to rebase onto main\n");
  });

  it("reads the base ref from git, not the working tree", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);
    git("switch", "-q", "-c", "feature");
    await rm(join(cli.dir, "migrations", B.filename));
    await commitFiles("drop b");

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe(
      `main has 000002-b.sql, which ${join(cli.dir, "migrations")} lacks; merge main first\n`,
    );
  });

  it("finds no base migrations when the base ref lacks the folder", async () => {
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "empty");
    await commitFiles("a", A);

    expect(await main(["rebase", "--onto", "main~1", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe("nothing to rebase onto main~1\n");
  });

  it("exits 1 naming a ref that doesn't resolve", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);

    expect(await main(["rebase", "--onto", "origin/nope", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe("origin/nope doesn't name a commit here; fetch it first\n");
  });

  it("exits 1 asking for --onto when the remote's default branch is unknown", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);

    expect(await main(["rebase", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe(
      "can't find the remote's default branch: pass --onto <ref>, or run git remote set-head origin --auto\n",
    );
  });

  it.each([[["--onto", "HEAD"]], [[]]])(
    "exits 1 naming a missing folder as verify does, given %j",
    async (onto) => {
      git("init", "-q", "-b", "main");
      git("commit", "-q", "--allow-empty", "-m", "empty");
      await rm(join(cli.dir, "migrations"), { recursive: true });

      expect(await main(["rebase", ...onto, "--config", project.config])).toBe(1);
      expect(cli.stderr).toBe(`the folder ${join(cli.dir, "migrations")} doesn't exist\n`);
    },
  );

  it.each([
    [["--onto", "main"], "rev-parse"],
    [[], "symbolic-ref"],
  ])("exits 1 with git's own error outside a git repository, given %j", async (onto, command) => {
    expect(await main(["rebase", ...onto, "--config", project.config])).toBe(1);
    expect(cli.stderr).toMatch(
      new RegExp(`^git ${command} failed: fatal: not a git repository\\b.*\\n$`, "u"),
    );
  });

  it("exits 1 saying git can't run when it isn't on PATH", async () => {
    vi.stubEnv("PATH", "");

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe("can't run git: it isn't installed or isn't on PATH\n");
  });
});
