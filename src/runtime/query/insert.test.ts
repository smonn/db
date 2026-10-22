import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Query } from "./from.ts";
import { insert, type NewRow } from "./insert.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text(), name: c.text() })),
    flags: defineTable((c) => ({ note: c.text() })),
  },
});

describe("insert", () => {
  it("binds each value of one row as a param", () => {
    const statement = insert(db.public.users).values({ id: "u1", email: "a@example.com" });
    expect(statement.toSql()).toStrictEqual({
      text: 'insert into "public"."users" ("id", "email") values ($1, $2)',
      params: ["u1", "a@example.com"],
    });
  });

  it("binds every row, defaulting a column that a row skips", () => {
    const statement = insert(db.public.users).values([
      { id: "u1", email: "a@example.com" },
      { id: "u2", name: "Bo" },
    ]);
    expect(statement.toSql()).toStrictEqual({
      text: 'insert into "public"."users" ("id", "email", "name") values ($1, $2, default), ($3, default, $4)',
      params: ["u1", "a@example.com", "u2", "Bo"],
    });
  });

  it("inserts default values when no column has a value", () => {
    expect(insert(db.public.flags).values({}).toSql()).toStrictEqual({
      text: 'insert into "public"."flags" default values',
      params: [],
    });
  });

  it("refuses several rows with no values", () => {
    expect(() => insert(db.public.flags).values([{}, {}]).toSql()).toThrow(
      "insert needs a value in at least one column",
    );
  });

  it("refuses an empty list of rows", () => {
    expect(() => insert(db.public.users).values([])).toThrow("insert needs at least one row");
  });

  it("returns the columns that returning picks, named by key", () => {
    const query = insert(db.public.users)
      .values({ id: "u1" })
      .returning((u) => ({ key: u.id, mail: u.email }));
    expect(query.toSql()).toStrictEqual({
      text: 'insert into "public"."users" ("id") values ($1) returning "id" as "key", "email" as "mail"',
      params: ["u1"],
    });
    expectTypeOf(query).toExtend<Query<{ key: string; mail: string | null }>>();
  });

  it("requires NOT NULL columns and allows nullable ones to be skipped", () => {
    expectTypeOf<NewRow<typeof db.public.users>>().toEqualTypeOf<
      { id: string } & { email?: string | null; name?: string | null }
    >();
    // @ts-expect-error id is NOT NULL
    expect(() => insert(db.public.users).values({ email: "a@example.com" })).not.toThrow();
    // @ts-expect-error no such column
    expect(() => insert(db.public.users).values({ id: "u1", nickname: "x" })).not.toThrow();
    // @ts-expect-error id is NOT NULL, so null is no value
    expect(() => insert(db.public.users).values({ id: null })).not.toThrow();
  });

  it("is not a Query without returning", () => {
    expectTypeOf(insert(db.public.users).values({ id: "u1" })).not.toExtend<Query<unknown>>();
  });
});
