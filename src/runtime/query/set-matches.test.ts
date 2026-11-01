import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
  type SqlClass,
} from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import type { Refs } from "./refs.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const mood = defineEnum(["sad", "ok", "happy"]);
const slug = defineDomain((c) => c.text());
const tag = defineEnum(["a,b", 'q"uote', "NULL"]);

const things = defineTable((c) => ({
  id: c.integer().notNull(),
  name: c.text(),
  code: c.varchar(10).notNull(),
  slug: c.domain(slug).notNull(),
  score: c.integer().notNull(),
  ref: c.uuid().notNull(),
  at: c.timestamptz().notNull(),
  flag: c.boolean().notNull(),
  mood: c.enum(mood).notNull(),
  quirk: c.enum(tag).notNull(),
  doc: c.jsonb<{ n: number }>().notNull(),
  // The column holds an integer; the application sees `#<n>`.
  wrapped: c
    .integer()
    .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` })
    .notNull(),
  tags: c.text().array().notNull(),
  nums: c.integer().array().notNull(),
  moods: c.enum(mood).array().notNull(),
  slugs: c.domain(slug).array().notNull(),
  docs: c.jsonb<{ n: number }>().array().notNull(),
  stamps: c.timestamptz().array().notNull(),
  wraps: c
    .integer()
    .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` })
    .array()
    .notNull(),
}));
const db = defineDatabase({ public: { mood, slug, tag, things } });
const query = from(db.public.things);

const UUID_A = "123e4567-e89b-12d3-a456-426614174000";
const UUID_B = "223e4567-e89b-12d3-a456-426614174000";
const UUID_C = "323e4567-e89b-12d3-a456-426614174000";
const NOON = "2024-02-29T12:00:00.000Z";
const LATER = "2024-03-01T12:00:00.000Z";

const rows = [
  `(1, 'ann', 'a1', 'Hello', 1, '${UUID_A}', '${NOON}', true, 'sad', 'a,b', '{"n":1}', 5,
    '{red,blue}', '{1,2}', '{sad,ok}', '{Hello}', '{"{\\"n\\":1}"}', '{"${NOON}"}', '{5,6}')`,
  `(2, 'o''brien, "q"', 'B2', 'World', 2, '${UUID_B}', '${LATER}', false, 'ok', 'q"uote', '{"n":2}', 7,
    '{green,"a,b"}', '{3}', '{happy}', '{World}', '{"{\\"n\\":2}"}', '{"${LATER}"}', '{7}')`,
  `(3, null, 'c3', 'Hello', 3, '${UUID_C}', '${LATER}', true, 'happy', 'NULL', '{"n":3}', 9,
    '{}', '{}', '{}', '{}', '{}', '{}', '{}')`,
];

// Opened before the enums exist, which the tests on it rely on.
let old = client;

const ids = async (picked: ReturnType<typeof query.where>) =>
  (await client.all(picked.pick("id").orderBy((t) => t.id))).map((row) => row.id);

beforeAll(async () => {
  // A pool of one that has run a statement already, so the enum made next is new to its connection.
  const driver = testDatabase.ownPool({ max: 1 });
  await driver.execute("select 1");
  await testDatabase.driver.execute(
    [
      "drop table if exists public.things",
      "drop domain if exists public.slug",
      "drop type if exists public.mood",
      "drop type if exists public.tag",
      "create type public.mood as enum ('sad', 'ok', 'happy')",
      `create type public.tag as enum ('a,b', 'q"uote', 'NULL')`,
      "create domain public.slug as text",
      `create table public.things (id integer not null, name text, code varchar(10) not null,
        slug public.slug not null, score integer not null, ref uuid not null, at timestamptz not null,
        flag boolean not null, mood public.mood not null, quirk public.tag not null,
        doc jsonb not null, wrapped integer not null, tags text[] not null, nums integer[] not null,
        moods public.mood[] not null, slugs public.slug[] not null, docs jsonb[] not null,
        stamps timestamptz[] not null, wraps integer[] not null)`,
      `insert into public.things values ${rows.join(", ")}`,
    ].join("; "),
  );
  old = createClient(driver);
});

describe("in and notIn", () => {
  it("render = any($1) and <> all($1), with the list as array text", () => {
    {
      const { text, params } = query.where((t) => t.id.in([1, 2])).toSql();
      expect(text).toContain('where "id" = any($1)');
      expect(params).toStrictEqual(['{"1","2"}']);
    }
    {
      const { text, params } = query.where((t) => t.id.notIn([1, 2])).toSql();
      expect(text).toContain('where "id" <> all($1)');
      expect(params).toStrictEqual(['{"1","2"}']);
    }
    expect(query.where((t) => t.id.in([])).toSql().params).toStrictEqual(["{}"]);
  });

  it("match a number, text with quotes and commas, a uuid, a timestamp, and json", async () => {
    expect(await ids(query.where((t) => t.id.in([1, 3, 99])))).toStrictEqual([1, 3]);
    expect(await ids(query.where((t) => t.name.in(["ann", 'o\'brien, "q"'])))).toStrictEqual([
      1, 2,
    ]);
    expect(await ids(query.where((t) => t.code.in(["a1", "B2"])))).toStrictEqual([1, 2]);
    expect(await ids(query.where((t) => t.slug.in(["Hello"])))).toStrictEqual([1, 3]);
    expect(await ids(query.where((t) => t.ref.in([UUID_B, UUID_C])))).toStrictEqual([2, 3]);
    expect(await ids(query.where((t) => t.at.in([new Date(NOON)])))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.flag.in([false])))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.doc.in([{ n: 2 }, { n: 3 }])))).toStrictEqual([2, 3]);
  });

  it("run the column's codec on each element", async () => {
    expect(await ids(query.where((t) => t.wrapped.in(["#5", "#9"])))).toStrictEqual([1, 3]);
    expect(await ids(query.where((t) => t.wrapped.notIn(["#5", "#9"])))).toStrictEqual([2]);
  });

  it("notIn keeps the rows the list leaves out, and a NULL never matches", async () => {
    expect(await ids(query.where((t) => t.score.notIn([1])))).toStrictEqual([2, 3]);
    expect(await ids(query.where((t) => t.name.notIn(["ann"])))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.name.in(["ann"])))).toStrictEqual([1]);
  });

  it("match no row on an empty in and every row on an empty notIn", async () => {
    expect(await ids(query.where((t) => t.id.in([])))).toStrictEqual([]);
    expect(await ids(query.where((t) => t.id.notIn([])))).toStrictEqual([1, 2, 3]);
    expect(await ids(query.where((t) => t.name.notIn([])))).toStrictEqual([1, 2, 3]);
  });

  it("match an enum on a connection opened before the enum existed", async () => {
    const among = from(db.public.things).where((t) => t.mood.in(["sad", "happy"]));
    const rest = from(db.public.things).where((t) => t.mood.notIn(["sad", "happy"]));
    const quirks = from(db.public.things).where((t) => t.quirk.in(["a,b", "NULL", 'q"uote']));

    expect((await old.all(among.pick("id").orderBy((t) => t.id))).map((r) => r.id)).toStrictEqual([
      1, 3,
    ]);
    expect((await old.all(rest.pick("id"))).map((r) => r.id)).toStrictEqual([2]);
    expect((await old.all(quirks.pick("id"))).length).toBe(3);
  });

  it("name the column when the codec throws", () => {
    const angry = defineTable((c) => ({
      n: c
        .integer()
        .codec({
          encode: (): number => {
            throw new Error("no");
          },
          decode: (base) => base,
        })
        .notNull(),
    }));
    const angryDb = defineDatabase({ public: { angry } });
    const picked = from(angryDb.public.angry).where((t) => t.n.in([1]));

    expect(() => picked.toSql()).toThrow(
      `The codec of column "n" of "public"."angry" threw while encoding a value`,
    );
  });
});

describe("like and ilike", () => {
  it("render the column, the operator, and the pattern as a param", () => {
    {
      const { text, params } = query.where((t) => t.name.like("a%")).toSql();
      expect(text).toContain('where "name" like $1');
      expect(params).toStrictEqual(["a%"]);
    }
    {
      const { text, params } = query.where((t) => t.code.ilike("b%")).toSql();
      expect(text).toContain('where "code" ilike $1');
      expect(params).toStrictEqual(["b%"]);
    }
  });

  it("match text, varchar, and a domain over text, and ilike ignores case", async () => {
    expect(await ids(query.where((t) => t.name.like("a%")))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.name.like("A%")))).toStrictEqual([]);
    expect(await ids(query.where((t) => t.name.ilike("A%")))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.code.like("%2")))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.code.ilike("b_")))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.slug.like("Hel%")))).toStrictEqual([1, 3]);
    expect(await ids(query.where((t) => t.slug.ilike("w%")))).toStrictEqual([2]);
  });

  it("bind the pattern as given, so a quote or backslash needs no escaping", async () => {
    expect(await ids(query.where((t) => t.name.like(`o'brien, "q"`)))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.name.like("%\\%")))).toStrictEqual([]);
  });
});

describe("includes", () => {
  it("renders $1 = any(column), the value through the codec", () => {
    {
      const { text, params } = query.where((t) => t.tags.includes("red")).toSql();
      expect(text).toContain('where $1 = any("tags")');
      expect(params).toStrictEqual(["red"]);
    }
    expect(query.where((t) => t.wraps.includes("#7")).toSql().params).toStrictEqual([7]);
  });

  it("matches an element of a text, integer, domain, jsonb, timestamp, or codec array", async () => {
    expect(await ids(query.where((t) => t.tags.includes("red")))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.tags.includes("a,b")))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.nums.includes(3)))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.slugs.includes("Hello")))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.docs.includes({ n: 2 })))).toStrictEqual([2]);
    expect(await ids(query.where((t) => t.stamps.includes(new Date(NOON))))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.wraps.includes("#6")))).toStrictEqual([1]);
    expect(await ids(query.where((t) => t.tags.includes("nope")))).toStrictEqual([]);
  });

  it("matches an enum array element on a connection opened before the enum existed", async () => {
    const picked = from(db.public.things).where((t) => t.moods.includes("happy"));

    expect((await old.all(picked.pick("id"))).map((row) => row.id)).toStrictEqual([2]);
  });
});

describe("which calls a column offers", () => {
  type Offered<Ref> = {
    [M in "in" | "notIn" | "like" | "ilike" | "includes"]: M extends keyof Ref ? true : false;
  };
  type Of<C extends SqlClass> = Offered<Refs<{ x: string }, { x: C }>["x"]>;
  type ScalarOnly = { in: true; notIn: true; like: false; ilike: false; includes: false };
  type ArrayOnly = { in: false; notIn: false; like: false; ilike: false; includes: true };

  it("gives like and ilike to the text class alone", () => {
    expectTypeOf<Of<"text">>().toEqualTypeOf<{
      in: true;
      notIn: true;
      like: true;
      ilike: true;
      includes: false;
    }>();
    expectTypeOf<Of<"number">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"enum">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"uuid">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"time">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"boolean">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"jsonb">>().toEqualTypeOf<ScalarOnly>();
    expectTypeOf<Of<"bytea">>().toEqualTypeOf<ScalarOnly>();
    expect(query.where((t) => t.slug.like("H%")).toSql().params).toStrictEqual(["H%"]);
  });

  it("gives an array column includes alone", () => {
    expectTypeOf<Of<"text[]">>().toEqualTypeOf<ArrayOnly>();
    expectTypeOf<Of<"number[]">>().toEqualTypeOf<ArrayOnly>();
    expectTypeOf<Of<"enum[]">>().toEqualTypeOf<ArrayOnly>();
    expect(query.where((t) => t.moods.includes("ok")).toSql().params).toStrictEqual(["ok"]);
  });
});

describe("an unknown class", () => {
  it("offers no class-bound call on a ref whose class is unknown", () => {
    type Unknown = Refs<{ x: string }>["x"];
    expectTypeOf<Unknown>().not.toHaveProperty("in");
    expectTypeOf<Unknown>().not.toHaveProperty("notIn");
    expectTypeOf<Unknown>().not.toHaveProperty("includes");
    expectTypeOf<Unknown>().not.toHaveProperty("like");
    expectTypeOf<Unknown>().toHaveProperty("eq");
  });
});
