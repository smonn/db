import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failure, outsideAnyRepository, useGitRepo } from "./git-repo.test-helper.ts";
import { gitMigrationSource, unheldPaths } from "./git.ts";

const repo = useGitRepo();

describe("gitMigrationSource", () => {
  it("lists the Committed migrations of the commit, sorted, with the commit's content", async () => {
    await repo.write("migrations/000002-b.sql", "-- b\n");
    await repo.write("migrations/000001-a.sql", "-- a\n");
    await repo.write("migrations/notes.txt", "not a migration\n");
    await repo.write("migrations/nested/000003-c.sql", "-- nested\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "migrations");
    await repo.write("migrations/000001-a.sql", "-- edited after the commit\n");
    await repo.write("migrations/000004-d.sql", "-- untracked\n");

    const files = await gitMigrationSource(join(repo.dir, "migrations"), "main").list();

    expect(files).toStrictEqual([
      { filename: "000001-a.sql", content: "-- a\n" },
      { filename: "000002-b.sql", content: "-- b\n" },
    ]);
  });

  it("lists nothing for a folder the commit lacks", async () => {
    repo.git("commit", "-q", "--allow-empty", "-m", "root");
    await mkdir(join(repo.dir, "migrations"));

    const files = await gitMigrationSource(join(repo.dir, "migrations"), "main").list();

    expect(files).toStrictEqual([]);
  });

  it("asks the user to fetch a ref that names no commit, keeping the cause", async () => {
    repo.git("commit", "-q", "--allow-empty", "-m", "root");

    const error = await failure(gitMigrationSource(repo.dir, "origin/gone").list());

    expect(error.message).toBe("origin/gone doesn't name a commit here; fetch it first");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("passes on a git failure that isn't a missing ref", async () => {
    const error = await outsideAnyRepository((outside) =>
      failure(gitMigrationSource(outside, "main").list()),
    );

    expect(error.message).toMatch(/^git rev-parse failed: .*not a git repository/u);
  });
});

describe("unheldPaths", () => {
  it("lists exactly the modified, untracked, and ignored paths, relative to the directory", async () => {
    await repo.write(".gitignore", "ignored.txt\n");
    await repo.write("migrations/000001-a.sql", "-- a\n");
    await repo.write("migrations/kept.sql", "-- kept\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "migrations");
    await repo.write("migrations/000001-a.sql", "-- edited\n");
    await repo.write("migrations/new.sql", "-- new\n");
    await repo.write("migrations/ignored.txt", "ignored\n");
    await repo.write("outside.sql", "-- outside the directory\n");

    const paths = await unheldPaths(join(repo.dir, "migrations"));

    expect(paths.toSorted()).toStrictEqual(["000001-a.sql", "ignored.txt", "new.sql"]);
  });

  it("lists nothing when the directory matches the last commit", async () => {
    await repo.write("migrations/000001-a.sql", "-- a\n");
    repo.git("add", "-A");
    repo.git("commit", "-q", "-m", "migrations");

    expect(await unheldPaths(join(repo.dir, "migrations"))).toStrictEqual([]);
  });
});
