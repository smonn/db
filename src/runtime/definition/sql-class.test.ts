import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDomain, defineEnum, defineTable, type Row } from "./index.ts";

describe("a column's SQL type class", () => {
  it("is fixed by the factory", () => {
    const t = defineTable((c) => ({
      text: c.text(),
      varchar: c.varchar(10),
      smallint: c.smallint(),
      integer: c.integer(),
      bigint: c.bigint(),
      numeric: c.numeric(10, 2),
      real: c.real(),
      doublePrecision: c.doublePrecision(),
      boolean: c.boolean(),
      uuid: c.uuid(),
      date: c.date(),
      timestamp: c.timestamp(),
      timestamptz: c.timestamptz(),
      jsonb: c.jsonb<{ a: number }>(),
      bytea: c.bytea(),
    }));
    type Class<K extends keyof typeof t.columns> = (typeof t.columns)[K]["~types"]["sqlClass"];

    expectTypeOf<Class<"text">>().toEqualTypeOf<"text">();
    expectTypeOf<Class<"varchar">>().toEqualTypeOf<"text">();
    expectTypeOf<Class<"smallint">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"integer">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"bigint">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"numeric">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"real">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"doublePrecision">>().toEqualTypeOf<"number">();
    expectTypeOf<Class<"boolean">>().toEqualTypeOf<"boolean">();
    expectTypeOf<Class<"uuid">>().toEqualTypeOf<"uuid">();
    expectTypeOf<Class<"date">>().toEqualTypeOf<"time">();
    expectTypeOf<Class<"timestamp">>().toEqualTypeOf<"time">();
    expectTypeOf<Class<"timestamptz">>().toEqualTypeOf<"time">();
    expectTypeOf<Class<"jsonb">>().toEqualTypeOf<"jsonb">();
    expectTypeOf<Class<"bytea">>().toEqualTypeOf<"bytea">();
    expect(Object.keys(t.columns)).toHaveLength(15);
  });

  it("is `enum` for every enum, whatever its labels", () => {
    const mood = defineEnum(["sad", "ok"]);
    const size = defineEnum(["s", "m", "l"]);
    const t = defineTable((c) => ({ mood: c.enum(mood), size: c.enum(size) }));

    expectTypeOf<(typeof t.columns.mood)["~types"]["sqlClass"]>().toEqualTypeOf<"enum">();
    expectTypeOf<(typeof t.columns.size)["~types"]["sqlClass"]>().toEqualTypeOf<"enum">();
    expect(t.columns.mood.state.enumType).toBe(mood);
  });

  it("is the base's for a domain over text, integer, or an enum", () => {
    const slug = defineDomain((c) => c.varchar(20), { notNull: true });
    const posint = defineDomain((c) => c.integer(), { notNull: true });
    const calm = defineDomain((c) => c.enum(defineEnum(["sad", "ok"])));
    const t = defineTable((c) => ({
      slug: c.domain(slug),
      posint: c.domain(posint),
      calm: c.domain(calm),
    }));

    expectTypeOf<(typeof slug)["~types"]["sqlClass"]>().toEqualTypeOf<"text">();
    expectTypeOf<(typeof posint)["~types"]["sqlClass"]>().toEqualTypeOf<"number">();
    expectTypeOf<(typeof t.columns.slug)["~types"]["sqlClass"]>().toEqualTypeOf<"text">();
    expectTypeOf<(typeof t.columns.posint)["~types"]["sqlClass"]>().toEqualTypeOf<"number">();
    expectTypeOf<(typeof t.columns.calm)["~types"]["sqlClass"]>().toEqualTypeOf<"enum">();
    expect(t.columns.slug.state.domainType).toBe(slug);
  });

  it("keeps an integer domain from taking an identity, as before", () => {
    const posint = defineDomain((c) => c.integer());
    const t = defineTable((c) => {
      expectTypeOf(c.domain(posint)).not.toHaveProperty("identity");
      return { id: c.domain(posint) };
    });

    expect(t.columns.id.state.domainType).toBe(posint);
  });

  it("gains a [] suffix after .array(), for a scalar, a domain, and an enum", () => {
    const slug = defineDomain((c) => c.text());
    const mood = defineEnum(["sad", "ok"]);
    const t = defineTable((c) => ({
      tags: c.text().array(),
      scores: c.integer().array().notNull(),
      slugs: c.domain(slug).array(),
      moods: c.enum(mood).array(),
      stamps: c.timestamptz().array().default("'{}'"),
    }));

    expectTypeOf<(typeof t.columns.tags)["~types"]["sqlClass"]>().toEqualTypeOf<"text[]">();
    expectTypeOf<(typeof t.columns.scores)["~types"]["sqlClass"]>().toEqualTypeOf<"number[]">();
    expectTypeOf<(typeof t.columns.slugs)["~types"]["sqlClass"]>().toEqualTypeOf<"text[]">();
    expectTypeOf<(typeof t.columns.moods)["~types"]["sqlClass"]>().toEqualTypeOf<"enum[]">();
    expectTypeOf<(typeof t.columns.stamps)["~types"]["sqlClass"]>().toEqualTypeOf<"time[]">();
    expect(t.columns.tags.state.array).toBe(true);
  });

  it("survives every modifier and .codec()", () => {
    const t = defineTable((c) => ({
      id: c.integer().identity().primaryKey(),
      email: c.text().notNull().unique(),
      day: c
        .date()
        .codec({ decode: (value: string) => value.length, encode: (value: number) => `${value}` })
        .notNull(),
      tags: c
        .text()
        .codec({ decode: (value: string) => value.length, encode: (value: number) => `${value}` })
        .array(),
    }));

    expectTypeOf<(typeof t.columns.id)["~types"]["sqlClass"]>().toEqualTypeOf<"number">();
    expectTypeOf<(typeof t.columns.email)["~types"]["sqlClass"]>().toEqualTypeOf<"text">();
    expectTypeOf<(typeof t.columns.day)["~types"]["sqlClass"]>().toEqualTypeOf<"time">();
    expectTypeOf<(typeof t.columns.tags)["~types"]["sqlClass"]>().toEqualTypeOf<"text[]">();
    expect(t.columns.day.state.notNull).toBe(true);
  });

  it("leaves the row types alone", () => {
    const t = defineTable((c) => ({
      id: c.integer().identity(),
      tags: c.text().array(),
      at: c.timestamptz().notNull(),
    }));

    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      id: number;
      tags: (string | null)[] | null;
      at: Date;
    }>();
    expect(Object.keys(t.columns)).toStrictEqual(["id", "tags", "at"]);
  });
});
