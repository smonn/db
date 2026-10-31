import { describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { and, from, not, or, type Statement } from "./from.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
  },
});

describe("client.all", () => {
  it("reads typed rows back from a hand-made table", async () => {
    await testDatabase.driver.execute(`
      create table public.users (id text not null, email text);
      insert into public.users values ('u1', 'a@example.com'), ('u2', null);
    `);

    const everything = await client.all(from(db.public.users));
    expect(everything).toStrictEqual([
      { id: "u1", email: "a@example.com" },
      { id: "u2", email: null },
    ]);
    expectTypeOf(everything).toEqualTypeOf<{ id: string; email: string | null }[]>();

    const renamed = await client.all(from(db.public.users).select((u) => ({ mail: u.email })));
    expect(renamed).toStrictEqual([{ mail: "a@example.com" }, { mail: null }]);
    expectTypeOf(renamed).toEqualTypeOf<{ mail: string | null }[]>();
  });

  it("runs inside a transaction through the transaction's client", async () => {
    await testDatabase.driver.execute("create table public.notes (body text)");
    const notes = defineDatabase({ public: { notes: defineTable((c) => ({ body: c.text() })) } });

    const rows = await testDatabase.driver.transaction(async (tx) => {
      await tx.execute("insert into public.notes values ('draft')");
      return createClient(tx).all(from(notes.public.notes));
    });
    expect(rows).toStrictEqual([{ body: "draft" }]);
  });

  it("filters with where, and, or, and not", async () => {
    await testDatabase.driver.execute(`
      create table public.filtered (id text not null, email text);
      insert into public.filtered values ('u1', 'a@example.com'), ('u2', null), ('u3', 'c@example.com');
    `);
    const filtered = defineDatabase({
      public: { filtered: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
    });
    const users = from(filtered.public.filtered);
    const ids = async (query: typeof users) => (await client.all(query)).map((row) => row.id);

    expect(await ids(users.where((u) => u.id.eq("u2")))).toStrictEqual(["u2"]);
    expect(await ids(users.where((u) => u.email.isNull()))).toStrictEqual(["u2"]);
    expect(await ids(users.where((u) => and(u.id.gt("u1"), u.email.isNotNull())))).toStrictEqual([
      "u3",
    ]);
    expect(await ids(users.where((u) => or(u.id.eq("u1"), u.id.eq("u3"))))).toStrictEqual([
      "u1",
      "u3",
    ]);
    expect(await ids(users.where((u) => not(u.id.eq("u1"))))).toStrictEqual(["u2", "u3"]);
    expect(
      await ids(users.where((u) => u.id.gt("u1")).where((u) => u.email.isNotNull())),
    ).toStrictEqual(["u3"]);
  });

  it("reads typed rows from a hand-written select", async () => {
    await testDatabase.driver.execute(`
      create table public.scores (name text not null, points int not null);
      insert into public.scores values ('a', 3), ('b', 5), ('c', 8);
    `);
    const rows = await client.all(
      sql<{ name: string }>`select name from public.scores where points > ${4} order by name`,
    );
    expect(rows).toStrictEqual([{ name: "b" }, { name: "c" }]);
    expectTypeOf(rows).toEqualTypeOf<{ name: string }[]>();
  });
});

describe("client.one", () => {
  it("returns the only row", async () => {
    await testDatabase.driver.execute(
      "create table public.people (id text not null); insert into public.people values ('p1');",
    );
    const people = defineDatabase({
      public: { people: defineTable((c) => ({ id: c.text().notNull() })) },
    });
    const row = await client.one(from(people.public.people));
    expect(row).toStrictEqual({ id: "p1" });
    expectTypeOf(row).toEqualTypeOf<{ id: string }>();
  });

  it("returns the only row of a hand-written select", async () => {
    const row = await client.one(sql<{ total: number }>`select ${2}::int + ${3}::int as total`);
    expect(row).toStrictEqual({ total: 5 });
    expectTypeOf(row).toEqualTypeOf<{ total: number }>();
  });

  it("rejects when no row comes back", async () => {
    await testDatabase.driver.execute("create table public.nobody (id text not null)");
    const nobody = defineDatabase({
      public: { nobody: defineTable((c) => ({ id: c.text().notNull() })) },
    });
    await expect(client.one(from(nobody.public.nobody))).rejects.toThrow(
      "Expected one row but the query returned 0",
    );
  });

  it("rejects when several rows come back", async () => {
    await testDatabase.driver.execute(
      "create table public.crowd (id text not null); insert into public.crowd values ('a'), ('b');",
    );
    const crowd = defineDatabase({
      public: { crowd: defineTable((c) => ({ id: c.text().notNull() })) },
    });
    await expect(client.one(from(crowd.public.crowd))).rejects.toThrow(
      "Expected one row but the query returned 2",
    );
  });
});

describe("client.run", () => {
  const accounts = defineDatabase({
    public: {
      accounts: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
    },
  });

  it("inserts rows and reports the count, then reads them back", async () => {
    await testDatabase.driver.execute(
      "create table public.accounts (id text not null, email text default 'none')",
    );
    const result = await client.run(
      insert(accounts.public.accounts).values([{ id: "a1", email: "a@example.com" }, { id: "a2" }]),
    );
    expect(result).toStrictEqual({ count: 2 });
    expect(await client.all(from(accounts.public.accounts))).toStrictEqual([
      { id: "a1", email: "a@example.com" },
      { id: "a2", email: "none" },
    ]);
  });

  it("returns the inserted row through client.one with returning", async () => {
    await testDatabase.driver.execute(
      "create table public.members (id text not null, email text default 'none')",
    );
    const members = defineDatabase({
      public: { members: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })) },
    });
    const row = await client.one(
      insert(members.public.members)
        .values({ id: "a3" })
        .returning((a) => ({ id: a.id, email: a.email })),
    );
    expect(row).toStrictEqual({ id: "a3", email: "none" });
    expectTypeOf(row).toEqualTypeOf<{ id: string; email: string | null }>();
  });

  it("fills a NOT NULL column with a default or an identity that the row leaves out", async () => {
    await testDatabase.driver.execute(
      "create table public.stamps (id integer generated by default as identity, label text not null default 'new', note text not null)",
    );
    const stamps = defineDatabase({
      public: {
        stamps: defineTable((c) => ({
          id: c.integer().identity(),
          label: c.text().notNull().default("'new'"),
          note: c.text().notNull(),
        })),
      },
    });
    const row = await client.one(
      insert(stamps.public.stamps)
        .values({ note: "hi" })
        .returning((s) => ({ id: s.id, label: s.label, note: s.note })),
    );
    expect(row).toStrictEqual({ id: 1, label: "new", note: "hi" });
  });

  it("runs a hand-written statement and reports the count", async () => {
    await testDatabase.driver.execute(
      "create table public.tags(name text not null); insert into public.tags values ('a'), ('b'), ('c');",
    );
    expect(await client.run(sql`delete from public.tags where name <> ${"b"}`)).toStrictEqual({
      count: 2,
    });
  });

  it("rejects an insert without returning from client.all and client.one", () => {
    const statement = insert(accounts.public.accounts).values({ id: "a4" });
    // Never called: these only have to fail type-checking.
    const rejected = () => {
      // @ts-expect-error an insert without returning yields no rows; use run
      void client.all(statement);
      // @ts-expect-error an insert without returning yields no rows; use run
      void client.one(statement);
      const widened: Statement = statement;
      // @ts-expect-error a bare Statement is not known to return one row
      void client.one(widened);
      // @ts-expect-error a bare Statement is not known to return rows
      void client.all(widened);
      // @ts-expect-error sql without a row type is not a Query
      void client.all(sql`select 1`);
      // @ts-expect-error sql without a row type is not known to return one row
      void client.one(sql`select 1`);
      const several = insert(accounts.public.accounts)
        .values([{ id: "a5" }])
        .returning((a) => ({ id: a.id }));
      // @ts-expect-error one cannot take a multi-row insert, which commits every row first
      void client.one(several);
      // A select through one stays allowed, and so does all on a multi-row insert.
      void client.one(from(accounts.public.accounts));
      void client.all(several);
    };
    expect(rejected).toBeTypeOf("function");
  });
});
