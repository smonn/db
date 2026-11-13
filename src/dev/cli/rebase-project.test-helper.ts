import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, vi } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import type { MigrationFile } from "../../runtime/ports/index.ts";
import { useCliProject, type CliProject } from "./cli-project.test-helper.ts";
import { isolateGitEnv } from "./git-env.test-helper.ts";

const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

type Written = MigrationFile & { readonly hash: string };

export const A: Written = await writeMigration(
  "000001-a.sql",
  undefined,
  "create table a (n int);",
);
export const B: Written = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
export const X: Written = await writeMigration("000002-x.sql", A.hash, "create table x (n int);");

export type RebaseProject = {
  readonly cli: CliProject;
  /** The path of the project's config file. */
  readonly config: string;
  /** Everything `main` wrote to stdout in this test. */
  readonly stdout: string;
  readonly clearStdout: () => void;
  /** Runs git in the project directory, as a test user. */
  readonly git: (...args: string[]) => string;
  readonly commitFiles: (message: string, ...files: MigrationFile[]) => Promise<void>;
  /** Main holds A and B; the branch committed X on A, then merged main. */
  readonly forkedRepo: () => Promise<void>;
  readonly migrationNames: () => Promise<string[]>;
  readonly folderContents: () => Promise<Record<string, string>>;
};

type Git = RebaseProject["git"];

function gitIn(dir: () => string): Git {
  return (...args) =>
    execFileSync(
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
      { cwd: dir(), encoding: "utf8" },
    );
}

function repoOps(
  cli: CliProject,
  git: Git,
): Pick<RebaseProject, "commitFiles" | "forkedRepo" | "migrationNames" | "folderContents"> {
  const commitFiles: RebaseProject["commitFiles"] = async (message, ...files) => {
    await Promise.all(
      files.map(({ filename, content }) =>
        writeFile(join(cli.dir, "migrations", filename), content),
      ),
    );
    git("add", "-A");
    git("commit", "-q", "-m", message);
  };
  const migrationNames = (): Promise<string[]> =>
    readdir(join(cli.dir, "migrations")).then((names) => names.toSorted());
  return {
    commitFiles,
    migrationNames,
    forkedRepo: async () => {
      git("init", "-q", "-b", "main");
      await commitFiles("a", A);
      git("switch", "-q", "-c", "feature");
      await commitFiles("x", X);
      git("switch", "-q", "main");
      await commitFiles("b", B);
      git("switch", "-q", "feature");
      git("merge", "-q", "--no-edit", "main");
    },
    folderContents: async () => {
      const entries = await Promise.all(
        (await migrationNames()).map(
          async (name) =>
            [name, await readFile(join(cli.dir, "migrations", name), "utf8")] as const,
        ),
      );
      return Object.fromEntries(entries);
    },
  };
}

/** Gives each test a project with a migrations folder and a config, and git isolated from the machine's. */
export function useRebaseProject(): RebaseProject {
  const cli = useCliProject();
  let stdout = "";
  let config = "";

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    isolateGitEnv();
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

  const git = gitIn(() => cli.dir);
  return {
    cli,
    get config() {
      return config;
    },
    get stdout() {
      return stdout;
    },
    clearStdout: () => {
      stdout = "";
    },
    git,
    ...repoOps(cli, git),
  };
}
