import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";
import { relabeled, withMood } from "./enums.test-helper.ts";

const db = useTestDatabase();

/** Runs `from` in the database, then returns the SQL that turns it into `to`. */
async function migrate(from: Catalog | string, to: Catalog): Promise<string> {
  await db.driver.execute(
    typeof from === "string" ? from : bareDiff(await introspect(db.driver), from),
  );
  return diff(await introspect(db.driver), to).sql;
}

/** Applies `sql` and returns what still separates the database from `to`. */
async function remaining(sql: string, to: Catalog): Promise<string> {
  await db.driver.execute(sql);
  return diff(await introspect(db.driver), to).sql;
}

async function values(query: string): Promise<unknown[]> {
  const { rows } = await db.driver.query(query);
  return rows.map((row) => row["value"]);
}

/** Like `withMood`, with a not-null array column of the enum. */
function withMoods(...labels: string[]): Catalog {
  const mood = defineEnum(labels);
  return definitionCatalog(
    defineDatabase({
      public: { mood, users: defineTable((c) => ({ moods: c.enum(mood).array().notNull() })) },
    }),
  );
}

beforeEach(async () => {
  await db.driver.execute("drop schema if exists app cascade; drop schema public cascade");
  await db.driver.execute("create schema public");
});

describe("an enum type swap", () => {
  it("swaps the type for a removed label, flagging the retype as data loss", async () => {
    const to = withMood("a", "c");
    const sql = await migrate(withMood("a", "b", "c"), to);
    await db.driver.execute("insert into users values ('c'), ('a')");

    expect(sql).toBe(`alter type "public"."mood" rename to "mood_old";

create type "public"."mood" as enum ('a', 'c');

-- hazard: data_loss
-- hazard: rewrite
-- hazard: access_exclusive_lock
alter table "public"."users" alter column "mood" type public.mood using "mood"::text::public.mood;

drop type "public"."mood_old";
`);
    expect(await remaining(sql, to)).toBe("");
    expect(await values("select mood::text as value from users")).toStrictEqual(["c", "a"]);
  });

  it("swaps the type for a reordered label, with no data loss", async () => {
    const to = withMood("c", "a", "b");
    const sql = await migrate(withMood("a", "b", "c"), to);
    await db.driver.execute("insert into users values ('a'), ('c')");

    const { hazards } = diff(await introspect(db.driver), to);
    expect(hazards.map(({ kind }) => kind)).toStrictEqual(["rewrite", "access_exclusive_lock"]);
    expect(sql).toContain(`create type "public"."mood" as enum ('c', 'a', 'b');`);
    expect(await remaining(sql, to)).toBe("");
    expect(await values("select mood::text as value from users order by mood")).toStrictEqual([
      "c",
      "a",
    ]);
  });

  it("creates the new type with every label when it also adds one", async () => {
    const to = withMood("b", "a", "z");
    const sql = await migrate(withMood("a", "b"), to);

    expect(sql).toContain(`create type "public"."mood" as enum ('b', 'a', 'z');`);
    expect(sql).not.toContain("add value");
    expect(await remaining(sql, to)).toBe("");
  });

  it("drops and sets a column's default around the retype", async () => {
    await db.driver.execute(`create type public.mood as enum ('a', 'b');
create table public.users (mood public.mood default 'a');`);
    const to = relabeled(await introspect(db.driver), ["b", "a"]);

    const { sql } = diff(await introspect(db.driver), to);

    expect(sql.replaceAll(/^-- hazard: \w+\n/gmu, ""))
      .toBe(`alter type "public"."mood" rename to "mood_old";

create type "public"."mood" as enum ('b', 'a');

alter table "public"."users" alter column "mood" drop default;

alter table "public"."users" alter column "mood" type public.mood using "mood"::text::public.mood;

alter table "public"."users" alter column "mood" set default ('a'::public.mood);

drop type "public"."mood_old";
`);
    expect(await remaining(sql, to)).toBe("");
  });

  it("retypes an array column of the enum", async () => {
    const to = withMoods("c", "a");
    const sql = await migrate(withMoods("a", "b", "c"), to);
    await db.driver.execute("insert into users values ('{c,a}')");

    const { hazards } = diff(await introspect(db.driver), to);

    expect(sql).toContain(
      `alter table "public"."users" alter column "moods" type public.mood[] using "moods"::text::public.mood[];`,
    );
    expect(hazards.map(({ kind }) => kind)).toStrictEqual([
      "data_loss",
      "rewrite",
      "access_exclusive_lock",
    ]);
    expect(await remaining(sql, to)).toBe("");
    expect(await values("select moods::text as value from users")).toStrictEqual(["{c,a}"]);
  });

  it("retypes every column that uses the enum, in every table", async () => {
    await db.driver.execute(`create type public.mood as enum ('a', 'b');
create table public.posts (mood public.mood, other public.mood);
create table public.users (mood public.mood);`);
    const to = relabeled(await introspect(db.driver), ["b", "a"]);

    const { sql } = diff(await introspect(db.driver), to);

    expect(sql.match(/using/gu)).toHaveLength(3);
    expect(await remaining(sql, to)).toBe("");
  });

  it("swaps an enum no column uses, with no retype", async () => {
    const mood = defineEnum(["b", "a"]);
    const to = definitionCatalog(defineDatabase({ public: { mood } }));

    const sql = await migrate("create type public.mood as enum ('a', 'b')", to);

    expect(sql).toBe(`alter type "public"."mood" rename to "mood_old";

create type "public"."mood" as enum ('b', 'a');

drop type "public"."mood_old";
`);
    expect(await remaining(sql, to)).toBe("");
  });

  it("gives a new table and a new column the new type", async () => {
    const mood = defineEnum(["b", "a"]);
    const to = definitionCatalog(
      defineDatabase({
        public: {
          mood,
          posts: defineTable((c) => ({ mood: c.enum(mood) })),
          users: defineTable((c) => ({ mood: c.enum(mood), later: c.enum(mood) })),
        },
      }),
    );

    const sql = await migrate(
      "create type public.mood as enum ('a', 'b'); create table public.users (mood public.mood)",
      to,
    );

    expect(await remaining(sql, to)).toBe("");
  });

  it("renames the old type aside under a name no table or type in its schema takes", async () => {
    const mood = defineEnum(["b", "a"]);
    const to = definitionCatalog(
      defineDatabase({ public: { mood, mood_old: defineTable(() => ({})) } }),
    );

    const sql = await migrate(
      "create type public.mood as enum ('a', 'b'); create type public.mood_old1 as enum ('x'); create table public.mood_old ()",
      to,
    );

    expect(sql).toContain(`alter type "public"."mood" rename to "mood_old2";`);
    expect(sql).toContain(`drop type "public"."mood_old2";`);
  });

  it("shortens the aside name of a 63-byte enum to fit", async () => {
    const name = "m".repeat(63);
    await db.driver.execute(`create type public."${name}" as enum ('a', 'b')`);
    const from = await introspect(db.driver);
    const to = relabeled(from, ["b", "a"], name);

    const { sql } = diff(from, to);

    expect(sql).toContain(`rename to "${"m".repeat(59)}_old";`);
    expect(await remaining(sql, to)).toBe("");
  });

  it("gives two swapped enums that shorten alike different aside names", async () => {
    const [first, second] = ["a", "b"].map((last) => `${"m".repeat(59)}${last}`);
    await db.driver.execute(`create type public."${first}" as enum ('a', 'b');
create type public."${second}" as enum ('a', 'b');`);
    const from = await introspect(db.driver);
    const to = relabeled(relabeled(from, ["b", "a"], first), ["b", "a"], second);

    const { sql } = diff(from, to);

    expect(sql).toContain(`rename to "${"m".repeat(59)}_old";`);
    expect(sql).toContain(`rename to "${"m".repeat(58)}_old1";`);
    expect(await remaining(sql, to)).toBe("");
  });

  it("writes no USING for any other retype", () => {
    const mood = defineEnum(["a"]);
    const from = definitionCatalog(
      defineDatabase({ public: { mood, t: defineTable((c) => ({ mood: c.enum(mood) })) } }),
    );
    const to = definitionCatalog(
      defineDatabase({ public: { mood, t: defineTable((c) => ({ mood: c.text() })) } }),
    );

    expect(diff(from, to).sql).not.toMatch(/using/iu);
  });
});
