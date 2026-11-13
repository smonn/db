import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import { main } from "./main.ts";
import { RESTORE_HINT, runPrintedStep } from "./printed-step.test-helper.ts";
import { A, B, useRebaseProject, X } from "./rebase-project.test-helper.ts";

const project = useRebaseProject();
const { cli, git, forkedRepo, migrationNames, folderContents } = project;

const RESET_HINT =
  "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset";

describe("main rebase, with files git doesn't hold", () => {
  it("refuses, writing nothing, naming an untracked and a modified migration", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const Y = await writeMigration("000003-y.sql", X.hash, "create table y (n int);");
    await writeFile(join(folder, Y.filename), Y.content);
    await writeFile(join(folder, X.filename), `${X.content}-- edited\n`);
    await writeFile(join(folder, "current.sql"), "select 1;\n");
    const before = await folderContents();

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe(
      `${folder} has changes git doesn't hold: 000002-x.sql, 000003-y.sql; set them aside with git -C '${folder}' stash push --all -- . ':(exclude)current.sql', then rerun rebase. ${RESTORE_HINT}\n`,
    );
    expect(await folderContents()).toStrictEqual(before);
  });

  it("ignores untracked junk, nested files, and a changed current.sql", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    await writeFile(join(folder, ".DS_Store"), "junk");
    await writeFile(join(folder, "x.sql.swp"), "junk");
    await mkdir(join(folder, "sub"));
    await writeFile(join(folder, "sub", "nested.sql"), "select 1;\n");
    await writeFile(join(folder, "current.sql"), "select 1;\n");

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(await migrationNames()).toStrictEqual([
      ".DS_Store",
      "000001-a.sql",
      "000002-b.sql",
      "000003-x.sql",
      "current.sql",
      "sub",
      "x.sql.swp",
    ]);
  });

  it("refuses on a gitignored migration and .sql.tmp, then finishes after the step it names", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);
    await writeFile(join(folder, "000003-y.sql.tmp"), "half");
    await writeFile(join(cli.dir, ".gitignore"), "000003-x.sql\n*.tmp\n");

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toContain("000003-x.sql, 000003-y.sql.tmp;");
    runPrintedStep(cli.stderr, cli.dir);

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(await migrationNames()).toStrictEqual(["000001-a.sql", "000002-b.sql", "000003-x.sql"]);
  });

  it("finishes on a rerun after the step it names when a run stopped before its removes", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toBe(
      `${folder} has changes git doesn't hold: 000003-x.sql; set them aside with git -C '${folder}' stash push --all -- . ':(exclude)current.sql', then rerun rebase. ${RESTORE_HINT}\n`,
    );
    runPrintedStep(cli.stderr, cli.dir);

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual(["000001-a.sql", "000002-b.sql", "000003-x.sql"]);
  });

  it("restores a stashed file whose name rebase then writes, after the named file moves aside", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table stashed (n int);");
    const Z4 = await writeMigration("000004-z.sql", X3.hash, "create table other (n int);");
    await writeFile(join(folder, X3.filename), X3.content);
    await writeFile(join(folder, Z4.filename), Z4.content);
    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toContain(RESTORE_HINT);
    runPrintedStep(cli.stderr, cli.dir);
    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    const rebased = await readFile(join(folder, "000003-x.sql"), "utf8");

    expect(() => git("stash", "pop")).toThrow(/already exists, no checkout/u);
    expect(git("stash", "list")).not.toBe("");
    expect(await readFile(join(folder, Z4.filename), "utf8")).toBe(Z4.content);
    await rename(join(folder, "000003-x.sql"), join(cli.dir, "rebased.sql"));
    git("restore", "--source=stash@{0}^3", "--", "migrations/000003-x.sql");
    git("stash", "drop");

    expect(await readFile(join(folder, "000003-x.sql"), "utf8")).toBe(X3.content);
    expect(await readFile(join(cli.dir, "rebased.sql"), "utf8")).toBe(rebased);
    expect(git("stash", "list")).toBe("");
  });

  it("restores a gitignored folder from the repository root, where git -C the folder can't enter it", async () => {
    git("init", "-q", "-b", "main");
    await writeFile(join(cli.dir, ".gitignore"), "migrations/*.sql\n");
    git("add", ".gitignore");
    git("commit", "-q", "-m", "ignore");
    const folder = join(cli.dir, "migrations");
    await writeFile(join(folder, X.filename), X.content);
    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toContain(RESTORE_HINT);
    runPrintedStep(cli.stderr, cli.dir);
    await expect(readdir(folder)).rejects.toThrow(/ENOENT/u);

    expect(() => git("-C", folder, "stash", "pop")).toThrow(/cannot change to/u);
    git("stash", "pop");

    expect(await readFile(join(folder, X.filename), "utf8")).toBe(X.content);
  });

  it("finishes on a rerun after the step it names when a migration is staged as deleted", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);
    await writeFile(join(folder, "current.sql"), "select 1;\n");
    git("rm", "-q", join(folder, X.filename));

    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(1);
    expect(cli.stderr).toContain("000002-x.sql, 000003-x.sql;");
    runPrintedStep(cli.stderr, cli.dir);

    expect(await folderContents()).toStrictEqual({
      [A.filename]: A.content,
      [B.filename]: B.content,
      [X.filename]: X.content,
      "current.sql": "select 1;\n",
    });
    expect(await main(["rebase", "--onto", "main", "--config", project.config])).toBe(0);
    expect(project.stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual([
      "000001-a.sql",
      "000002-b.sql",
      "000003-x.sql",
      "current.sql",
    ]);
  });
});
