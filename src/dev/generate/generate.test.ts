import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { sha256, writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

async function generated(body: string): Promise<string> {
  return `--! Generated: sha256:${await sha256(body)}\n\n${body}`;
}

async function tables(): Promise<unknown> {
  const { rows } = await db.driver.query(`
    select table_schema, table_name, column_name from information_schema.columns
    where table_schema in ('public', 'auth')
    order by table_schema, table_name, ordinal_position`);
  return rows;
}

async function currentHashes(): Promise<unknown> {
  const { rows } = await db.driver.query("select hash from smonn_db.current");
  return rows.map((row) => row["hash"]);
}

beforeEach(async () => {
  await db.driver.execute(
    "drop extension if exists hstore; drop schema if exists smonn_db, auth, ext cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate", () => {
  it("turns a one-table Definition into current.sql and leaves the table in the Dev database", async () => {
    const fileSystem = memoryFileSystem();
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    const body = `create table "public"."users" (\n  "id" text not null,\n  "email" text\n);\n`;
    const hash = `sha256:${await sha256(body)}`;
    expect(result).toStrictEqual({ path: CURRENT, sql: body });
    expect(fileSystem.files.get(CURRENT)).toBe(`--! Generated: ${hash}\n\n${body}`);
    expect(await tables()).toStrictEqual([
      { table_schema: "public", table_name: "users", column_name: "id" },
      { table_schema: "public", table_name: "users", column_name: "email" },
    ]);
    expect(await currentHashes()).toStrictEqual([hash]);
  });

  it("diffs against the Committed migrations and replays them before current.sql", async () => {
    const fileSystem = memoryFileSystem(
      filesIn("db/migrations", [
        await writeMigration(
          "000001-create-users.sql",
          undefined,
          "create table public.users (id text not null);\n",
        ),
      ]),
    );
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
      auth: { sessions: defineTable((c) => ({ token: c.text() })) },
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result.sql).toBe(
      `create schema "auth";

create table "auth"."sessions" (
  "token" text
);

alter table "public"."users" add column "email" text;
`,
    );
    expect(await tables()).toStrictEqual([
      { table_schema: "auth", table_name: "sessions", column_name: "token" },
      { table_schema: "public", table_name: "users", column_name: "id" },
      { table_schema: "public", table_name: "users", column_name: "email" },
    ]);
    expect((await db.driver.query("select filename from smonn_db.migrations")).rows).toStrictEqual([
      { filename: "000001-create-users.sql" },
    ]);
  });

  it("leaves public alone when the Definition doesn't name it", async () => {
    const fileSystem = memoryFileSystem();
    const definition = defineDatabase({
      auth: { sessions: defineTable((c) => ({ token: c.text() })) },
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result.sql).toBe(
      `create schema "auth";\n\ncreate table "auth"."sessions" (\n  "token" text\n);\n`,
    );
  });

  it("refuses an unmarked Database whose public holds a function or type", async () => {
    await db.driver.execute("create type public.mood as enum ('ok')");
    const definition = defineDatabase({ public: {} });

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem: memoryFileSystem(),
        definition,
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(`"${db.name}" isn't a Dev database`);
    expect(
      (await db.driver.query("select typname from pg_type where typname = 'mood'")).rows,
    ).toStrictEqual([{ typname: "mood" }]);
  });

  it("overwrites a current.sql that generate wrote", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: await generated("select 1;\n") });
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text() })) },
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(fileSystem.files.get(CURRENT)).toBe(await generated(String(result.sql)));
  });

  it("refuses an unmarked Database whose public holds a collation", async () => {
    await db.driver.execute(`create collation public.plain from "C"`);

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem: memoryFileSystem(),
        definition: defineDatabase({ public: {} }),
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(`"${db.name}" isn't a Dev database`);
  });

  it("resets a Dev database where an extension owns a schema", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.current (hash text not null);
      create extension hstore;
      create schema ext;
      alter extension hstore add schema ext;
    `);

    await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem: memoryFileSystem(),
      definition: defineDatabase({ public: { users: defineTable((c) => ({ id: c.text() })) } }),
      migrations: "db/migrations",
    });

    expect(await tables()).toStrictEqual([
      { table_schema: "public", table_name: "users", column_name: "id" },
    ]);
    expect(
      (
        await db.driver.query(
          "select nspname from pg_namespace where nspname = 'ext' union all select extname from pg_extension where extname = 'hstore'",
        )
      ).rows,
    ).toStrictEqual([]);
  });

  it("deletes current.sql when the Definition matches the Committed migrations", async () => {
    const fileSystem = memoryFileSystem({
      ...filesIn("db/migrations", [
        await writeMigration(
          "000001-create-users.sql",
          undefined,
          "create table public.users (id text);\n",
        ),
      ]),
      [CURRENT]: await generated("select 1;\n"),
    });
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text() })) },
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result).toStrictEqual({ path: CURRENT, sql: undefined });
    expect(fileSystem.files.has(CURRENT)).toBe(false);
    expect(await tables()).toStrictEqual([
      { table_schema: "public", table_name: "users", column_name: "id" },
    ]);
    expect(await currentHashes()).toStrictEqual([]);
  });

  it("resets a marked Dev database, dropping what the migrations don't create", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.current (hash text not null);
      insert into smonn_db.current values ('sha256:old');
      create table public.leftover (a text);
    `);
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text() })) },
    });

    await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem: memoryFileSystem(),
      definition,
      migrations: "db/migrations",
    });

    expect(await tables()).toStrictEqual([
      { table_schema: "public", table_name: "users", column_name: "id" },
    ]);
    expect(await currentHashes()).toHaveLength(1);
  });

  it("refuses to reset an unmarked Database that holds tables, and writes nothing", async () => {
    await db.driver.execute("create table public.precious (a text)");
    const fileSystem = memoryFileSystem();
    const definition = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text() })) },
    });

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem,
        definition,
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(`"${db.name}" isn't a Dev database`);
    expect(fileSystem.files.size).toBe(0);
    expect(await tables()).toStrictEqual([
      { table_schema: "public", table_name: "precious", column_name: "a" },
    ]);
  });
});
