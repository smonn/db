import { describe, expectTypeOf, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable } from "./definition.ts";
import { sql } from "../query/index.ts";

describe("a table's key sets", () => {
  it("hold the primary key, unique columns, unique entries, and unique indexes on plain columns", () => {
    const db = defineDatabase({
      public: {
        items: defineTable(
          (c) => ({
            id: c.integer().primaryKey(),
            email: c.text().unique(),
            a: c.text(),
            b: c.text(),
            c: c.text(),
            d: c.text(),
            e: c.text(),
            f: c.text(),
            name: c.text(),
          }),
          (t) => ({
            unique: [{ columns: [t.a, t.b] }],
            indexes: [
              { columns: [t.c, t.d], unique: true, where: sql`${t.c} is not null` },
              { columns: [t.e, { key: t.f, order: "desc" }], unique: true },
              { columns: [t.name] },
              { columns: [sql`lower(${t.email})`], unique: true, name: "items_lower_email" },
            ],
          }),
        ),
      },
    });
    expectTypeOf(db.public.items["~keys"]).toEqualTypeOf<
      | readonly ["id", false]
      | readonly ["email", false]
      | readonly ["a" | "b", false]
      | readonly ["c" | "d", "0"]
      | readonly ["e" | "f", false]
    >();
  });

  it("hold a composite primary key as one set", () => {
    const { pair } = defineDatabase({
      public: {
        pair: defineTable(
          (c) => ({ x: c.integer(), y: c.integer() }),
          (t) => ({ primaryKey: [t.x, t.y] }),
        ),
      },
    }).public;
    expectTypeOf(pair["~keys"]).toEqualTypeOf<readonly ["x" | "y", false]>();
  });

  it("keep two partial unique indexes on one column set apart", () => {
    const { twice } = defineDatabase({
      public: {
        twice: defineTable(
          (c) => ({ tag: c.text(), gone: c.boolean() }),
          (t) => ({
            indexes: [
              { columns: [t.tag], unique: true, where: sql`${t.gone}` },
              { columns: [t.tag], unique: true, where: sql`not ${t.gone}` },
            ],
          }),
        ),
      },
    }).public;
    expectTypeOf(twice["~keys"]).toEqualTypeOf<readonly ["tag", "0"] | readonly ["tag", "1"]>();
  });

  it("merge the partial unique indexes of an array that is no tuple into one set", () => {
    const { mapped } = defineDatabase({
      public: {
        mapped: defineTable(
          (c) => ({ tag: c.text(), gone: c.boolean() }),
          (t) => ({
            indexes: [sql`${t.gone}`, sql`not ${t.gone}`].map((where) => ({
              columns: [t.tag] as const,
              unique: true as const,
              where,
            })),
          }),
        ),
      },
    }).public;
    expectTypeOf(mapped["~keys"]).toEqualTypeOf<readonly ["tag", "partial"]>();
  });

  it("are none for a table without keys", () => {
    const { bare } = defineDatabase({
      public: { bare: defineTable((c) => ({ p: c.text() })) },
    }).public;
    expectTypeOf(bare["~keys"]).toBeNever();
  });
});
