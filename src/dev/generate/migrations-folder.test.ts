import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate reading the migrations folder", () => {
  it("refuses a misnamed .sql file, naming it, and leaves the Dev database alone", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.current (hash text not null);
      create table public.leftover (a text);
    `);
    const fileSystem = memoryFileSystem({
      ...filesIn("db/migrations", [
        await writeMigration(
          "000001-create-users.sql",
          undefined,
          "create table public.users (id text);\n",
        ),
      ]),
      "db/migrations/create-posts.sql": "create table public.posts (id text);\n",
    });

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem,
        definition: defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow("create-posts.sql: name it like 000001-create-users.sql");
    expect(fileSystem.files.has("db/migrations/current.sql")).toBe(false);
    expect(
      (
        await db.driver.query(
          "select table_name from information_schema.tables where table_schema = 'public'",
        )
      ).rows,
    ).toStrictEqual([{ table_name: "leftover" }]);
  });

  it("refuses a migration that vanishes between listing the folder and reading it", async () => {
    const fileSystem = memoryFileSystem();

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem: {
          ...fileSystem,
          list: async (directory) => [...(await fileSystem.list(directory)), "000001-gone.sql"],
        },
        definition: defineDatabase({ public: {} }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow("db/migrations/000001-gone.sql vanished between listing and reading");
  });
});
