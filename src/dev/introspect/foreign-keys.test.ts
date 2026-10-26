import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { namesOf, type Catalog } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(`
    drop schema if exists auth, smonn_db cascade;
    drop schema public cascade;
    create schema public;
  `);
});

function foreignKeys(catalog: Catalog): [string, unknown][] {
  return [...catalog.values()]
    .filter((fact) => fact.kind === "foreign key")
    .map((fact) => [namesOf(catalog, fact).join("."), fact.payload]);
}

describe("introspect foreign keys", () => {
  it("reads a foreign key's columns, target, actions, match, and deferrable mode", async () => {
    await db.driver.execute(`
      create table users (id integer primary key, email text unique);
      create table orders (
        id integer primary key,
        user_id integer constraint orders_user references users (id),
        email text
      );
      alter table orders add constraint orders_email foreign key (email)
        references users (email) match full on delete set null on update cascade
        deferrable initially deferred;
    `);

    expect(foreignKeys(await introspect(db.driver))).toStrictEqual([
      [
        "public.orders.orders_email",
        {
          columns: ["email"],
          target: { schema: "public", table: "users", columns: ["email"] },
          onDelete: "set null",
          onUpdate: "cascade",
          match: "full",
          deferrable: "deferred",
        },
      ],
      [
        "public.orders.orders_user",
        {
          columns: ["user_id"],
          target: { schema: "public", table: "users", columns: ["id"] },
          onDelete: "no action",
          onUpdate: "no action",
          match: "simple",
          deferrable: "not deferrable",
        },
      ],
    ]);
  });

  it.each([
    ["no action", "no action"],
    ["restrict", "restrict"],
    ["cascade", "cascade"],
    ["set null", "set null"],
    ["set default", "set default"],
  ])("reads the %s action on delete and on update", async (_, action) => {
    await db.driver.execute(`
      create table users (id integer primary key);
      create table orders (user_id integer default 1 references users (id)
        on delete ${action} on update ${action});
    `);

    const payload = foreignKeys(await introspect(db.driver))[0]?.[1];

    expect(payload).toMatchObject({ onDelete: action, onUpdate: action });
  });

  it.each([
    ["deferrable initially immediate", "immediate"],
    ["deferrable", "immediate"],
    ["deferrable initially deferred", "deferred"],
    ["not deferrable", "not deferrable"],
  ])("reads %s as %s", async (clause, deferrable) => {
    await db.driver.execute(`
      create table users (id integer primary key);
      create table orders (user_id integer references users (id) ${clause});
    `);

    const payload = foreignKeys(await introspect(db.driver))[0]?.[1];

    expect(payload).toMatchObject({ deferrable });
  });

  it("reads the same foreign key whether or not it is valid", async () => {
    await db.driver.execute(`
      create table users (id integer primary key);
      create table orders (user_id integer);
      insert into orders values (7);
      alter table orders add constraint orders_user foreign key (user_id)
        references users (id) not valid;
    `);

    expect(foreignKeys(await introspect(db.driver))).toHaveLength(1);
  });

  it("reads a foreign key between schemas, and one that points at its own table", async () => {
    await db.driver.execute(`
      create schema auth;
      create table auth.users (id integer primary key);
      create table orders (
        id integer primary key,
        user_id integer references auth.users (id),
        parent_id integer references orders (id)
      );
    `);

    expect(foreignKeys(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.orders.orders_parent_id_fkey",
      "public.orders.orders_user_id_fkey",
    ]);
  });

  it("pairs the columns of a composite foreign key by position, in key order", async () => {
    await db.driver.execute(`
      create table pairs (a integer, b integer, primary key (a, b));
      create table refs (x integer, y integer, foreign key (y, x) references pairs (b, a));
    `);

    const payload = foreignKeys(await introspect(db.driver))[0]?.[1];

    expect(payload).toMatchObject({
      columns: ["y", "x"],
      target: { columns: ["b", "a"] },
    });
  });

  // Each variant has the shape of a plain foreign key but means something else (ADR-0005).
  it("skips a NOT ENFORCED foreign key", async () => {
    await db.driver.execute(`
      create table users (id integer primary key);
      create table orders (a integer, b integer);
      alter table orders add constraint kept foreign key (a) references users (id);
      alter table orders add constraint skipped foreign key (b) references users (id) not enforced;
    `);

    expect(foreignKeys(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.orders.kept",
    ]);
  });

  it("skips a foreign key that uses PERIOD", async () => {
    await db.driver.execute(`
      create extension if not exists btree_gist;
      create table parent (id integer, valid daterange, primary key (id, valid without overlaps));
      create table child (id integer, valid daterange, parent_id integer);
      alter table child add constraint skipped foreign key (parent_id, period valid)
        references parent (id, period valid);
    `);

    expect(foreignKeys(await introspect(db.driver))).toStrictEqual([]);
  });

  it("skips a foreign key whose SET NULL or SET DEFAULT names a column list", async () => {
    await db.driver.execute(`
      create table pairs (a integer, b integer, primary key (a, b));
      create table refs (a integer, b integer default 1);
      alter table refs add constraint plain foreign key (a, b) references pairs (a, b)
        on delete set null;
      alter table refs add constraint nulls foreign key (a, b) references pairs (a, b)
        on delete set null (b);
      alter table refs add constraint defaults foreign key (a, b) references pairs (a, b)
        on delete set default (b);
    `);

    expect(foreignKeys(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.refs.plain",
    ]);
  });

  it("skips a foreign key that points at an Unmodeled table", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.tracked (id integer primary key);
      create table parted (id integer primary key) partition by list (id);
      create table parted_1 partition of parted for values in (1);
      create table modeled (id integer primary key);
      create table refs (
        tracked integer references smonn_db.tracked (id),
        parted integer references parted (id),
        part integer references parted_1 (id),
        kept integer references modeled (id)
      );
    `);

    expect(foreignKeys(await introspect(db.driver)).map(([name]) => name)).toStrictEqual([
      "public.refs.refs_kept_fkey",
    ]);
  });

  it("skips a foreign key on a partitioned table or one of its partitions", async () => {
    await db.driver.execute(`
      create table users (id integer primary key);
      create table parted (id integer, user_id integer references users (id))
        partition by list (id);
      create table parted_1 partition of parted for values in (1);
    `);

    expect(foreignKeys(await introspect(db.driver))).toStrictEqual([]);
  });
});
