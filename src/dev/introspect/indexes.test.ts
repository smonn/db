import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { expression, indexes, key, only } from "./indexes.test-helper.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(`
    drop schema if exists auth, smonn_db cascade;
    drop schema public cascade;
    create schema public;
  `);
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
          where: undefined,
          nullsNotDistinct: false,
        },
      ],
      [
        "public.t.t_b_c",
        {
          unique: false,
          method: "hash",
          keys: [key("b")],
          include: [],
          where: undefined,
          nullsNotDistinct: false,
        },
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
          where: undefined,
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
          where: undefined,
          nullsNotDistinct: true,
        },
      ],
      [
        "public.t.v",
        {
          unique: true,
          method: "btree",
          keys: [key("c")],
          include: [],
          where: undefined,
          nullsNotDistinct: false,
        },
      ],
    ]);
  });

  it("reads an expression key as Postgres deparses it, wrapped or bare, beside plain keys", async () => {
    await db.driver.execute(`
      create table t (a integer, b text);
      create index i on t (lower(b) desc, a, (a + 1), (b || 'x') nulls first);
    `);

    const payload = only(await introspect(db.driver));

    expect(payload.keys).toStrictEqual([
      expression("lower(b)", true, true),
      key("a"),
      expression("a + 1"),
      expression("b || 'x'::text", false, true),
    ]);
  });

  it("reads a partial index's predicate as Postgres deparses it", async () => {
    await db.driver.execute(`
      create table t (a integer, b text);
      create unique index i on t (a) where b is not null and a > 0;
    `);

    const payload = only(await introspect(db.driver));

    expect(payload.where).toBe("b IS NOT NULL AND a > 0");
    expect(payload.unique).toBe(true);
  });

  it("reads an expression and a predicate together, with INCLUDE columns", async () => {
    await db.driver.execute(`
      create table t (a integer, b text, c integer);
      create index i on t (lower(b)) include (c) where a > 0;
    `);

    const payload = only(await introspect(db.driver));

    expect(payload).toStrictEqual({
      unique: false,
      method: "btree",
      keys: [expression("lower(b)")],
      include: ["c"],
      where: "a > 0",
      nullsNotDistinct: false,
    });
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
});
