import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { namesOf, type Catalog, type IndexPayload } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(`
    drop schema if exists auth, smonn_db cascade;
    drop schema public cascade;
    create schema public;
  `);
});

function indexes(catalog: Catalog): [string, IndexPayload][] {
  const found: [string, IndexPayload][] = [];
  for (const fact of catalog.values()) {
    if (fact.kind === "index") found.push([namesOf(catalog, fact).join("."), fact.payload]);
  }
  return found;
}

const key = (column: string, descending = false, nullsFirst = descending) => ({
  column,
  descending,
  nullsFirst,
});

describe("introspect indexes", () => {
  it("reads a plain index's keys, method, and flags", async () => {
    await db.driver.execute(`
      create table t (a integer, b text, c text);
      create index t_a_idx on t (a);
      create index t_b_c on t using hash (b);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([
      [
        "public.t.t_a_idx",
        {
          unique: false,
          method: "btree",
          keys: [key("a")],
          include: [],
          nullsNotDistinct: false,
        },
      ],
      [
        "public.t.t_b_c",
        { unique: false, method: "hash", keys: [key("b")], include: [], nullsNotDistinct: false },
      ],
    ]);
  });

  it("reads every modeled method", async () => {
    await db.driver.execute(`
      create table t (a integer, tags text[], r int4range, n integer);
      create index i_btree on t using btree (a);
      create index i_hash on t using hash (a);
      create index i_gin on t using gin (tags);
      create index i_brin on t using brin (n);
      create index i_gist on t using gist (r) include (a);
    `);

    const read = indexes(await introspect(db.driver)).map(([name, { method }]) => [name, method]);

    expect(read).toStrictEqual([
      ["public.t.i_brin", "brin"],
      ["public.t.i_btree", "btree"],
      ["public.t.i_gin", "gin"],
      ["public.t.i_gist", "gist"],
      ["public.t.i_hash", "hash"],
    ]);
  });

  it("reads key order and NULLs placement, in key order", async () => {
    await db.driver.execute(`
      create table t (a integer, b integer, c integer, d integer);
      create index i on t (c desc, a, b desc nulls last, d nulls first);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([
      [
        "public.t.i",
        {
          unique: false,
          method: "btree",
          keys: [key("c", true, true), key("a"), key("b", true, false), key("d", false, true)],
          include: [],
          nullsNotDistinct: false,
        },
      ],
    ]);
  });

  it("reads INCLUDE columns in order, a unique index, and NULLS NOT DISTINCT", async () => {
    await db.driver.execute(`
      create table t (a integer, b integer, c integer, d integer);
      create unique index u on t (a, b) include (d, c) nulls not distinct;
      create unique index v on t (c);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([
      [
        "public.t.u",
        {
          unique: true,
          method: "btree",
          keys: [key("a"), key("b")],
          include: ["d", "c"],
          nullsNotDistinct: true,
        },
      ],
      [
        "public.t.v",
        { unique: true, method: "btree", keys: [key("c")], include: [], nullsNotDistinct: false },
      ],
    ]);
  });

  it("reads an index in another schema under that schema's table", async () => {
    await db.driver.execute(`
      create schema auth;
      create table auth.users (email text);
      create index users_email_idx on auth.users (email);
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "auth.users.users_email_idx",
    ]);
  });

  it("skips an index with another method", async () => {
    await db.driver.execute(`
      create table t (r int4range);
      create index t_r on t using spgist (r);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([]);
  });

  it("skips an index with a non-default opclass, a collation, or storage parameters", async () => {
    await db.driver.execute(`
      create table t (a text, b text, c integer);
      create index by_opclass on t (a text_pattern_ops);
      create index by_collation on t (b collate "C");
      create index by_param on t (c) with (fillfactor = 70);
      create index plain on t (c);
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.t.plain",
    ]);
  });

  it("keeps an index that names the column's own collation", async () => {
    await db.driver.execute(`
      create table t (a text collate "C");
      create index by_own on t (a);
      create index by_same on t (a collate "C");
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.t.by_own",
      "public.t.by_same",
    ]);
  });

  it("skips an index in a tablespace", async () => {
    const space = `smonndb_ts_${db.name}`;
    await db.driver.execute(`copy (select 1) to program 'mkdir -p /tmp/${space}'`);
    await db.driver.execute(`create tablespace ${space} location '/tmp/${space}'`);
    try {
      await db.driver.execute(`
        create table t (a integer);
        create index in_space on t (a) tablespace ${space};
        create index plain on t (a);
      `);

      expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
        "public.t.plain",
      ]);
    } finally {
      await db.driver.execute("drop table t");
      await db.driver.execute(`drop tablespace ${space}`);
    }
  });

  it("skips an expression index and a partial index, which wait for #442", async () => {
    await db.driver.execute(`
      create table t (a integer, b text);
      create index by_expression on t (lower(b));
      create index by_predicate on t (a) where a > 0;
      create index plain on t (a);
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.t.plain",
    ]);
  });

  it("skips the index of a primary key, a unique, and an exclusion constraint", async () => {
    await db.driver.execute(`
      create table t (
        id integer primary key,
        u integer unique,
        r int4range,
        exclude using gist (r with &&)
      );
      create unique index plain_unique on t (id, u);
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.t.plain_unique",
    ]);
  });

  it("skips the index of a deferrable unique, which the constraint already leaves Unmodeled", async () => {
    await db.driver.execute(`
      create table t (a integer, constraint t_a unique (a) deferrable);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([]);
  });

  it("keeps a unique index a foreign key points at", async () => {
    await db.driver.execute(`
      create table users (id integer not null);
      create unique index users_id on users (id);
      create table orders (user_id integer references users (id));
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.users.users_id",
    ]);
  });

  it("skips an index on a partitioned table's partitions and on the parent", async () => {
    await db.driver.execute(`
      create table p (a integer) partition by range (a);
      create table p1 partition of p for values from (0) to (10);
      create index p_a on p (a);
    `);

    expect(indexes(await introspect(db.driver))).toStrictEqual([]);
  });

  it("skips an index on a column an array of a range makes Unmodeled", async () => {
    await db.driver.execute(`
      create table t (a integer, r int4range[]);
      create index by_range on t (r);
      create index by_include on t (a) include (r);
      create index plain on t (a);
    `);

    expect(indexes(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.t.plain",
    ]);
  });
});
