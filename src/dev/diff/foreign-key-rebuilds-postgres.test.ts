import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { diff } from "./diff.ts";

const db = useTestDatabase();

async function reset(): Promise<void> {
  await db.driver.execute("drop schema public cascade; create schema public");
}

/** What `sql` builds, read back from a clean schema. */
async function catalogOf(sql: string): Promise<Catalog> {
  await reset();
  await db.driver.execute(sql);
  const catalog = await introspect(db.driver);
  await reset();
  return catalog;
}

beforeEach(reset);

/** Migrates a database built by `from` to what `to` builds, and returns the diff's SQL. */
async function migrate(from: string, to: string): Promise<string> {
  const wanted = await catalogOf(to);
  await db.driver.execute(from);
  const { sql } = diff(await introspect(db.driver), wanted);
  await db.driver.execute(sql);
  expect(await introspect(db.driver)).toStrictEqual(wanted);
  expect(diff(await introspect(db.driver), wanted).sql).toBe("");
  return sql;
}

const FK = "orders_user_id_fkey";
/** The drops and adds of the constraint, in the order the SQL has them. */
const steps = (sql: string, name = FK): string[] =>
  [...sql.matchAll(new RegExp(`(drop|add) constraint "${name}"`, "gu"))].map(
    ([, step]) => step ?? "",
  );

const orders = (type: string): string =>
  `create table orders (user_id ${type} constraint ${FK} references users (id));`;

const pairs =
  "create table orders (a integer, b integer, foreign key (a, b) references users (a, b));";

describe("an unchanged foreign key around a change to the key or columns it names", () => {
  it("rebuilds it around a dropped target key", async () => {
    const sql = await migrate(
      `create table users (id integer constraint users_key unique); ${orders("integer")}`,
      `create table users (id integer primary key); ${orders("integer")}`,
    );

    expect(steps(sql)).toStrictEqual(["drop", "add"]);
  });

  it("rebuilds it around a rebuilt target key", async () => {
    const sql = await migrate(
      `create table users (a integer, b integer, unique (a, b)); ${pairs}`,
      `create table users (a integer, b integer, unique (b, a)); ${pairs}`,
    );

    expect(steps(sql, "orders_a_b_fkey")).toStrictEqual(["drop", "add"]);
  });

  it("keeps it when a key on only some of its target columns drops", async () => {
    const sql = await migrate(
      `create table users (a integer, b integer, unique (a, b), unique (a)); ${pairs}`,
      `create table users (a integer, b integer, unique (a, b)); ${pairs}`,
    );

    expect(steps(sql, "orders_a_b_fkey")).toStrictEqual([]);
  });

  it("rebuilds it around a target key backed by a unique index", async () => {
    const sql = await migrate(
      `create table users (id integer); create unique index users_id on users (id); ${orders("integer")}`,
      `create table users (id integer primary key); ${orders("integer")}`,
    );

    expect(steps(sql)).toStrictEqual(["drop", "add"]);
  });

  it("rebuilds it around a retyped target key", async () => {
    const sql = await migrate(
      `create table users (id integer primary key); ${orders("integer")}`,
      `create table users (id text primary key); ${orders("text")}`,
    );

    expect(steps(sql)).toStrictEqual(["drop", "add"]);
  });

  it("rebuilds it around a target column Postgres can't alter in place", async () => {
    const sql = await migrate(
      `create table users (id integer primary key, n integer unique); create table posts (n integer references users (n));`,
      `create table users (id integer primary key, n integer generated always as (id) stored unique); create table posts (n integer references users (n));`,
    );

    expect(steps(sql, "posts_n_fkey")).toStrictEqual(["drop", "add"]);
  });

  it("drops a foreign key once when its referencing column rebuilds too", async () => {
    const sql = await migrate(
      `create table users (id integer primary key, n integer unique); create table posts (n integer references users (n));`,
      `create table users (id integer primary key, n integer generated always as (id) stored unique); create table posts (n integer generated always as (1) stored references users (n));`,
    );

    expect(steps(sql, "posts_n_fkey")).toStrictEqual(["drop", "add"]);
  });

  it("keeps the foreign key through an integer widening of either side", async () => {
    const sql = await migrate(
      `create table users (id integer primary key); ${orders("integer")}`,
      `create table users (id bigint primary key); ${orders("bigint")}`,
    );

    expect(sql).not.toContain("constraint");
  });

  it("keeps the foreign key through a text to varchar retype of the target", async () => {
    const sql = await migrate(
      `create table users (id text primary key); ${orders("text")}`,
      `create table users (id varchar(20) primary key); ${orders("text")}`,
    );

    expect(sql).not.toContain("constraint");
  });

  it("keeps the foreign key through a renamed target key", async () => {
    const sql = await migrate(
      `create table users (id integer constraint users_old primary key); ${orders("integer")}`,
      `create table users (id integer constraint users_new primary key); ${orders("integer")}`,
    );

    expect(steps(sql)).toStrictEqual([]);
  });

  it("drops the old name and adds the new one when a renamed foreign key's columns retype", async () => {
    const sql = await migrate(
      `create table users (id integer primary key); ${orders("integer")}`,
      `create table users (id text primary key);
       create table orders (user_id text constraint orders_owner_fkey references users (id));`,
    );

    expect(steps(sql)).toStrictEqual(["drop"]);
    expect(steps(sql, "orders_owner_fkey")).toStrictEqual(["add"]);
    expect(sql).not.toContain("rename constraint");
  });

  it("drops the old name and adds the new one when a renamed foreign key's target key drops", async () => {
    const sql = await migrate(
      `create table users (id integer constraint users_key unique); ${orders("integer")}`,
      `create table users (id integer primary key);
       create table orders (user_id integer constraint orders_owner_fkey references users (id));`,
    );

    expect(steps(sql)).toStrictEqual(["drop"]);
    expect(steps(sql, "orders_owner_fkey")).toStrictEqual(["add"]);
    expect(sql).not.toContain("rename constraint");
  });

  it("renames a foreign key whose target and columns stay", async () => {
    const sql = await migrate(
      `create table users (id integer primary key); ${orders("integer")}`,
      `create table users (id integer primary key);
       create table orders (user_id integer constraint orders_owner_fkey references users (id));`,
    );

    expect(sql).toContain(`rename constraint "${FK}" to "orders_owner_fkey"`);
    expect(sql).not.toContain("drop constraint");
  });

  it("rebuilds a foreign key between columns of a swapped enum", async () => {
    const sql = await migrate(
      `create type mood as enum ('a', 'b', 'c');
       create table users (id mood primary key);
       create table orders (user_id mood constraint ${FK} references users (id));`,
      `create type mood as enum ('c', 'b');
       create table users (id mood primary key);
       create table orders (user_id mood constraint ${FK} references users (id));`,
    );

    expect(steps(sql)).toStrictEqual(["drop", "add"]);
    expect(sql.indexOf(`drop constraint "${FK}"`)).toBeLessThan(sql.indexOf("using"));
    expect(sql.indexOf("using")).toBeLessThan(sql.indexOf(`add constraint "${FK}"`));
  });
});
