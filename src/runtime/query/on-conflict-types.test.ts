import { describe, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import type { Client } from "./client.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";
import type { Maybe, Query } from "./statement.ts";

/** Widened, so the column may be either mode. */
const modeOf = (): "always" | "by default" => "always";
const mode = modeOf();

const db = defineDatabase({
  public: {
    items: defineTable(
      (c) => ({
        id: c.integer().identity("always").primaryKey(),
        sku: c.text().notNull().unique(),
        token: c.uuid(),
        a: c.text(),
        b: c.text(),
        c: c.text(),
        version: c.integer().notNull(),
        note: c.text(),
      }),
      (t) => ({
        unique: [{ columns: [t.a, t.b] }],
        indexes: [{ columns: [t.c], unique: true, where: sql`${t.c} <> ''` }],
      }),
    ),
    twice: defineTable(
      (c) => ({ tag: c.text(), gone: c.boolean() }),
      (t) => ({
        indexes: [
          { unique: true, columns: [t.tag], where: sql`${t.gone}` },
          { unique: true, columns: [t.tag], where: sql`not ${t.gone}` },
        ],
      }),
    ),
    unknownMode: defineTable((c) => ({
      id: c.integer().identity(mode).primaryKey(),
      n: c.integer(),
    })),
  },
});
const { items, twice, unknownMode } = db.public;
const row = { sku: "s", version: 1 };
const conflict = insert(items)
  .values(row)
  .onConflict((u) => [u.sku]);

const misuses = () => {
  const values = insert(items).values(row);
  // @ts-expect-error no key
  void values.onConflict((u) => [u.note]);
  // @ts-expect-error a subset of a key
  void values.onConflict((u) => [u.a]);
  // @ts-expect-error a superset of a key
  void values.onConflict((u) => [u.a, u.b, u.id]);
  const tagged = insert(twice).values({ tag: "t" });
  // @ts-expect-error two partial unique indexes
  void tagged.onConflict((u) => [u.tag]);
  // @ts-expect-error no column
  void conflict.doUpdate(() => ({ nope: 1 }));
  // @ts-expect-error a number is no sku
  void conflict.doUpdate(() => ({ sku: 1 }));
  // @ts-expect-error null on a NOT NULL column
  void conflict.doUpdate(() => ({ sku: null }));
  // @ts-expect-error an identity always column
  void conflict.doUpdate(() => ({ id: 3 }));
  // @ts-expect-error a column of another type
  void conflict.doUpdate((_, excluded) => ({ sku: excluded.version }));
  // @ts-expect-error a nullable column into a NOT NULL one
  void conflict.doUpdate((_, excluded) => ({ sku: excluded.note }));
  // @ts-expect-error a column of another class, which Postgres won't assign
  void conflict.doUpdate((_, excluded) => ({ token: excluded.note }));
  // @ts-expect-error an Expr of another type
  void conflict.doUpdate(() => ({ sku: sql.expr<number>`1` }));
  // @ts-expect-error a callback that returns nothing
  void conflict.doUpdate(() => {});
  // @ts-expect-error a callback that returns null
  void conflict.doUpdate(() => null);
  // @ts-expect-error a callback that returns no object
  void conflict.doUpdate(() => 5);
  const either = insert(unknownMode)
    .values({ n: 1 })
    .onConflict((u) => [u.id]);
  // @ts-expect-error a column whose identity may be always
  void either.doUpdate(() => ({ id: 1 }));
  // @ts-expect-error doNothing ends the clause
  void conflict.doNothing().where;
  // @ts-expect-error one conflict clause
  void conflict.doUpdate(() => ({ note: "n" })).onConflict;
  // @ts-expect-error a number is no text
  void conflict.doUpdate(() => ({ note: "n" })).where((existing) => existing.note.eq(1));
};

type RunArgument = Parameters<Client["run"]>[0];
type AllArgument = Parameters<Client["all"]>[0];
type OneArgument = Parameters<Client["one"]>[0];

describe("onConflict types", () => {
  it("takes a key's columns in any order, and a partial unique index's", () => {
    expectTypeOf(
      insert(items)
        .values(row)
        .onConflict((u) => [u.b, u.a]),
    ).toHaveProperty("doNothing");
    expectTypeOf(
      insert(items)
        .values(row)
        .onConflict((u) => [u.c]),
    ).toHaveProperty("doUpdate");
  });

  it("is no Statement until doNothing or doUpdate", () => {
    expectTypeOf(conflict).not.toExtend<RunArgument>();
    expectTypeOf(conflict).not.toHaveProperty("returning");
    expectTypeOf(conflict.doNothing()).toExtend<RunArgument>();
    expectTypeOf(conflict.doUpdate(() => ({ note: "n" }))).toExtend<RunArgument>();
    expectTypeOf(conflict.doNothing()).not.toExtend<AllArgument>();
  });

  it("marks doNothing and a filtered doUpdate maybe, which client.one refuses", () => {
    const skipped = conflict.doNothing().returning((u) => ({ sku: u.sku }));
    const filtered = conflict
      .doUpdate(() => ({ note: "n" }))
      .where((existing) => existing.note.like("a%"))
      .returning((u) => ({ sku: u.sku }));
    expectTypeOf(skipped).toExtend<Query<{ sku: string }> & Maybe>();
    expectTypeOf(skipped).toExtend<AllArgument>();
    expectTypeOf(skipped).not.toExtend<OneArgument>();
    expectTypeOf(filtered).toExtend<Query<{ sku: string }>>();
    expectTypeOf(filtered).not.toExtend<OneArgument>();
  });

  it("lets client.one take a bare doUpdate of one row, but not of many", () => {
    const one = conflict.doUpdate(() => ({ note: "n" })).returning((u) => ({ sku: u.sku }));
    const many = insert(items)
      .valuesMany([row])
      .onConflict((u) => [u.sku])
      .doUpdate(() => ({ note: "n" }))
      .returning((u) => ({ sku: u.sku }));
    expectTypeOf(one).toExtend<OneArgument>();
    expectTypeOf(many).not.toExtend<OneArgument>();
  });

  it("takes literals, excluded columns of the same type, and Exprs", () => {
    expectTypeOf(
      conflict.doUpdate((existing, excluded) => ({
        sku: excluded.sku,
        note: excluded.sku,
        a: null,
        version: sql.expr<number>`${existing.version} + 1`,
        b: undefined,
      })),
    ).toExtend<RunArgument>();
  });
});

void misuses;
