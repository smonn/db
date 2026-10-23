import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { sha256, writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

const definition = defineDatabase({
  public: { users: defineTable((c) => ({ id: c.text() })) },
});

async function generated(body: string): Promise<string> {
  return `--! Generated: sha256:${await sha256(body)}\n\n${body}`;
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

describe("generate with a hand-edited current.sql", () => {
  const LEFTOVER = `the Current migration leaves the Shadow database unlike the Definition database:
  table "public"."users" is missing from the Shadow database
  column "public"."users"."id" is missing from the Shadow database`;
  const USERS_DIFF = '+create table "public"."users" (\n+  "id" text\n+);\n';

  it.each([
    [
      "an edited body",
      async () => `${await generated("select 1;\n")}select 2;\n`,
      "select 1;\nselect 2;\n",
      `-select 1;\n-select 2;\n${USERS_DIFF}`,
    ],
    [
      "no Generated header",
      () => Promise.resolve("select 1;\n"),
      "select 1;\n",
      `-select 1;\n${USERS_DIFF}`,
    ],
  ])("keeps and replays a current.sql with %s", async (_, build, body, diff) => {
    const content = await build();
    const fileSystem = memoryFileSystem({ [CURRENT]: content });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(fileSystem.files.get(CURRENT)).toBe(content);
    expect(result).toStrictEqual({
      path: CURRENT,
      sql: body,
      diff,
      leftover: LEFTOVER,
      reset: true,
      hazards: [],
    });
    const { rows: tables } = await db.driver.query(
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    expect(tables).toStrictEqual([]);
    const { rows: hashes } = await db.driver.query("select hash from smonn_db.current");
    expect(hashes).toStrictEqual([{ hash: `sha256:${await sha256(body)}` }]);
  });

  it("reports an empty diff when the edit still matches what generate would write", async () => {
    const body = 'create table "public"."users" (\n  "id" text\n);\n';
    const fileSystem = memoryFileSystem({
      [CURRENT]: `--! Generated: sha256:${"0".repeat(64)}\n\n${body}`,
    });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result.diff).toBe("");
  });

  it("runs the edit in the Shadow, not the generated body, and reports no leftover when it passes", async () => {
    const body = 'create table "public"."users" (\n  "id" text\n);\n-- by hand\n';
    const fileSystem = memoryFileSystem({ [CURRENT]: body });

    const result = await generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    expect(result.leftover).toBeUndefined();
    expect(result.sql).toBe(body);
  });

  it("fails on a SQL error in the edit and leaves the Dev database untouched", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select * from public.nope;\n" });
    const objects = async () => {
      const { rows } = await db.driver.query(
        `select 'schema' as kind, nspname as name from pg_namespace
         where nspname not like 'pg\\_%' and nspname <> 'information_schema'
         union all
         select 'table', schemaname || '.' || tablename from pg_tables
         where schemaname not in ('pg_catalog', 'information_schema')
         order by 1, 2`,
      );
      return rows;
    };
    const before = await objects();

    await expect(
      generate({
        driver: db.driver,
        connect: db.connect,
        fileSystem,
        definition,
        migrations: "db/migrations",
      }),
    ).rejects.toThrow(/relation "public.nope" does not exist/u);

    expect(fileSystem.files.get(CURRENT)).toBe("select * from public.nope;\n");
    expect(before).toStrictEqual([{ kind: "schema", name: "public" }]);
    expect(await objects()).toStrictEqual(before);
  });

  it("words the hint for a hand edit, not for generated SQL", async () => {
    const fileSystem = memoryFileSystem({
      [CURRENT]:
        "create table public.t (id text); alter table public.t alter column id type integer;\n",
    });

    const failure = generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    await expect(failure).rejects.toThrow(/add the USING clause to the ALTER COLUMN/u);
    await expect(failure).rejects.not.toThrow(/no USING/u);
  });

  it("words the view-column hint for a hand edit, not for generated SQL", async () => {
    const fileSystem = memoryFileSystem({
      [CURRENT]:
        "create table public.t (id text); create view public.v as select id from public.t; alter table public.t alter column id type varchar;\n",
    });

    const failure = generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    await expect(failure).rejects.toThrow(/cannot alter type of a column used by a view/u);
    await expect(failure).rejects.toThrow(/\ndrop or change the view by hand/u);
    await expect(failure).rejects.not.toThrow(/generate never alters/u);
  });

  it("words the blocked-drop hint for a hand edit, not for generated SQL", async () => {
    const fileSystem = memoryFileSystem({
      [CURRENT]:
        "create table public.t (id int); create view public.v as select id from public.t; drop table public.t;\n",
    });

    const failure = generate({
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    });

    await expect(failure).rejects.toThrow(/an Unmodeled object blocks it/u);
    await expect(failure).rejects.not.toThrow(/never uses CASCADE/u);
  });

  it("succeeds with an edit that fixes a body that fails verification on an Unmodeled view", async () => {
    const committed = await writeMigration(
      "000001-users.sql",
      undefined,
      'create table "public"."users" ("id" text, "extra" text);\ncreate view public.v as select extra from public.users;\n',
    );
    const body =
      'drop view public.v;\nalter table "public"."users" drop column "extra";\ncreate view public.v as select id from public.users;\n';
    const fileSystem = memoryFileSystem({
      ...filesIn("db/migrations", [committed]),
      [CURRENT]: body,
    });
    const options = {
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    };
    await fileSystem.remove(CURRENT);
    await expect(generate(options)).rejects.toThrow(
      /^cannot drop column extra of table users because other objects depend on it; generate never uses CASCADE, so an Unmodeled object blocks it:\n {2}view v depends on column extra of table users\n/u,
    );
    await fileSystem.writeFile(CURRENT, body);

    const result = await generate(options);

    expect(result.sql).toBe(body);
    expect(result.leftover).toBeUndefined();
  });

  it("resumes generating once the hand-edited current.sql is deleted", async () => {
    const fileSystem = memoryFileSystem({ [CURRENT]: "select 1;\n" });
    const options = {
      driver: db.driver,
      connect: db.connect,
      fileSystem,
      definition,
      migrations: "db/migrations",
    };
    await generate(options);
    await fileSystem.remove(CURRENT);

    const result = await generate(options);

    expect(result.diff).toBeUndefined();
    expect(fileSystem.files.get(CURRENT)).toBe(await generated(String(result.sql)));
  });
});
