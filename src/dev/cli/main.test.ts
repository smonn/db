import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const defineConfigUrl = pathToFileURL(join(import.meta.dirname, "../config/index.ts")).href;

const cli = useCliProject();

async function writeConfig(body: string): Promise<string> {
  const file = join(cli.dir, "smonndb.config.ts");
  await writeFile(file, `import { defineConfig } from "${defineConfigUrl}";\n\n${body}`);
  return file;
}

describe("main", () => {
  it.each([
    [[], "name a command"],
    [["deploy"], "unknown command deploy"],
    [["generate", "now"], "generate takes no arguments: now"],
    [["migrate", "a", "b"], "migrate takes no arguments: a b"],
    [["commit"], "commit takes one argument, the slug"],
    [["commit", "a", "b"], "commit takes one argument, the slug"],
    [["migrate", "--url", "postgres://"], "Unknown option '--url'"],
    [["reset", "now"], "reset takes no arguments: now"],
    [["generate", "--erase"], "--erase applies only to reset"],
    [["generate", "--accept", "rewrite"], "--accept applies only to commit"],
    [
      ["commit", "a", "--accept", "rewrite,drop"],
      'unknown Hazard kind "drop"; the kinds are data_loss, rewrite, access_exclusive_lock, share_row_exclusive_lock',
    ],
    [["commit", "a", "--accept", ""], 'unknown Hazard kind ""'],
    [["rebase", "main"], "rebase takes no arguments: main"],
    [["verify", "--onto", "main"], "--onto applies only to rebase"],
  ])("exits 2 with the usage for %j", async (argv, message) => {
    expect(await main(argv)).toBe(2);
    expect(cli.stderr).toContain(message);
    expect(cli.stderr).toContain("usage: smonndb <command> [--config <path>]");
  });

  it("exits 1 when the config file is missing, naming it", async () => {
    expect(await main(["migrate", "--config", join(cli.dir, "missing.config.ts")])).toBe(1);
    expect(cli.stderr).toContain("missing.config.ts");
  });

  it("exits 1 when the config file has no default export", async () => {
    const file = await writeConfig("export const config = {};\n");

    expect(await main(["migrate", "--config", file])).toBe(1);
    expect(cli.stderr).toBe(
      `${relative(process.cwd(), file)} must export defineConfig({ ... }) as its default export\n`,
    );
  });

  it("exits 1 when the config's url is unset", async () => {
    const file = await writeConfig(
      `export default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: undefined });\n`,
    );

    expect(await main(["migrate", "--config", file])).toBe(1);
    expect(cli.stderr).toContain("url is undefined; set the environment variable it reads");
  });

  it("exits 1 when the Definition file has no default export, before connecting", async () => {
    await writeFile(join(cli.dir, "definition.ts"), "export const users = {};\n");
    const file = await writeConfig(
      `export default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: "postgres://localhost:1/none" });\n`,
    );

    expect(await main(["generate", "--config", file])).toBe(1);
    expect(cli.stderr).toBe(
      `${relative(process.cwd(), join(cli.dir, "definition.ts"))} must export defineDatabase({ ... }) as its default export\n`,
    );
  });
});

function writeVerifyConfig(): Promise<string> {
  return writeConfig(
    `export default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: undefined });\n`,
  );
}

async function commitChain(): Promise<void> {
  const a = await writeMigration("000001-a.sql", undefined, "create table a (n int);\n");
  const b = await writeMigration("000002-b.sql", a.hash, "create table b (n int);\n");
  await writeFile(join(cli.dir, "migrations", a.filename), a.content);
  await writeFile(join(cli.dir, "migrations", b.filename), b.content);
}

describe("main verify", () => {
  let stdout: string;

  beforeEach(async () => {
    stdout = "";
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout += String(chunk);
      return true;
    });
    await mkdir(join(cli.dir, "migrations"));
  });

  it("verifies an intact chain without a url or a database", async () => {
    const file = await writeVerifyConfig();
    await commitChain();

    expect(await main(["verify", "--config", file])).toBe(0);
    expect(stdout).toBe("verified 2 migrations\n");
  });

  it("exits 1 naming the first bad file", async () => {
    const file = await writeVerifyConfig();
    await commitChain();
    const path = join(cli.dir, "migrations", "000002-b.sql");
    await writeFile(path, (await readFile(path, "utf8")).replace("table b", "table bb"));

    expect(await main(["verify", "--config", file])).toBe(1);
    expect(cli.stderr).toMatch(/^000002-b\.sql: --! Hash says /u);
  });

  it("exits 1 naming a forked chain's two files and their shared parent", async () => {
    const file = await writeVerifyConfig();
    await commitChain();
    const a = await writeMigration("000001-a.sql", undefined, "create table a (n int);\n");
    const other = await writeMigration("000002-other.sql", a.hash, "create table o (n int);\n");
    await writeFile(join(cli.dir, "migrations", other.filename), other.content);

    expect(await main(["verify", "--config", file])).toBe(1);
    expect(cli.stderr).toBe(
      "forked chain: 000002-b.sql and 000002-other.sql both follow 000001-a.sql\n",
    );
  });

  it("exits 2 given an argument", async () => {
    expect(await main(["verify", "now"])).toBe(2);
    expect(cli.stderr).toContain("verify takes no arguments: now");
  });
});
