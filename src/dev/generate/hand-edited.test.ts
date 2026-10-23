import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { sha256 } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { memoryFileSystem } from "./memory-file-system.test-helper.ts";

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
    const { rows } = await db.driver.query(
      "select 1 from information_schema.tables where table_schema = 'smonn_db'",
    );
    expect(rows).toStrictEqual([]);
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
