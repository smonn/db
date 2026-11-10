import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { useCliProject } from "./cli-project.test-helper.ts";
import { main } from "./main.ts";

const cli = useCliProject();
const dev = useTestDatabase();
const plain = useTestDatabase();
const hazardous = useTestDatabase();
const applying = useTestDatabase();
const blocked = useTestDatabase();
const tampered = useTestDatabase();

const source = (path: string): string => pathToFileURL(join(import.meta.dirname, path)).href;

// The advisory lock key that `generate`, `commit`, and `reset` share on the Dev database.
const DEV_LOCK_KEY = "7666632338";

/** Writes a Definition with one table and a config for `url`, and returns the config's path. */
async function writeProject(url: string): Promise<string> {
  await mkdir(join(cli.dir, "migrations"), { recursive: true });
  await writeFile(
    join(cli.dir, "definition.ts"),
    `import { defineDatabase, defineTable } from "${source("../../runtime/definition/index.ts")}";\n\nexport default defineDatabase({\n  public: { users: defineTable((c) => ({ id: c.text().notNull() })) },\n});\n`,
  );
  const config = join(cli.dir, "smonndb.config.ts");
  await writeFile(
    config,
    `import { defineConfig } from "${source("../config/index.ts")}";\n\nexport default defineConfig({ definition: "./definition.ts", migrations: "./migrations", url: ${JSON.stringify(url)} });\n`,
  );
  return config;
}

/** Runs `main` and reads what it alone printed to stdout: one line of JSON, or nothing. */
async function runJson(argv: readonly string[]): Promise<{ code: number; document: unknown }> {
  const before = cli.stdout.length;
  const code = await main(argv);
  const printed = cli.stdout.slice(before);
  expect(printed.endsWith("\n")).toBe(true);
  expect(printed.trimEnd()).not.toContain("\n");
  return { code, document: JSON.parse(printed) };
}

async function writeCommitted(
  ...scripts: readonly string[]
): Promise<readonly { filename: string; hash: string }[]> {
  const files: { filename: string; hash: string }[] = [];
  let previous: string | undefined;
  for (const [index, sql] of scripts.entries()) {
    const filename = `${String(index + 1).padStart(6, "0")}-step.sql`;
    // oxlint-disable-next-line eslint/no-await-in-loop -- each file chains onto the one before it.
    const file = await writeMigration(filename, previous, sql);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one at a time, in chain order.
    await writeFile(join(cli.dir, "migrations", filename), file.content);
    previous = file.hash;
    files.push({ filename, hash: file.hash });
  }
  return files;
}

describe("main commit --json", () => {
  it("prints the file it wrote, relative to the working directory", async () => {
    const config = await writeProject(dev.url);
    expect(await main(["generate", "--config", config])).toBe(0);

    const { code, document } = await runJson([
      "commit",
      "create-users",
      "--json",
      "--config",
      config,
    ]);

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "commit",
      ok: true,
      file: {
        path: relative(process.cwd(), join(cli.dir, "migrations", "000001-create-users.sql")),
      },
    });
    expect(cli.stderr).toBe("");
  });

  it("prints a hazard_not_accepted failure naming the kinds --accept lacks", async () => {
    const config = await writeProject(hazardous.url);
    expect(await main(["generate", "--config", config])).toBe(0);
    const current = join(cli.dir, "migrations", "current.sql");
    await writeFile(
      current,
      `${await readFile(current, "utf8")}-- hazard: data_loss\ndrop table "public"."users";\n`,
    );

    const { code, document } = await runJson([
      "commit",
      "drop-users",
      "--json",
      "--config",
      config,
    ]);

    expect(code).toBe(1);
    expect(document).toStrictEqual({
      command: "commit",
      ok: false,
      error: {
        code: "hazard_not_accepted",
        message: expect.stringContaining("has Hazards that --accept doesn't name") as unknown,
        kinds: ["data_loss"],
      },
    });
    expect(cli.stderr).toBe("");
  });

  it("prints a locked failure naming the lock while another run holds it", async () => {
    const config = await writeProject(dev.url);

    const { code, document } = await dev.driver.session(async (holder) => {
      await holder.query(`select pg_advisory_lock(${DEV_LOCK_KEY})`);
      try {
        return await runJson(["commit", "x", "--json", "--config", config]);
      } finally {
        await holder.query(`select pg_advisory_unlock(${DEV_LOCK_KEY})`);
      }
    });

    expect(code).toBe(1);
    expect(document).toStrictEqual({
      command: "commit",
      ok: false,
      error: {
        code: "locked",
        message: expect.stringContaining("another generate, commit, or reset holds") as unknown,
        lock: "dev",
      },
    });
  });
});

describe("main reset --json", () => {
  it("prints how many Committed migrations it replayed and whether it replayed current.sql", async () => {
    const config = await writeProject(dev.url);
    expect(await main(["generate", "--config", config])).toBe(0);
    expect(await main(["commit", "create-users", "--config", config])).toBe(0);
    expect(await main(["generate", "--config", config])).toBe(0);
    await writeFile(join(cli.dir, "migrations", "current.sql"), "select 1;\n");

    const { code, document } = await runJson(["reset", "--json", "--config", config]);

    expect(code).toBe(0);
    expect(document).toStrictEqual({ command: "reset", ok: true, committed: 1, current: true });
    expect(cli.stderr).toBe("");
  });

  it("prints a not_dev_database failure for an unmarked Database that isn't empty", async () => {
    const config = await writeProject(plain.url);
    await plain.driver.execute("create table unrelated (n int)");

    const { code, document } = await runJson(["reset", "--json", "--config", config]);

    expect(code).toBe(1);
    expect(document).toStrictEqual({
      command: "reset",
      ok: false,
      error: {
        code: "not_dev_database",
        message: expect.stringContaining("isn't a Dev database") as unknown,
      },
    });
  });
});

describe("main migrate --json", () => {
  it("prints the files it applied", async () => {
    const config = await writeProject(applying.url);
    await writeCommitted("create table json_a (n int);\n", "create table json_b (n int);\n");

    const { code, document } = await runJson(["migrate", "--json", "--config", config]);

    expect(code).toBe(0);
    expect(document).toStrictEqual({
      command: "migrate",
      ok: true,
      applied: ["000001-step.sql", "000002-step.sql"],
    });
    expect(cli.stderr).toBe("");
  });

  it("prints an unmodeled_blocker failure when another object blocks a drop", async () => {
    const config = await writeProject(blocked.url);
    await writeCommitted(
      "create table json_t (n int); create view json_v as select n from json_t;\n",
      "drop table json_t;\n",
    );

    const { code, document } = await runJson(["migrate", "--json", "--config", config]);

    expect(code).toBe(1);
    expect(document).toMatchObject({
      command: "migrate",
      ok: false,
      error: {
        code: "unmodeled_blocker",
        message: expect.stringContaining("000002-step.sql rolled back") as unknown,
      },
    });
  });

  it("prints a chain_broken failure when an applied file changed", async () => {
    const config = await writeProject(tampered.url);
    await writeCommitted("create table json_c (n int);\n");
    expect(await main(["migrate", "--config", config])).toBe(0);
    const changed = await writeMigration(
      "000001-step.sql",
      undefined,
      "create table json_d (n int);\n",
    );
    await writeFile(join(cli.dir, "migrations", changed.filename), changed.content);

    const { code, document } = await runJson(["migrate", "--json", "--config", config]);

    expect(code).toBe(1);
    expect(document).toMatchObject({
      command: "migrate",
      ok: false,
      error: {
        code: "chain_broken",
        message: expect.stringMatching(/^000001-step\.sql: recorded as /u) as unknown,
      },
    });
  });
});
