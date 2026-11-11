import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { isolateGitEnv } from "./git-env.test-helper.ts";
import { main } from "./main.ts";

const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

const cli = useCliProject();

const A = await writeMigration("000001-a.sql", undefined, "create table a (n int);");
const B = await writeMigration("000002-b.sql", A.hash, "create table b (n int);");
const X = await writeMigration("000002-x.sql", A.hash, "create table x (n int);");

let config: string;

function git(...args: string[]): void {
  execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], {
    cwd: cli.dir,
    encoding: "utf8",
  });
}

type File = { filename: string; content: string };

async function writeFiles(...files: File[]): Promise<void> {
  await Promise.all(
    files.map(({ filename, content }) => writeFile(join(cli.dir, "migrations", filename), content)),
  );
}

async function commitFiles(message: string, ...files: File[]) {
  await writeFiles(...files);
  git("add", "-A");
  git("commit", "-q", "-m", message);
}

/** The one document `--json` printed: a single line of JSON. */
function printed(): unknown {
  expect(cli.stdout.endsWith("\n")).toBe(true);
  expect(cli.stdout.trimEnd()).not.toContain("\n");
  return JSON.parse(cli.stdout);
}

beforeEach(async () => {
  isolateGitEnv();
  await mkdir(join(cli.dir, "migrations"));
  config = join(cli.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${defineConfigUrl}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: undefined });\n`,
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("main verify --json", () => {
  it("prints the files it checked, and nothing on stderr", async () => {
    await writeFiles(A, B);

    expect(await main(["verify", "--json", "--config", config])).toBe(0);
    expect(printed()).toStrictEqual({
      command: "verify",
      ok: true,
      verified: ["000001-a.sql", "000002-b.sql"],
    });
    expect(cli.stderr).toBe("");
  });

  it("prints a chain_broken failure instead of text, and exits 1", async () => {
    await writeFiles(A, { ...B, content: B.content.replace("table b", "table bb") });

    expect(await main(["verify", "--json", "--config", config])).toBe(1);
    expect(printed()).toMatchObject({
      command: "verify",
      ok: false,
      error: {
        code: "chain_broken",
        message: expect.stringMatching(/^000002-b\.sql: --! Hash says /u) as unknown,
      },
    });
    expect(cli.stderr).toBe("");
  });

  it("prints a failed failure when the config file is missing", async () => {
    expect(await main(["verify", "--json", "--config", join(cli.dir, "missing.config.ts")])).toBe(
      1,
    );
    expect(printed()).toMatchObject({
      command: "verify",
      ok: false,
      error: { code: "failed", message: expect.stringContaining("missing.config.ts") as unknown },
    });
  });
});

describe("main rebase --json", () => {
  it("prints onto and each move", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);
    git("switch", "-q", "-c", "feature");
    await commitFiles("x", X);
    git("switch", "-q", "main");
    await commitFiles("b", B);
    git("switch", "-q", "feature");
    git("merge", "-q", "--no-edit", "main");

    expect(await main(["rebase", "--onto", "main", "--json", "--config", config])).toBe(0);
    expect(printed()).toStrictEqual({
      command: "rebase",
      ok: true,
      onto: "main",
      moved: [{ from: "000002-x.sql", to: "000003-x.sql" }],
    });
    expect(cli.stderr).toBe("");
  });

  it("prints an empty move list when there is nothing to rebase", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and b", A, B);

    expect(await main(["rebase", "--onto", "main", "--json", "--config", config])).toBe(0);
    expect(printed()).toStrictEqual({ command: "rebase", ok: true, onto: "main", moved: [] });
  });

  it("prints a failed failure when git holds changes the rebase would overwrite", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a", A);
    await writeFile(join(cli.dir, "migrations", B.filename), B.content);

    expect(await main(["rebase", "--onto", "main", "--json", "--config", config])).toBe(1);
    expect(printed()).toMatchObject({
      command: "rebase",
      ok: false,
      error: {
        code: "failed",
        message: expect.stringContaining("has changes git doesn't hold: 000002-b.sql") as unknown,
      },
    });
  });

  it("prints a chain_broken failure when the base ref's chain is broken", async () => {
    git("init", "-q", "-b", "main");
    await commitFiles("a and tampered b", A, { ...B, content: B.content.replace("table b", "t") });

    expect(await main(["rebase", "--onto", "main", "--json", "--config", config])).toBe(1);
    expect(printed()).toMatchObject({
      command: "rebase",
      ok: false,
      error: {
        code: "chain_broken",
        message: expect.stringMatching(/^main: 000002-b\.sql: --! Hash says /u) as unknown,
      },
    });
  });
});

describe("main --json with a usage error", () => {
  it.each([
    [["--json"], null, "name a command"],
    [["deploy", "--json"], null, "unknown command deploy"],
    [["commit", "--json"], "commit", "commit takes one argument, the slug"],
    [["verify", "now", "--json"], "verify", "verify takes no arguments: now"],
    [["verify", "--onto", "main", "--json"], "verify", "--onto applies only to rebase"],
    [["migrate", "--url", "x", "--json"], "migrate", "Unknown option '--url'"],
    [["commit", "a", "--accept", "drop", "--json"], "commit", 'unknown Hazard kind "drop"'],
    [["generate", "--json"], "generate", "generate doesn't take --json yet"],
    [["verify", "--json=1"], "verify", "Option '--json' does not take an argument"],
  ])(
    "prints a usage failure for %j, exits 2, and leaves stderr empty",
    async (argv, command, text) => {
      expect(await main(argv)).toBe(2);
      expect(printed()).toMatchObject({
        command,
        ok: false,
        error: { code: "usage", message: expect.stringContaining(text) as unknown },
      });
      expect(cli.stderr).toBe("");
    },
  );

  it("ignores a --json after --", async () => {
    expect(await main(["verify", "--", "--json"])).toBe(2);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("verify takes no arguments: --json");
  });

  it("still prints text and the usage without --json", async () => {
    expect(await main(["deploy"])).toBe(2);
    expect(cli.stdout).toBe("");
    expect(cli.stderr).toContain("unknown command deploy");
    expect(cli.stderr).toContain("usage: smonndb");
  });
});
