import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import type { Project } from "./project.ts";
import { run } from "./run.ts";

const db = useTestDatabase();
const dev = useTestDatabase();

let folder: string;
let stdout: string;
let stderr: string;

beforeEach(async () => {
  previousHash = undefined;
  folder = await mkdtemp(join(tmpdir(), "smonn-db-run-"));
  await mkdir(join(folder, "migrations"));
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(folder, { recursive: true, force: true });
});

function projectWith(overrides: Partial<Project> = {}): Project {
  return {
    definition: "./definition.ts",
    migrations: "./migrations",
    url: db.url,
    migrationsFolder: join(folder, "migrations"),
    loadDefinition: () => Promise.resolve(defineDatabase({ public: {} })),
    ...overrides,
  };
}

it("migrates into the config's trackingSchema, naming each file it applied", async () => {
  await writeMigrationFile("000001-first.sql", "select 1;\n");
  await writeMigrationFile("000002-second.sql", "select 2;\n");

  await run({ name: "migrate", config: "c" }, projectWith({ trackingSchema: "run_tracking" }));

  expect(stdout).toBe("applied 000001-first.sql\napplied 000002-second.sql\n");
  const { rows } = await db.driver.query(
    "select to_regclass('run_tracking.migrations') is not null as present",
  );
  expect(rows).toStrictEqual([{ present: true }]);
});

it("says there is nothing to apply when every file is recorded", async () => {
  await writeMigrationFile("000001-first.sql", "select 1;\n");
  const project = projectWith({ trackingSchema: "run_tracking_again" });
  await run({ name: "migrate", config: "c" }, project);
  stdout = "";

  await run({ name: "migrate", config: "c" }, project);

  expect(stdout).toBe("nothing to apply\n");
});

it("closes its connections once the command settles", async () => {
  const applicationName = "smonn_db_run_test_close";
  const url = new URL(db.url);
  url.searchParams.set("application_name", applicationName);

  await run({ name: "migrate", config: "c" }, projectWith({ url: url.href }));

  await vi.waitFor(async () => {
    const { rows } = await db.driver.query(
      "select count(*)::int as open from pg_stat_activity where application_name = $1",
      [applicationName],
    );
    expect(rows).toStrictEqual([{ open: 0 }]);
  });
});

it("writes a commit's file and prints its path relative to the working directory", async () => {
  const definition = defineDatabase({
    public: { run_commits: defineTable((c) => ({ id: c.text().notNull() })) },
  });
  const project = projectWith({ url: dev.url, loadDefinition: () => Promise.resolve(definition) });
  await run({ name: "generate", config: "c" }, project);
  stdout = "";

  await run({ name: "commit", config: "c", slug: "first", accept: [] }, project);

  expect(stdout).toBe(
    `wrote ${relative(process.cwd(), join(folder, "migrations"))}/000001-first.sql\n`,
  );
});

it("prints each line the Shadow sweep logs to stderr", async () => {
  const stale = "smonn_db_shadow_1_0badc0de";
  await dev.driver.execute(`create database ${stale} template template0`);

  await run({ name: "generate", config: "c" }, projectWith({ url: dev.url }));

  expect(stderr).toBe(`dropped stale database "${stale}"\n`);
});

it("keeps the Shadow replay's server notices out of the output", async () => {
  await writeMigrationFile(
    "000001-notice.sql",
    "do $$ begin raise notice 'shadow replay notice'; end $$;\n",
  );
  const log = vi.spyOn(console, "log").mockImplementation(() => {});

  await run({ name: "generate", config: "c" }, projectWith({ url: dev.url }));

  expect(log).not.toHaveBeenCalled();
});

let previousHash: string | undefined;

async function writeMigrationFile(filename: string, sql: string): Promise<void> {
  const file = await writeMigration(filename, previousHash, sql);
  previousHash = file.hash;
  await writeFile(join(folder, "migrations", file.filename), file.content);
}
