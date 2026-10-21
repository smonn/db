import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { from, type Query, type Refs } from "./from.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
  },
});

describe("from", () => {
  it("selects every column of the table without select", () => {
    expect(from(db.public.users).toSql()).toStrictEqual({
      text: 'select "id", "email" from "public"."users"',
      params: [],
    });
  });

  it("types the rows as the table's Row without select", () => {
    expectTypeOf(from(db.public.users)).toExtend<Query<{ id: string; email: string | null }>>();
  });
});

describe("select", () => {
  it("names each output column by its key", () => {
    const query = from(db.public.users).select((u) => ({ id: u.id, mail: u.email }));
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "email" as "mail" from "public"."users"',
      params: [],
    });
  });

  it("types each output column by its key, keeping nullability", () => {
    const query = from(db.public.users).select((u) => ({ mail: u.email, key: u.id }));
    expectTypeOf(query).toExtend<Query<{ mail: string | null; key: string }>>();
    expectTypeOf(query).not.toExtend<Query<{ mail: string; key: string }>>();
  });

  it("replaces the previous select", () => {
    const query = from(db.public.users)
      .select((u) => ({ id: u.id }))
      .select((u) => ({ email: u.email }));
    expect(query.toSql().text).toBe('select "email" from "public"."users"');
  });

  it("quotes names that need it", () => {
    const odd = defineDatabase({
      'my"schema': { "Odd Table": defineTable((c) => ({ "a b": c.text() })) },
    });
    expect(from(odd['my"schema']["Odd Table"]).toSql().text).toBe(
      'select "a b" from "my""schema"."Odd Table"',
    );
  });

  it("hands select only the table's columns", () => {
    expectTypeOf<keyof Refs<typeof db.public.users>>().toEqualTypeOf<"id" | "email">();
  });
});
