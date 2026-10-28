import { describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineDomain,
  defineEnum,
  defineTable,
  type Codec,
} from "../definition/index.ts";
import { createClient } from "./client.ts";
import { and } from "./from.ts";
import { fromClass } from "./probe-joins-class.ts";

const day: Codec<string, { readonly iso: string }> = {
  decode: (base) => ({ iso: base }),
  encode: (value) => value.iso,
};
const ann = "00000000-0000-4000-8000-000000000001";
const bob = "00000000-0000-4000-8000-000000000002";

describe("alternative D: column operands match by SQL type class", () => {
  const mood = defineEnum(["calm", "busy"]);
  const code = defineDomain((c) => c.text());
  const typed = defineDatabase({
    public: {
      mood,
      code,
      a: defineTable((c) => ({
        id: c.uuid().primaryKey(),
        label: c.text(),
        n: c.integer(),
        on: c.date(),
        mood: c.enum(mood),
        tag: c.domain(code),
      })),
      b: defineTable((c) => ({
        id: c.uuid().codec(day).notNull(),
        label: c.text(),
        big: c.bigint(),
        at: c.timestamptz(),
        mood: c.enum(mood),
      })),
    },
  });

  it("compares columns Postgres can compare, whatever their TypeScript types", () => {
    const query = fromClass(typed.public.a)
      .innerJoin(typed.public.b, (a, b) =>
        and(
          a.n.eq(b.big),
          a.on.lte(b.at),
          a.mood.eq(b.mood),
          a.tag.eq(b.label),
          b.label.eq(a.tag),
          a.id.ne(b.id),
        ),
      )
      .select((a) => ({ id: a.id }));
    expect(query.toSql().text).toContain('"a"."n" = "b"."big"');
  });

  const testDatabase = useTestDatabase();
  const client = createClient(testDatabase.driver);

  it("runs those comparisons on Postgres", async () => {
    await testDatabase.driver.execute(`
      drop table if exists public.a, public.b; drop type if exists public.mood; drop domain if exists public.code;
      create type public.mood as enum ('calm', 'busy'); create domain public.code as text;
      create table public.a (id uuid primary key, label text, n integer, "on" date, mood public.mood, tag public.code);
      create table public.b (id uuid not null, label text, big bigint, at timestamptz, mood public.mood);
      insert into public.a values ('${ann}', 'x', 1, '2024-01-01', 'calm', 'k');
      insert into public.b values ('${bob}', 'k', 1, '2024-06-01', 'calm');
    `);
    const rows = await client.all(
      fromClass(typed.public.a)
        .innerJoin(typed.public.b, (a, b) =>
          and(a.n.eq(b.big), a.on.lte(b.at), a.mood.eq(b.mood), a.tag.eq(b.label), a.id.ne(b.id)),
        )
        .select((a, b) => ({ id: a.id, other: b.id })),
    );
    expect(rows).toStrictEqual([{ id: ann, other: { iso: bob } }]);
  });

  it("refuses columns Postgres has no operator for, though both read string", () => {
    const uuidText = fromClass(typed.public.a).innerJoin(typed.public.b, (a, b) =>
      // @ts-expect-error -- uuid = text.
      a.id.eq(b.label),
    );
    const textEnum = fromClass(typed.public.a).innerJoin(typed.public.b, (a, b) =>
      // @ts-expect-error -- text = enum.
      a.label.eq(b.mood),
    );
    const dateText = fromClass(typed.public.a).innerJoin(typed.public.b, (a, b) =>
      // @ts-expect-error -- date = text.
      a.on.eq(b.label),
    );
    expect([uuidText, textEnum, dateText]).toHaveLength(3);
  });
});
