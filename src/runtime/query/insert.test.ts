import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Query } from "./from.ts";
import { insert, type NewRow } from "./insert.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text(), name: c.text() })),
    flags: defineTable((c) => ({ note: c.text() })),
    pair: defineTable((c) => ({ left: c.text(), right: c.text() })),
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

  it("defaults the first column of every row when no column has a value", () => {
    expect(insert(db.public.flags).values({}).toSql()).toStrictEqual({
      text: 'insert into "public"."flags" ("note") values (default)',
      params: [],
    });
    expect(insert(db.public.flags).values([{}, {}]).toSql()).toStrictEqual({
      text: 'insert into "public"."flags" ("note") values (default), (default)',
      params: [],
    });
  });

  it("defaults only the first column when no column has a value", () => {
    expect(insert(db.public.pair).values({}).toSql()).toStrictEqual({
      text: 'insert into "public"."pair" ("left") values (default)',
      params: [],
    });
  });

  it("treats a column set to undefined as skipped", () => {
    const row = { id: "u1", email: undefined, name: "Bo" };
    // @ts-expect-error -- undefined is no value, though a JavaScript caller can pass it
    const statement = insert(db.public.users).values(row);
    expect(statement.toSql()).toStrictEqual({
      text: 'insert into "public"."users" ("id", "name") values ($1, $2)',
      params: ["u1", "Bo"],
    });
  });

  it("refuses a table with no column", () => {
    const { empty } = defineDatabase({ public: { empty: defineTable(() => ({})) } }).public;
    expect(() => insert(empty).values({})).toThrow("insert needs a table with a column");
  });

  it("ignores inherited properties of a row", () => {
    const row = { __proto__: { email: "inherited@example.com" }, id: "u1" };
    expect(insert(db.public.users).values(row).toSql()).toStrictEqual({
      text: 'insert into "public"."users" ("id") values ($1)',
      params: ["u1"],
    });
  });

  it("names a key that is not a column of the table", () => {
    const row = { id: "u1", nickname: "x" };
    expect(() => insert(db.public.users).values(row)).toThrow(
      '"nickname" is not a column of "public"."users"',
    );
    const onlyUnknown = { nickname: "x" };
    expect(() => insert(db.public.flags).values(onlyUnknown)).toThrow(
      '"nickname" is not a column of "public"."flags"',
    );
  });

  it("refuses returning with no column", () => {
    expect(() =>
      insert(db.public.users)
        .values({ id: "u1" })
        .returning(() => ({})),
    ).toThrow("returning needs at least one column");
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
    expect(() => insert(db.public.users).values({ id: "u1", nickname: "x" })).toThrow(
      '"nickname" is not a column',
    );
    // @ts-expect-error id is NOT NULL, so null is no value
    expect(() => insert(db.public.users).values({ id: null })).not.toThrow();
  });

  it("requires every composite-key column, and none can be null", () => {
    const { memberships } = defineDatabase({
      public: {
        memberships: defineTable(
          (c) => ({ account_id: c.integer(), team_id: c.integer(), note: c.text() }),
          (t) => ({ primaryKey: [t.account_id, t.team_id] }),
        ),
      },
    }).public;
    expectTypeOf<NewRow<typeof memberships>>().toEqualTypeOf<
      { account_id: number; team_id: number } & { note?: string | null }
    >();
    // @ts-expect-error team_id is part of the key, so it is required
    expect(() => insert(memberships).values({ account_id: 1 })).not.toThrow();
    // @ts-expect-error account_id is part of the key, so it is required
    expect(() => insert(memberships).values({ team_id: 1 })).not.toThrow();
    // @ts-expect-error account_id is part of the key, so null is no value
    expect(() => insert(memberships).values({ account_id: null, team_id: 1 })).not.toThrow();
  });

  it("is not a Query without returning", () => {
    expectTypeOf(insert(db.public.users).values({ id: "u1" })).not.toExtend<Query<unknown>>();
  });
});
