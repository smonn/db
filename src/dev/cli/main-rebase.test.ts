import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";
import { runPrintedStep } from "./printed-step.test-helper.ts";

const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

const cli = useCliProject();

const A = await writeMigration("000001-a.sql", undefined, "create table a (n int);");
const B = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
const X = await writeMigration("000002-x.sql", A.hash, "create table x (n int);");

const RESET_HINT =
  "a Dev database that applied the old files now fails migrate's prefix check; run smonndb reset";

let stdout: string;
let config: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...args,
    ],
    { cwd: cli.dir, encoding: "utf8" },
  );
}

async function commitFiles(message: string, ...files: { filename: string; content: string }[]) {
  await Promise.all(
    files.map(({ filename, content }) => writeFile(join(cli.dir, "migrations", filename), content)),
  );
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/** Main holds A and B; the branch committed X on A, then merged main. */
async function forkedRepo(): Promise<void> {
  git("init", "-q", "-b", "main");
  await commitFiles("a", A);
  git("switch", "-q", "-c", "feature");
  await commitFiles("x", X);
  git("switch", "-q", "main");
  await commitFiles("b", B);
  git("switch", "-q", "feature");
  git("merge", "-q", "--no-edit", "main");
}

function migrationNames(): Promise<string[]> {
  return readdir(join(cli.dir, "migrations")).then((names) => names.toSorted());
}

async function folderContents(): Promise<Record<string, string>> {
  const entries = await Promise.all(
    (await migrationNames()).map(
      async (name) => [name, await readFile(join(cli.dir, "migrations", name), "utf8")] as const,
    ),
  );
  return Object.fromEntries(entries);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

beforeEach(async () => {
  // A git hook running these tests exports GIT_DIR and friends, which would point git at this repo.
  for (const name of Object.keys(process.env).filter((key) => key.startsWith("GIT_"))) {
    vi.stubEnv(name, undefined);
  }
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  await mkdir(join(cli.dir, "migrations"));
  config = join(cli.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: undefined });\n`,
  );
});

describe("main rebase", () => {
  it("moves the branch's file onto --onto's tip, then verifies", async () => {
    await forkedRepo();

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(0);
    expect(stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual(["000001-a.sql", "000002-b.sql", "000003-x.sql"]);
    stdout = "";
    expect(await main(["verify", "--config", config])).toBe(0);
    expect(stdout).toBe("verified 3 migrations\n");
  });

  it("defaults to the remote's default branch", async () => {
    await forkedRepo();
    git("update-ref", "refs/remotes/origin/main", "main");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");

    expect(await main(["rebase", "--config", config])).toBe(0);
    expect(stdout).toContain("rewrote 000002-x.sql as 000003-x.sql\n");
  });

  it("does nothing on a straight chain", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(0);
    expect(stdout).toBe("nothing to rebase onto main\n");
  });

  it("refuses, writing nothing, naming an untracked and a modified migration", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const Y = await writeMigration("000003-y.sql", X.hash, "create table y (n int);");
    await writeFile(join(folder, Y.filename), Y.content);
    await writeFile(join(folder, X.filename), `${X.content}-- edited\n`);
    await writeFile(join(folder, "current.sql"), "select 1;\n");
    const before = await folderContents();

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toBe(
      `${folder} has changes git doesn't hold: 000002-x.sql, 000003-y.sql; set them aside with git -C '${folder}' stash push --include-untracked -- . ':(exclude)current.sql', then rerun rebase\n`,
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

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(0);
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

  it("refuses on a gitignored migration", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);
    await writeFile(join(cli.dir, ".gitignore"), "000003-x.sql\n");

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toContain("has changes git doesn't hold: 000003-x.sql;");
  });

  it("refuses on a leftover .sql.tmp, tracked by git or not", async () => {
    await forkedRepo();
    await writeFile(join(cli.dir, "migrations", "000003-x.sql.tmp"), "half");
    await writeFile(join(cli.dir, ".gitignore"), "*.tmp\n");

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toContain("has changes git doesn't hold: 000003-x.sql.tmp;");
  });

  it("finishes on a rerun after the step it names when a run stopped before its removes", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toBe(
      `${folder} has changes git doesn't hold: 000003-x.sql; set them aside with git -C '${folder}' stash push --include-untracked -- . ':(exclude)current.sql', then rerun rebase\n`,
    );
    runPrintedStep(cli.stderr, cli.dir);

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(0);
    expect(stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual(["000001-a.sql", "000002-b.sql", "000003-x.sql"]);
  });

  it("finishes on a rerun after the step it names when a migration is staged as deleted", async () => {
    await forkedRepo();
    const folder = join(cli.dir, "migrations");
    const X3 = await writeMigration("000003-x.sql", B.hash, "create table x (n int);");
    await writeFile(join(folder, X3.filename), X3.content);
    await writeFile(join(folder, "current.sql"), "select 1;\n");
    git("rm", "-q", join(folder, X.filename));

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toContain("000002-x.sql, 000003-x.sql;");
    runPrintedStep(cli.stderr, cli.dir);

    expect(await folderContents()).toStrictEqual({
      [A.filename]: A.content,
      [B.filename]: B.content,
      [X.filename]: X.content,
      "current.sql": "select 1;\n",
    });
    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(0);
    expect(stdout).toBe(`rewrote 000002-x.sql as 000003-x.sql\n${RESET_HINT}\n`);
    expect(await migrationNames()).toStrictEqual([
      "000001-a.sql",
      "000002-b.sql",
      "000003-x.sql",
      "current.sql",
    ]);
  });

  it("reads the base ref from git, not the working tree", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);
    git("switch", "-q", "-c", "feature");
    await rm(join(cli.dir, "migrations", B.filename));
    await commitFiles("drop b");

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toBe(
      `main has 000002-b.sql, which ${join(cli.dir, "migrations")} lacks; merge main first\n`,
    );
  });

  it("finds no base migrations when the base ref lacks the folder", async () => {
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "empty");
    await commitFiles("a", A);

    expect(await main(["rebase", "--onto", "main~1", "--config", config])).toBe(0);
    expect(stdout).toBe("nothing to rebase onto main~1\n");
  });

  it("exits 1 naming a ref that doesn't resolve", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);

    expect(await main(["rebase", "--onto", "origin/nope", "--config", config])).toBe(1);
    expect(cli.stderr).toBe("origin/nope doesn't name a commit here; fetch it first\n");
  });

  it("exits 1 asking for --onto when the remote's default branch is unknown", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);

    expect(await main(["rebase", "--config", config])).toBe(1);
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

      expect(await main(["rebase", ...onto, "--config", config])).toBe(1);
      expect(cli.stderr).toBe(`the folder ${join(cli.dir, "migrations")} doesn't exist\n`);
    },
  );

  it.each([
    [["--onto", "main"], "rev-parse"],
    [[], "symbolic-ref"],
  ])("exits 1 with git's own error outside a git repository, given %j", async (onto, command) => {
    expect(await main(["rebase", ...onto, "--config", config])).toBe(1);
    expect(cli.stderr).toMatch(
      new RegExp(`^git ${command} failed: fatal: not a git repository\\b.*\\n$`, "u"),
    );
  });

  it("exits 1 saying git can't run when it isn't on PATH", async () => {
    vi.stubEnv("PATH", "");

    expect(await main(["rebase", "--onto", "main", "--config", config])).toBe(1);
    expect(cli.stderr).toBe("can't run git: it isn't installed or isn't on PATH\n");
  });
});
