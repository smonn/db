import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineEnum, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";
import { withMood } from "./enums.test-helper.ts";

const db = useTestDatabase();

/** A Definition with `mood` alone in `public`. */
function onlyMood(...labels: string[]): Catalog {
  return definitionCatalog(defineDatabase({ public: { mood: defineEnum(labels) } }));
}

/** Builds `from` in the database, then returns the SQL that turns it into `to`. */
async function migrate(from: Catalog, to: Catalog): Promise<string> {
  await db.driver.execute(bareDiff(await introspect(db.driver), from));
  return bareDiff(await introspect(db.driver), to);
}

beforeEach(async () => {
  await db.driver.execute("drop schema if exists app cascade; drop schema public cascade");
  await db.driver.execute("create schema public");
});

describe("enums", () => {
  it("creates an enum before the table that uses it", () => {
    expect(bareDiff(new Map(), withMood("sad", "ok"))).toBe(`create schema "public";

create type "public"."mood" as enum ('sad', 'ok');

create table "public"."users" (
  "mood" public.mood
);
`);
  });

  it("escapes a quote in a label", () => {
    const quoted = defineEnum(["it's"]);
    const sql = bareDiff(new Map(), definitionCatalog(defineDatabase({ public: { quoted } })));
    expect(sql).toContain(`create type "public"."quoted" as enum ('it''s');`);
  });

  it("drops an enum after the table that uses it", async () => {
    const sql = await migrate(
      withMood("sad", "ok"),
      definitionCatalog(defineDatabase({ public: {} })),
    );

    expect(sql).toBe(`drop table "public"."users";\n\ndrop type "public"."mood";\n`);
  });

  it("drops an enum before its schema", async () => {
    const mood = defineEnum(["sad"]);
    const from = definitionCatalog(defineDatabase({ app: { mood }, public: {} }));
    const to = definitionCatalog(defineDatabase({ public: {} }));

    expect(await migrate(from, to)).toBe(`drop type "app"."mood";\n\ndrop schema "app";\n`);
  });

  it("adds a label at the end, in the middle, and at the start", async () => {
    const sql = await migrate(withMood("b", "d"), withMood("a", "b", "c", "d", "e"));

    expect(sql).toBe(`alter type "public"."mood" add value 'a' before 'b';

alter type "public"."mood" add value 'c' after 'b';

alter type "public"."mood" add value 'e' after 'd';
`);
  });

  it("adds the first label of an empty enum with no position", async () => {
    const sql = await migrate(withMood(), withMood("a", "b"));

    expect(sql).toBe(`alter type "public"."mood" add value 'a';

alter type "public"."mood" add value 'b' after 'a';
`);
  });

  it("adds consecutive new labels after the one declared ahead of them", async () => {
    const sql = await migrate(withMood("a", "d"), withMood("a", "b", "c", "d"));

    expect(sql).toBe(`alter type "public"."mood" add value 'b' after 'a';

alter type "public"."mood" add value 'c' after 'b';
`);
  });

  it("applies the added labels in the declared order", async () => {
    const to = withMood("z", "a", "m", "b", "y");
    await db.driver.execute(bareDiff(await introspect(db.driver), withMood("a", "b")));

    await db.driver.execute(bareDiff(await introspect(db.driver), to));

    const actual = await introspect(db.driver);
    expect(Object.fromEntries(actual)["public\0mood"]).toStrictEqual(
      Object.fromEntries(to)["public\0mood"],
    );
    expect(diff(actual, to).sql).toBe("");
  });

  it("carries no Hazard for a created, added, or dropped enum", async () => {
    const created = diff(new Map(), onlyMood("a")).hazards;
    await db.driver.execute(bareDiff(await introspect(db.driver), onlyMood("a")));
    const added = diff(await introspect(db.driver), onlyMood("a", "b")).hazards;
    const dropped = diff(
      await introspect(db.driver),
      definitionCatalog(defineDatabase({ public: {} })),
    );

    expect([created, added, dropped.hazards]).toStrictEqual([[], [], []]);
    expect(dropped.sql).toContain("drop type");
  });

  it("builds an enum and its column with no remaining diff", async () => {
    const to = withMood("sad", "ok");

    await db.driver.execute(bareDiff(await introspect(db.driver), to));

    expect(diff(await introspect(db.driver), to).sql).toBe("");
  });

  it("qualifies and quotes a column's type the way format_type does", async () => {
    const Mood = defineEnum(["a"]);
    const to = definitionCatalog(
      defineDatabase({
        "Odd Schema": { Mood, t: defineTable((c) => ({ mood: c.enum(Mood) })) },
        public: {},
      }),
    );

    await db.driver.execute(bareDiff(await introspect(db.driver), to));

    expect(diff(await introspect(db.driver), to).sql).toBe("");
    await db.driver.execute('drop schema "Odd Schema" cascade');
  });

  it("flags a text column retyped to an enum as a rewrite", async () => {
    const mood = defineEnum(["a"]);
    const to = definitionCatalog(
      defineDatabase({ public: { mood, t: defineTable((c) => ({ mood: c.enum(mood) })) } }),
    );
    const from = definitionCatalog(
      defineDatabase({ public: { mood, t: defineTable((c) => ({ mood: c.text() })) } }),
    );
    await db.driver.execute(bareDiff(await introspect(db.driver), from));

    const retype = diff(await introspect(db.driver), to);

    expect(retype.hazards).toStrictEqual([
      {
        kind: "rewrite",
        statement: `alter table "public"."t" alter column "mood" type public.mood;`,
      },
      {
        kind: "access_exclusive_lock",
        statement: `alter table "public"."t" alter column "mood" type public.mood;`,
      },
    ]);
  });
});
