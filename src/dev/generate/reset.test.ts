import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem, type MemoryFileSystem } from "./memory-file-system.test-helper.ts";
import { reset } from "./reset.ts";

const db = useTestDatabase();

const MIGRATIONS = "db/migrations";
const CURRENT = `${MIGRATIONS}/current.sql`;

const users = defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } });
const withEmail = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text(), email: c.text() })) },
});

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema if exists extra cascade; drop schema if exists tracking cascade; drop schema public cascade; create schema public;",
  );
});

async function generateInto(fileSystem: MemoryFileSystem, definition = users): Promise<void> {
  await generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: MIGRATIONS,
  });
}

async function tables(): Promise<unknown[]> {
  const { rows } = await db.driver.query(
    "select table_schema || '.' || table_name as name from information_schema.tables where table_schema not in ('pg_catalog', 'information_schema') order by 1",
  );
  return rows.map((row) => row["name"]);
}

describe("reset", () => {
  it("replays the Committed migrations and current.sql into a marked Database", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await commit({ driver: db.driver, fileSystem, migrations: MIGRATIONS, slug: "create-users" });
    await generateInto(fileSystem, withEmail);
    await db.driver.execute("create schema extra; create table extra.junk (id int)");

    await reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS });

    expect(await tables()).toStrictEqual([
      "public.users",
      "smonn_db.current",
      "smonn_db.migrations",
    ]);
    const { rows } = await db.driver.query(
      "select column_name from information_schema.columns where table_name = 'users' order by 1",
    );
    expect(rows).toStrictEqual([{ column_name: "email" }, { column_name: "id" }]);
    expect((await db.driver.query("select hash from smonn_db.current")).rows).toHaveLength(1);
  });

  it("runs on an empty Database and marks it", async () => {
    await reset({ driver: db.driver, fileSystem: memoryFileSystem(), migrations: MIGRATIONS });

    expect(await tables()).toStrictEqual(["smonn_db.current", "smonn_db.migrations"]);
  });

  it("replays a hand-edited current.sql as written", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "create table public.notes (id int);\n" });

    await reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS });

    expect(await tables()).toStrictEqual([
      "public.notes",
      "smonn_db.current",
      "smonn_db.migrations",
    ]);
    expect(fileSystem.files.get(CURRENT)).toBe("create table public.notes (id int);\n");
  });

  it("refuses an unmarked, non-empty Database and leaves it alone", async () => {
    await db.driver.execute("create table public.precious (id int)");
    const attempt = reset({
      driver: db.driver,
      fileSystem: memoryFileSystem(),
      migrations: MIGRATIONS,
    });

    await expect(attempt).rejects.toThrow(
      `"${db.name}" isn't a Dev database: it has no "smonn_db"."current" table`,
    );
    await expect(attempt).rejects.toThrow("--erase");
    expect(await tables()).toStrictEqual(["public.precious"]);
  });

  it("erases an unmarked Database when asked, and marks it", async () => {
    await db.driver.execute("create table public.precious (id int)");

    await reset({
      driver: db.driver,
      fileSystem: memoryFileSystem(),
      migrations: MIGRATIONS,
      erase: true,
    });

    expect(await tables()).toStrictEqual(["smonn_db.current", "smonn_db.migrations"]);
  });

  it("checks the mark in a custom tracking schema", async () => {
    await db.driver.execute("create table public.precious (id int)");

    await expect(
      reset({
        driver: db.driver,
        fileSystem: memoryFileSystem(),
        migrations: MIGRATIONS,
        trackingSchema: "tracking",
      }),
    ).rejects.toThrow(`it has no "tracking"."current" table`);
  });
});
