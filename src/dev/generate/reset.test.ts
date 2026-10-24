import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import type { Driver } from "../../runtime/ports/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { commit } from "./commit.ts";
import { generate } from "./generate.ts";
import {
  filesIn,
  memoryFileSystem,
  type MemoryFileSystem,
} from "./memory-file-system.test-helper.ts";
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

async function markedDevDatabaseWithData(): Promise<void> {
  await reset({ driver: db.driver, fileSystem: memoryFileSystem(), migrations: MIGRATIONS });
  await db.driver.execute(
    "create table public.keep (id int); insert into public.keep values (1), (2); create schema extra; create table extra.junk (id int)",
  );
}

async function survives(): Promise<void> {
  expect(await tables()).toStrictEqual([
    "extra.junk",
    "public.keep",
    "smonn_db.current",
    "smonn_db.migrations",
  ]);
  expect((await db.driver.query("select id from public.keep order by id")).rows).toStrictEqual([
    { id: 1 },
    { id: 2 },
  ]);
}

describe("reset", () => {
  it.each([{ erase: false }, { erase: true }])(
    "refuses a server older than Postgres 18 after one version query and before it executes anything, with erase: $erase",
    async ({ erase }) => {
      const queries: string[] = [];
      const executed: string[] = [];
      const driver: Driver = {
        execute: (sql) => {
          executed.push(sql);
          return Promise.resolve();
        },
        query: (sql) => {
          queries.push(sql);
          return Promise.resolve({ rows: [{ server_version_num: "170006" }], count: 1 });
        },
        session: () => Promise.reject(new Error("unexpected session")),
        transaction: () => Promise.reject(new Error("unexpected transaction")),
      };

      await expect(
        reset({ driver, fileSystem: memoryFileSystem(), migrations: MIGRATIONS, erase }),
      ).rejects.toThrow("smonn/db needs Postgres 18 or newer, and this server runs Postgres 17");
      expect(queries).toHaveLength(1);
      expect(queries[0]).toContain("server_version_num");
      expect(executed).toStrictEqual([]);
    },
  );

  it("replays the Committed migrations and current.sql into a marked Database", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "create-users",
      accept: [],
    });
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

  it("refuses a broken hash chain, naming the file, before it drops anything", async () => {
    const fileSystem = memoryFileSystem();
    await generateInto(fileSystem);
    await commit({
      driver: db.driver,
      fileSystem,
      migrations: MIGRATIONS,
      slug: "create-users",
      accept: [],
    });
    const file = `${MIGRATIONS}/000001-create-users.sql`;
    fileSystem.files.set(file, `${fileSystem.files.get(file)}\nselect 1;\n`);
    await db.driver.execute("create schema extra; create table extra.junk (id int)");
    const before = await tables();

    await expect(reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS })).rejects.toThrow(
      /^000001-create-users\.sql: --! Hash says /u,
    );

    expect(await tables()).toStrictEqual(before);
    expect(before).toContain("extra.junk");
  });

  describe("when the replay fails", () => {
    it("leaves the Dev database as it was when current.sql has a SQL error", async () => {
      await markedDevDatabaseWithData();
      const fileSystem = memoryFileSystem({
        [CURRENT]: "create table public.notes (id int);\nselect * from public.missing;\n",
      });

      await expect(
        reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS }),
      ).rejects.toThrow(`relation "public.missing" does not exist`);

      await survives();
    });

    it("leaves the Dev database as it was when a Committed migration has a SQL error", async () => {
      await markedDevDatabaseWithData();
      const first = await writeMigration("000001-broken.sql", undefined, "select * from missing;");
      const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [first]));

      await expect(
        reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS }),
      ).rejects.toThrow("000001-broken.sql");

      await survives();
    });

    it("names the Committed migration that fails after an earlier one applied", async () => {
      await markedDevDatabaseWithData();
      const first = await writeMigration("000001-ok.sql", undefined, "create table ok (id int);");
      const second = await writeMigration(
        "000002-broken.sql",
        first.hash,
        "select * from missing;",
      );
      const fileSystem = memoryFileSystem(filesIn(MIGRATIONS, [first, second]));

      await expect(
        reset({ driver: db.driver, fileSystem, migrations: MIGRATIONS }),
      ).rejects.toThrow("000002-broken.sql");

      await survives();
    });
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
