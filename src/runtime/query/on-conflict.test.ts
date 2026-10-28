import { describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase(
  {
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
      tags: defineTable(
        (c) => ({ tag: c.text().notNull(), deletedAt: c.timestamptz() }),
        (t) => ({
          indexes: [{ columns: [t.tag], unique: true, where: sql`${t.deletedAt} is null` }],
        }),
      ),
      twice: defineTable(
        (c) => ({ tag: c.text().notNull(), deletedAt: c.timestamptz(), hidden: c.boolean() }),
        (t) => ({
          indexes: [
            { columns: [t.tag], unique: true, where: sql`${t.deletedAt} is null` },
            { columns: [t.tag], unique: true, where: sql`${t.hidden}` },
          ],
        }),
      ),
      covered: defineTable(
        (c) => ({ tag: c.text().unique(), deletedAt: c.timestamptz() }),
        (t) => ({
          indexes: [{ columns: [t.tag], unique: true, where: sql`${t.deletedAt} is null` }],
        }),
      ),
      stamped: defineTable((c) => ({
        id: c.integer().identity("always").primaryKey(),
        tag: c.text().notNull(),
      })),
      items: defineTable((c) => ({
        sku: c.text().notNull().unique(),
        name: c.text().notNull(),
        note: c.text(),
        seenAt: c.timestamptz(),
        version: c.integer().notNull(),
        label: c.text().notNull(),
      })),
    },
  },
  { casing: "snake_case" },
);

const user = { id: "u1" };
const seen = new Date("2026-10-28T12:00:00.000Z");

/** Writes the row unless the stored one has the same or a newer version. */
const upsert = (name: string, version: number) =>
  insert(db.public.items)
    .values({ sku: "s1", name, version, label: "l" })
    .onConflict((i) => [i.sku])
    .doUpdate((excluded) => ({ name: excluded.name, version: excluded.version }))
    .where((existing, excluded) => excluded.version.gt(existing.version))
    .returning((i) => ({ name: i.name, version: i.version }));

describe("onConflict target", () => {
  it("captures every key set in the table type, a partial index by its position", () => {
    expectTypeOf(db.public.users["~keys"]).toEqualTypeOf<
      | readonly ["id", false]
      | readonly ["email", false]
      | readonly ["a" | "b", false]
      | readonly ["c" | "d", "0"]
      | readonly ["e" | "f", false]
    >();
    expectTypeOf(db.public.twice["~keys"]).toEqualTypeOf<
      readonly ["tag", "0"] | readonly ["tag", "1"]
    >();
    expectTypeOf(db.public.loose["~keys"]).toEqualTypeOf<never>();
  });

  it("accepts each key, in any order", () => {
    const users = insert(db.public.users).values(user);
    users.onConflict((u) => [u.id]).doNothing();
    users.onConflict((u) => [u.email]).doNothing();
    users.onConflict((u) => [u.f, u.e]).doNothing();
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
    expect(() => users.onConflict((u) => [u.name])).toThrow(
      '("name") is not a key of "public"."users"',
    );
    // @ts-expect-error -- a subset of a key is no key
    expect(() => users.onConflict((u) => [u.a])).toThrow('("a") is not a key');
    const loose = insert(db.public.loose).values({});
    // @ts-expect-error -- a table without keys takes no target
    expect(() => loose.onConflict((l) => [l.p])).toThrow('("p") is not a key');
  });

  it("appends a partial index's own predicate, and none for a full key", () => {
    expect(
      insert(db.public.users)
        .values(user)
        .onConflict((u) => [u.d, u.c])
        .doNothing()
        .toSql().text,
    ).toBe(
      'insert into "public"."users" ("id") values ($1) on conflict ("d", "c") where "c" is not null do nothing',
    );
    expect(
      insert(db.public.tags)
        .values({ tag: "x" })
        .onConflict((t) => [t.tag])
        .doNothing()
        .toSql().text,
    ).toBe(
      'insert into "public"."tags" ("tag") values ($1) on conflict ("tag") where "deleted_at" is null do nothing',
    );
    expect(
      insert(db.public.covered)
        .values({ tag: "x" })
        .onConflict((t) => [t.tag])
        .doNothing()
        .toSql().text,
    ).toBe('insert into "public"."covered" ("tag") values ($1) on conflict ("tag") do nothing');
  });

  it("refuses a column set two partial indexes back", () => {
    const twice = insert(db.public.twice).values({ tag: "x" });
    // @ts-expect-error -- Postgres would take either index
    expect(() => twice.onConflict((t) => [t.tag])).toThrow(
      '("tag") has several partial unique indexes on "public"."twice"',
    );
  });

  it("infers the partial index in Postgres", async () => {
    await testDatabase.driver.execute(`
      create table public.tags (tag text not null, deleted_at timestamptz);
      create unique index tags_tag_idx on public.tags (tag) where deleted_at is null;
    `);
    const add = insert(db.public.tags)
      .values({ tag: "x" })
      .onConflict((t) => [t.tag])
      .doNothing();
    expect(await client.run(add)).toStrictEqual({ count: 1 });
    expect(await client.run(add)).toStrictEqual({ count: 0 });
  });
});

describe("doUpdate", () => {
  const items = insert(db.public.items).values({
    sku: "s1",
    name: "first",
    version: 2,
    label: "l",
  });

  it("sets excluded columns and values", () => {
    expect(
      items
        .onConflict((i) => [i.sku])
        .doUpdate((excluded) => ({ name: excluded.name, seenAt: seen, note: null }))
        .toSql(),
    ).toStrictEqual({
      text: 'insert into "public"."items" ("sku", "name", "version", "label") values ($1, $2, $3, $4) on conflict ("sku") do update set "name" = excluded."name", "seen_at" = $5, "note" = $6',
      params: ["s1", "first", 2, "l", seen, null],
    });
  });

  it("skips undefined and refuses an empty set", () => {
    expect(
      items
        .onConflict((i) => [i.sku])
        .doUpdate(() => ({ name: "n", note: undefined }))
        .toSql().text,
    ).toMatch(/do update set "name" = \$5$/u);
    expect(() => items.onConflict((i) => [i.sku]).doUpdate(() => ({ note: undefined }))).toThrow(
      "doUpdate needs at least one column to set",
    );
  });

  it("refuses misused set values", () => {
    const update = items.onConflict((i) => [i.sku]);
    // @ts-expect-error -- not a column
    expect(() => update.doUpdate(() => ({ nope: 1 }))).toThrow('"nope" is not a column');
    // @ts-expect-error -- a number for a text column
    update.doUpdate(() => ({ name: 1 }));
    // @ts-expect-error -- an integer column for a text column
    update.doUpdate((excluded) => ({ name: excluded.version }));
    // @ts-expect-error -- a nullable column for a NOT NULL one
    update.doUpdate((excluded) => ({ name: excluded.note }));
    const stamped = insert(db.public.stamped)
      .values({ id: 1, tag: "x" })
      .onConflict((s) => [s.id]);
    // @ts-expect-error -- Postgres refuses to update an identity always column
    expect(() => stamped.doUpdate(() => ({ id: 3 }))).toThrow("identity always");
    // @ts-expect-error -- name is NOT NULL
    update.doUpdate(() => ({ name: null }));
    update.doUpdate((excluded) => ({ name: excluded.label, note: excluded.name }));
  });

  it("qualifies the existing row in where and combines calls with and", () => {
    expect(
      items
        .onConflict((i) => [i.sku])
        .doUpdate((excluded) => ({ name: excluded.name, version: excluded.version }))
        .where((existing, excluded) => excluded.version.gt(existing.version))
        .where((existing) => existing.note.isNull())
        .toSql().text,
    ).toBe(
      'insert into "public"."items" ("sku", "name", "version", "label") values ($1, $2, $3, $4) on conflict ("sku") do update set "name" = excluded."name", "version" = excluded."version" where (excluded."version" > "public"."items"."version" and "public"."items"."note" is null)',
    );
  });

  it("updates only a newer version in Postgres", async () => {
    await testDatabase.driver.execute(`
      create table public.items (
        sku text not null unique,
        name text not null,
        note text,
        seen_at timestamptz,
        version integer not null,
        label text not null
      );
    `);
    expect(await client.all(upsert("one", 1))).toStrictEqual([{ name: "one", version: 1 }]);
    expect(await client.all(upsert("two", 2))).toStrictEqual([{ name: "two", version: 2 }]);
    expect(await client.all(upsert("old", 1))).toStrictEqual([]);
  });
});
