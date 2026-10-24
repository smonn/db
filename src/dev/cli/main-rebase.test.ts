import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

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

  it("reads the base ref from git, not the working tree", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);
    await rm(join(cli.dir, "migrations", B.filename));

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
