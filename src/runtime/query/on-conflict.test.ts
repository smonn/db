import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";

const db = defineDatabase({
  public: {
    users: defineTable(
      (c) => ({
        id: c.text().primaryKey(),
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
          { columns: [sql`lower(${t.email})`], unique: true, name: "users_lower_email" },
        ],
      }),
    ),
    pairs: defineTable(
      (c) => ({ x: c.integer(), y: c.integer(), note: c.text() }),
      (t) => ({ primaryKey: [t.x, t.y] }),
    ),
    loose: defineTable((c) => ({ p: c.text(), q: c.text() })),
  },
});

const user = { id: "u1" };

describe("onConflict target", () => {
  it("captures every key set in the table type", () => {
    expectTypeOf(db.public.users["~keys"]).toEqualTypeOf<
      | readonly ["id", false]
      | readonly ["email", false]
      | readonly ["a" | "b", false]
      | readonly ["c" | "d", true]
      | readonly ["e" | "f", false]
    >();
    expectTypeOf(db.public.pairs["~keys"]).toEqualTypeOf<readonly ["x" | "y", false]>();
    expectTypeOf(db.public.loose["~keys"]).toEqualTypeOf<never>();
  });

  it("accepts each key, in any order", () => {
    const users = insert(db.public.users).values(user);
    users.onConflict((u) => [u.id]).doNothing();
    users.onConflict((u) => [u.email]).doNothing();
    users.onConflict((u) => [u.a, u.b]).doNothing();
    users.onConflict((u) => [u.b, u.a]).doNothing();
    users.onConflict((u) => [u.f, u.e]).doNothing();
    insert(db.public.pairs)
      .values({ x: 1, y: 2 })
      .onConflict((p) => [p.y, p.x])
      .doNothing();
    expect(
      users
        .onConflict((u) => [u.b, u.a])
        .doNothing()
        .toSql(),
    ).toStrictEqual({
      text: 'insert into "public"."users" ("id") values ($1) on conflict ("b", "a") do nothing',
      params: ["u1"],
    });
  });

  it("refuses a column set that is no key", () => {
    const users = insert(db.public.users).values(user);
    // @ts-expect-error -- name has only a plain index
    users.onConflict((u) => [u.name]).doNothing();
    // @ts-expect-error -- a and e are each part of a key, but no key holds both
    users.onConflict((u) => [u.a, u.e]).doNothing();
    // @ts-expect-error -- a subset of a key is no key
    users.onConflict((u) => [u.a]).doNothing();
    // @ts-expect-error -- a superset of a key is no key
    users.onConflict((u) => [u.a, u.b, u.id]).doNothing();
    // @ts-expect-error -- an expression index has no column set
    users.onConflict((u) => [u.email, u.id]).doNothing();
    insert(db.public.loose)
      .values({})
      // @ts-expect-error -- a table without keys takes no target
      .onConflict((l) => [l.p])
      .doNothing();
    insert(db.public.pairs)
      .values({ x: 1, y: 2 })
      // @ts-expect-error -- one column of a composite primary key
      .onConflict((p) => [p.x])
      .doNothing();
    expect(users.toSql().params).toStrictEqual(["u1"]);
  });

  it("requires the predicate for a partial unique index", () => {
    const users = insert(db.public.users).values(user);
    expect(
      users
        .onConflict((u) => [u.d, u.c])
        .where((u) => u.c.isNotNull())
        .doNothing()
        .toSql().text,
    ).toBe(
      'insert into "public"."users" ("id") values ($1) on conflict ("d", "c") where "c" is not null do nothing',
    );
    /* oxlint-disable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access -- the missing method is the point. */
    // @ts-expect-error -- Postgres infers a partial index only with its predicate
    users.onConflict((u) => [u.c, u.d]).doNothing();
    // @ts-expect-error -- a full key takes no predicate
    users.onConflict((u) => [u.id]).where((u) => u.id.eq("x"));
    /* oxlint-enable typescript/no-unsafe-call, typescript/no-unsafe-return, typescript/no-unsafe-member-access */
  });
});
