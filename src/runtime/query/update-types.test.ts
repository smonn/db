import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Client } from "./client.ts";
import type { Expr } from "./expr.ts";
import { sql } from "./sql.ts";
import type { Many, Query } from "./statement.ts";
import { update } from "./update.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity("always").primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
      n: c.integer().notNull(),
      born: c
        .integer()
        .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` }),
    })),
  },
});
const { users } = db.public;

const misuses = () => {
  const unfinished = update(users);
  // @ts-expect-error a number is no email
  void unfinished.set({ email: 1 });
  // @ts-expect-error no such column
  void unfinished.set({ nope: 1 });
  // @ts-expect-error an identity always column is not set
  void unfinished.set({ id: 5 });
  // @ts-expect-error null on a NOT NULL column
  void unfinished.set({ email: null });
  // @ts-expect-error an Expr of another type
  void unfinished.set({ email: sql.expr<number>`1` });
  // @ts-expect-error a callback returns an Expr
  void unfinished.set({ n: () => 1 });
  // @ts-expect-error set is not where
  void unfinished.where;
};

type RunArgument = Parameters<Client["run"]>[0];
type AllArgument = Parameters<Client["all"]>[0];
type OneArgument = Parameters<Client["one"]>[0];

describe("update types", () => {
  it("is no Statement until set and then where or allRows pick the rows", () => {
    const empty = update(users);
    const unfinished = empty.set({ n: 0 });
    expectTypeOf(empty).not.toExtend<RunArgument>();
    expectTypeOf(empty).toHaveProperty("set");
    expectTypeOf(empty).not.toHaveProperty("where");
    expectTypeOf(unfinished).not.toExtend<RunArgument>();
    expectTypeOf(unfinished).toHaveProperty("where");
    expectTypeOf(unfinished).toHaveProperty("allRows");
    expectTypeOf(unfinished).not.toHaveProperty("set");
    expectTypeOf(unfinished).not.toHaveProperty("returning");
  });

  it("is a count Statement once picked, and no Query without returning", () => {
    const filtered = update(users)
      .set({ n: 0 })
      .where((u) => u.id.eq(1));
    const every = update(users).set({ n: 0 }).allRows();
    expectTypeOf(filtered).toExtend<RunArgument>();
    expectTypeOf(every).toExtend<RunArgument>();
    expectTypeOf(filtered).not.toExtend<AllArgument>();
    expectTypeOf(every).not.toExtend<AllArgument>();
    expectTypeOf(filtered).not.toExtend<OneArgument>();
    expectTypeOf(every).not.toExtend<OneArgument>();
  });

  it("types returning over the updated row", () => {
    const returned = update(users)
      .set({ n: 0 })
      .where((u) => u.id.eq(1))
      .returning((u) => ({ key: u.id, name: u.name, born: u.born }));
    expectTypeOf(returned).toExtend<
      Query<{ key: number; name: string | null; born: string | null }>
    >();
    expectTypeOf(returned).toExtend<RunArgument>();
  });

  it("carries the many marker through returning only for allRows", () => {
    const every = update(users)
      .set({ n: 0 })
      .allRows()
      .returning((u) => ({ id: u.id }));
    const some = update(users)
      .set({ n: 0 })
      .where((u) => u.id.eq(1))
      .returning((u) => ({ id: u.id }));
    expectTypeOf(every).toExtend<Many>();
    expectTypeOf(some).not.toExtend<Many>();
    expectTypeOf(every).toExtend<AllArgument>();
    expectTypeOf(every).not.toExtend<OneArgument>();
    expectTypeOf(some).toExtend<AllArgument>();
    expectTypeOf(some).toExtend<OneArgument>();
  });

  it("takes every column optionally, as its value, an Expr, or a callback", () => {
    type Set = Parameters<ReturnType<typeof update<typeof users>>["set"]>[0];
    const empty: Set = {};
    expect(empty).toStrictEqual({});
    expectTypeOf<{
      email: string;
      name: string | null;
      n: number;
      born: string | null;
    }>().toExtend<Set>();
    expectTypeOf<{ n: Expr<number> }>().toExtend<Set>();
    expectTypeOf<{ n: () => Expr<number> }>().toExtend<Set>();
    expectTypeOf<{ name: Expr<string | null> }>().toExtend<Set>();
  });

  it("takes null only on a nullable column", () => {
    type Set = Parameters<ReturnType<typeof update<typeof users>>["set"]>[0];
    expectTypeOf<{ name: null }>().toExtend<Set>();
    expectTypeOf<{ born: null }>().toExtend<Set>();
    expectTypeOf<{ email: null }>().not.toExtend<Set>();
    expectTypeOf<{ n: null }>().not.toExtend<Set>();
    expectTypeOf<{ n: Expr<number | null> }>().not.toExtend<Set>();
  });

  it("lists an identity always column under a message key, not under its own", () => {
    type Set = Parameters<ReturnType<typeof update<typeof users>>["set"]>[0];
    expectTypeOf<keyof Set>().toEqualTypeOf<
      "email" | "name" | "n" | "born" | "id is generated always, so update can't set it"
    >();
    expectTypeOf<{ id: 5 }>().not.toExtend<Set>();
  });

  it("refuses a wrong type, an unknown key, and an Expr of the wrong type", () => {
    expectTypeOf(misuses).toBeFunction();
  });

  it("offers the calls a column's class takes, as from does", () => {
    const unfinished = update(users).set({ n: 0 });
    const filtered = unfinished.where((u) => u.email.ilike("a%"));
    expect(filtered.toSql().text).toContain("ilike");
    /* oxlint-disable typescript/no-unsafe-return, typescript/no-unsafe-call -- each rejected call is the point. */
    // @ts-expect-error includes is for array columns
    void unfinished.where((u) => u.email.includes("a"));
    // @ts-expect-error like is for text columns
    void unfinished.where((u) => u.n.like("1%"));
    /* oxlint-enable typescript/no-unsafe-return, typescript/no-unsafe-call */
  });
});

describe("update on an identity column", () => {
  const mixed = defineDatabase({
    public: {
      t: defineTable((c) => ({
        always: c.integer().identity("always"),
        byDefault: c.integer().identity("by default"),
        implied: c.integer().identity(),
        plain: c.integer().notNull(),
      })),
    },
  }).public.t;
  type Set = Parameters<ReturnType<typeof update<typeof mixed>>["set"]>[0];

  it("refuses only an identity always column", () => {
    expectTypeOf<keyof Set>().toEqualTypeOf<
      "byDefault" | "implied" | "plain" | "always is generated always, so update can't set it"
    >();
    expectTypeOf<{ byDefault: 1; implied: 2; plain: 3 }>().toExtend<Set>();
    expectTypeOf<{ always: 1 }>().not.toExtend<Set>();
  });

  it("refuses a column whose mode is only known to be one of the two", () => {
    const mode = "always" as "always" | "by default";
    const unknownMode = defineDatabase({
      public: { t: defineTable((c) => ({ id: c.integer().identity(mode), n: c.integer() })) },
    }).public.t;
    type UnknownSet = Parameters<ReturnType<typeof update<typeof unknownMode>>["set"]>[0];
    expectTypeOf<keyof UnknownSet>().toEqualTypeOf<
      "n" | "id is generated always, so update can't set it"
    >();
    expectTypeOf<{ id: 1 }>().not.toExtend<UnknownSet>();
  });
});
