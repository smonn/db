import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate, type GenerateOptions } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

const generateFrom = async (definition: GenerateOptions["definition"], sql: string) =>
  generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem: memoryFileSystem(
      filesIn("db/migrations", [await writeMigration("000001-start.sql", undefined, sql)]),
    ),
    definition,
    migrations: "db/migrations",
  });

const thing = defineTable((c) => ({ id: c.text().notNull(), name: c.text() }));

describe("generate with an enum retype", () => {
  it("retypes a text column to an enum in a migration the Shadow verifies", async () => {
    const mood = defineEnum(["a", "b"]);
    const definition = defineDatabase({
      public: { mood, users: defineTable((c) => ({ mood: c.enum(mood) })) },
    });

    const result = await generateFrom(
      definition,
      "create table public.users (mood text); insert into public.users values ('b');",
    );

    expect(result.sql).toContain(`type public.mood using "mood"::text::public.mood;`);
    const { rows } = await db.driver.query("select mood::text as mood from public.users");
    expect(rows.map((row) => row["mood"])).toStrictEqual(["b"]);
  });
});

describe("generate with a table that replaces a type of its name", () => {
  it.each([
    ["an enum", "create type public.thing as enum ('a');"],
    ["a domain", "create domain public.thing as text check (value <> 'x');"],
  ])("replaces %s in a migration the Shadow verifies", async (_name, start) => {
    const result = await generateFrom(defineDatabase({ public: { thing } }), start);

    expect(result.sql).toContain(`create table "public"."thing"`);
    expect(result.sql).not.toContain("add column");
    const { rows } = await db.driver.query(
      "select count(*)::int as n from information_schema.columns where table_name = 'thing'",
    );
    expect(rows[0]?.["n"]).toBe(2);
  });
});
