import { describe, expect, expectTypeOf, it } from "vitest";
import type { Target } from "./references.ts";
import { defineDatabase, defineTable } from "./definition.ts";

const users = defineTable((c) => ({
  id: c.integer().primaryKey(),
  email: c.text().unique(),
  name: c.text(),
}));

describe("references", () => {
  it("records the target and options on the column, and resolves them in defineDatabase", () => {
    const orders = defineTable((c) => ({
      id: c.integer().primaryKey(),
      user_id: c
        .integer()
        .notNull()
        .references(() => users.columns.id, { onDelete: "cascade", deferrable: "deferred" }),
    }));
    const db = defineDatabase({ public: { users, orders } });

    expect(db.public.orders.foreignKeys).toStrictEqual([
      {
        name: undefined,
        columns: ["user_id"],
        target: { schema: "public", table: "users", columns: ["id"] },
        onDelete: "cascade",
        onUpdate: "no action",
        match: "simple",
        deferrable: "deferred",
      },
    ]);
    expect(db.public.users.foreignKeys).toStrictEqual([]);
  });

  it("takes a name, an update action, and a unique target in another schema", () => {
    const orders = defineTable((c) => ({
      email: c.text().references(() => users.columns.email, {
        name: "orders_email",
        onUpdate: "set null",
        onDelete: "restrict",
        deferrable: "immediate",
      }),
    }));
    const db = defineDatabase({ shop: { orders }, auth: { users } });

    expect(db.shop.orders.foreignKeys).toStrictEqual([
      {
        name: "orders_email",
        columns: ["email"],
        target: { schema: "auth", table: "users", columns: ["email"] },
        onDelete: "restrict",
        onUpdate: "set null",
        match: "simple",
        deferrable: "immediate",
      },
    ]);
  });

  it("keeps one foreign key per referencing column, in column order", () => {
    const pairs = defineTable((c) => ({
      a: c.integer().references(() => users.columns.id),
      b: c.integer().references(() => users.columns.id),
    }));
    const db = defineDatabase({ public: { users, pairs } });

    expect(db.public.pairs.foreignKeys.map(({ columns }) => columns)).toStrictEqual([["a"], ["b"]]);
  });

  it("loads in either order, since tables that point at each other read the thunk late", () => {
    const early = defineTable((c) => ({
      id: c.integer().primaryKey(),
      late_id: c.integer().references((): Target<number> => late.columns.id),
    }));
    const late = defineTable((c) => ({
      id: c.integer().primaryKey(),
      early_id: c.integer().references(() => early.columns.id),
    }));
    const db = defineDatabase({ public: { early, late } });

    expect(db.public.early.foreignKeys[0]?.target).toStrictEqual({
      schema: "public",
      table: "late",
      columns: ["id"],
    });
    expect(db.public.late.foreignKeys[0]?.target).toStrictEqual({
      schema: "public",
      table: "early",
      columns: ["id"],
    });
  });

  it("keeps the column's own value type and nullability", () => {
    const orders = defineTable((c) => ({
      user_id: c
        .integer()
        .notNull()
        .references(() => users.columns.id),
      maybe_user_id: c.integer().references(() => users.columns.id),
    }));
    expectTypeOf<(typeof orders.columns.user_id)["~types"]["value"]>().toEqualTypeOf<number>();
    expectTypeOf<(typeof orders.columns.user_id)["~types"]["notNull"]>().toEqualTypeOf<true>();
    expectTypeOf<
      (typeof orders.columns.maybe_user_id)["~types"]["notNull"]
    >().toEqualTypeOf<false>();
  });
});

describe("references types", () => {
  it("rejects a target of another value type, a column that is no key, and a second call", () => {
    /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-call -- each rejected call is the point. */
    const rejected = [
      defineTable((c) => ({
        // @ts-expect-error -- a uuid column can't point at an integer key.
        x: c.uuid().references(() => users.columns.id),
      })),
      defineTable((c) => ({
        // @ts-expect-error -- a bigint column can't point at an integer key, although Postgres allows it.
        x: c.bigint().references(() => users.columns.id),
      })),
      defineTable((c) => ({
        // @ts-expect-error -- name is neither a primary key nor unique.
        x: c.text().references(() => users.columns.name),
      })),
      defineTable((c) => ({
        x: c
          .integer()
          .references(() => users.columns.id)
          // @ts-expect-error -- a column points at one target.
          .references(() => users.columns.id),
      })),
    ];
    /* oxlint-enable typescript/no-unsafe-assignment, typescript/no-unsafe-call */
    expect(rejected).toHaveLength(4);
  });

  it("needs one annotated thunk to close a cycle between two tables", () => {
    const a = defineTable((c) => ({
      id: c.integer().primaryKey(),
      b_id: c.integer().references((): Target<number> => b.columns.id),
    }));
    const b = defineTable((c) => ({
      id: c.integer().primaryKey(),
      a_id: c.integer().references(() => a.columns.id),
    }));
    expectTypeOf<(typeof b.columns.a_id)["~types"]["value"]>().toEqualTypeOf<number>();
    expect(defineDatabase({ public: { a, b } }).public.a.foreignKeys).toHaveLength(1);
  });

  it("can't infer a cycle in which no thunk names its type", () => {
    /* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return -- the cycle makes both tables `any`, which is the point. */
    // @ts-expect-error -- TS7022: 'first' implicitly has type 'any' because it refers to itself.
    const first = defineTable((c) => ({
      id: c.integer().primaryKey(),
      // @ts-expect-error -- TS7024: the thunk's return type is circular.
      second_id: c.integer().references(() => second.columns.id),
    }));
    // @ts-expect-error -- TS7022: 'second' implicitly has type 'any' because it refers to itself.
    const second = defineTable((c) => ({
      id: c.integer().primaryKey(),
      // @ts-expect-error -- TS7024: the thunk's return type is circular.
      first_id: c.integer().references(() => first.columns.id),
    }));
    expect(defineDatabase({ public: { first, second } }).public.first.foreignKeys).toHaveLength(1);
    /* oxlint-enable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-return */
  });

  it("targets a key column of the same value type", () => {
    expectTypeOf(users.columns.id).toExtend<Target<number>>();
    expectTypeOf(users.columns.email).toExtend<Target<string>>();
    expectTypeOf(users.columns.name).not.toExtend<Target<string>>();
  });
});

describe("defineDatabase foreign key checks", () => {
  it("refuses a target table outside the Database, naming the table that points at it", () => {
    const loose = defineTable((c) => ({ id: c.integer().primaryKey() }));
    const orders = defineTable((c) => ({
      user_id: c.integer().references(() => loose.columns.id),
    }));

    expect(() => defineDatabase({ public: { orders } })).toThrow(
      'the foreign key on "public"."orders" ("user_id") points at a table that is not in the Database; add it to defineDatabase',
    );
  });

  it("refuses a target table rolled up under two names, naming both", () => {
    const orders = defineTable((c) => ({
      user_id: c.integer().references(() => users.columns.id),
    }));

    expect(() => defineDatabase({ public: { users, people: users, orders } })).toThrow(
      'the foreign key on "public"."orders" ("user_id") points at a table that defineDatabase rolls up under two names, "public"."users" and "public"."people"; roll it up once',
    );
  });

  it("allows a table rolled up twice that no foreign key points at", () => {
    expect(() => defineDatabase({ public: { users, people: users } })).not.toThrow();
  });

  it("refuses a target that is no primary key or unique column, at load where types are bypassed", () => {
    const orders = defineTable((c) => ({
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the point is a caller that bypasses the types.
      name: c.text().references(() => users.columns.name as unknown as Target<string>),
    }));

    expect(() => defineDatabase({ public: { users, orders } })).toThrow(
      'the foreign key on "public"."orders" ("name") points at "public"."users" ("name"), which is not a primary key or unique column',
    );
  });
});
