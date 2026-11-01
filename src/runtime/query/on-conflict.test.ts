import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";

const db = defineDatabase(
  {
    public: {
      items: defineTable(
        (c) => ({
          id: c.integer().identity("always").primaryKey(),
          sku: c.text().notNull().unique(),
          a: c.text(),
          b: c.text(),
          tag: c.text(),
          deletedAt: c.timestamptz(),
          version: c.integer().notNull(),
          note: c.text(),
        }),
        (t) => ({
          unique: [{ columns: [t.a, t.b] }],
          indexes: [{ columns: [t.tag], unique: true, where: sql`${t.deletedAt} is null` }],
        }),
      ),
    },
  },
  { casing: "snake_case" },
);
const { items } = db.public;

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

beforeEach(async () => {
  await testDatabase.driver.execute(
    [
      "drop table if exists public.items",
      `create table public.items (
        id integer generated always as identity primary key,
        sku text not null unique,
        a text,
        b text,
        tag text,
        deleted_at timestamptz,
        version integer not null,
        note text,
        unique (a, b)
      )`,
      "create unique index on public.items (tag) where deleted_at is null",
    ].join("; "),
  );
});

const rows = () =>
  client.all(
    from(items)
      .pick("sku", "a", "b", "tag", "version", "note")
      .orderBy((u) => u.id),
  );

const upsertVersion = (version: number) =>
  client.all(
    insert(items)
      .values({ sku: "s", version, note: `v${version}` })
      .onConflict((u) => [u.sku])
      .doUpdate((_, excluded) => ({ version: excluded.version, note: excluded.note }))
      .where((existing, excluded) => excluded.version.gt(existing.version))
      .returning((u) => ({ note: u.note, version: u.version })),
  );

const doNothing = () =>
  insert(items)
    .values({ sku: "s", version: 1 })
    .onConflict((u) => [u.sku])
    .doNothing();

const reversedPair = (sku: string) =>
  insert(items)
    .values({ sku, a: "x", b: "y", version: 1 })
    .onConflict((u) => [u.b, u.a])
    .doUpdate(() => ({ note: "again" }));

const tagged = (sku: string) =>
  insert(items)
    .values({ sku, tag: "t", version: 1 })
    .onConflict((u) => [u.tag])
    .doNothing();

const nullablePair = (sku: string) =>
  insert(items)
    .values({ sku, a: "x", version: 1 })
    .onConflict((u) => [u.a, u.b])
    .doNothing();

describe("onConflict on Postgres", () => {
  it("skips a row whose key is taken under doNothing, returning none", async () => {
    expect(await client.run(doNothing())).toStrictEqual({ count: 1 });
    expect(await client.run(doNothing())).toStrictEqual({ count: 0 });
    expect(await client.all(doNothing().returning((u) => ({ sku: u.sku })))).toStrictEqual([]);
  });

  it("updates the existing row from the excluded one, returning the new values", async () => {
    await client.run(insert(items).values({ sku: "s", version: 1, note: "old" }));
    const returned = await client.all(
      insert(items)
        .values({ sku: "s", version: 2, note: "new" })
        .onConflict((u) => [u.sku])
        .doUpdate((existing, excluded) => ({
          note: excluded.note,
          version: sql.expr<number>`${existing.version} + ${excluded.version}`,
        }))
        .returning((u) => ({ note: u.note, version: u.version })),
    );
    expect(returned).toStrictEqual([{ note: "new", version: 3 }]);
  });

  it("updates only where the where holds, so a stale row returns none", async () => {
    expect(await upsertVersion(1)).toStrictEqual([{ note: "v1", version: 1 }]);
    expect(await upsertVersion(2)).toStrictEqual([{ note: "v2", version: 2 }]);
    expect(await upsertVersion(1)).toStrictEqual([]);
    expect(await rows()).toMatchObject([{ note: "v2", version: 2 }]);
  });

  it("infers a composite key from its columns in any order", async () => {
    await client.run(reversedPair("one"));
    await client.run(reversedPair("two"));
    expect(await rows()).toMatchObject([{ sku: "one", note: "again" }]);
  });

  it("infers a partial unique index through the predicate it appends", async () => {
    expect(await client.run(tagged("one"))).toStrictEqual({ count: 1 });
    expect(await client.run(tagged("two"))).toStrictEqual({ count: 0 });
  });

  it("finds no conflict on a NULL in a nullable key", async () => {
    await client.run(nullablePair("one"));
    await client.run(nullablePair("two"));
    expect((await rows()).map((row) => row.sku)).toStrictEqual(["one", "two"]);
  });

  it("keeps the first of a key repeated in one valuesMany under doNothing, and fails under doUpdate", async () => {
    const repeated = [
      { sku: "s", version: 1 },
      { sku: "s", version: 2 },
    ];
    await client.run(
      insert(items)
        .valuesMany(repeated)
        .onConflict((u) => [u.sku])
        .doNothing(),
    );
    expect(await rows()).toMatchObject([{ sku: "s", version: 1 }]);
    await expect(
      client.run(
        insert(items)
          .valuesMany(repeated)
          .onConflict((u) => [u.sku])
          .doUpdate((_, excluded) => ({ version: excluded.version })),
      ),
    ).rejects.toThrow("cannot affect row a second time");
  });

  it("leaves an identity always column to Postgres, which refuses to update it", async () => {
    await client.run(insert(items).values({ sku: "s", version: 1 }));
    await expect(
      client.run(
        insert(items)
          .values({ sku: "s", version: 1 })
          .onConflict((u) => [u.sku])
          // @ts-expect-error an identity always column is not set
          .doUpdate(() => ({ id: 5 })),
      ),
    ).rejects.toThrow('column "id" can only be updated to DEFAULT');
  });

  it("returns no row to client.one when doNothing skips it", async () => {
    const skipped = doNothing().returning((u) => ({ sku: u.sku }));
    await client.run(skipped);
    // @ts-expect-error on conflict may skip the row
    await expect(client.one(skipped)).rejects.toThrow("Expected one row but the query returned 0");
  });
});
