import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog, namesOf, type Catalog } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

function paths(catalog: Catalog): string[] {
  return [...catalog.values()].map((fact) => namesOf(catalog, fact).join("."));
}

beforeEach(async () => {
  await db.driver.execute(`
    drop extension if exists hstore;
    drop schema if exists auth, smonn_db, ext cascade;
    drop schema public cascade;
    create schema public;
  `);
});

describe("introspect", () => {
  it("reads the same facts the Definition asks for", async () => {
    await db.driver.execute(`
      create schema auth;
      create table auth.users (id text not null, email text);
      create table auth.empty ();
    `);
    const definition = defineDatabase({
      public: {},
      auth: {
        users: defineTable((c) => ({ id: c.text().notNull(), email: c.text() })),
        empty: defineTable(() => ({})),
      },
    });

    const catalog = await introspect(db.driver);

    expect(new Map([...catalog].toSorted(([a], [b]) => a.localeCompare(b)))).toStrictEqual(
      new Map([...definitionCatalog(definition)].toSorted(([a], [b]) => a.localeCompare(b))),
    );
  });

  it("lists columns in table order", async () => {
    await db.driver.execute("create table t (b text, a text, c text); alter table t drop column a");
    expect(paths(await introspect(db.driver))).toStrictEqual([
      "public",
      "public.t",
      "public.t.b",
      "public.t.c",
    ]);
  });

  it("skips the tracking schema, extension members, and views", async () => {
    await db.driver.execute(`
      create schema smonn_db;
      create table smonn_db.current (hash text not null);
      create extension hstore;
      create schema ext;
      create table ext.owned (a text);
      alter extension hstore add schema ext;
      alter extension hstore add table ext.owned;
      create table public.kept (a text);
      create view public.v as select 1 as one;
    `);

    expect(paths(await introspect(db.driver))).toStrictEqual([
      "public",
      "public.kept",
      "public.kept.a",
    ]);
  });

  it("skips a configured tracking schema and keeps smonn_db", async () => {
    await db.driver.execute(`
      drop schema if exists "AppTracking" cascade;
      create schema "AppTracking";
      create table "AppTracking".current (hash text not null);
      create schema smonn_db;
    `);

    expect(paths(await introspect(db.driver, "AppTracking"))).toStrictEqual(["public", "smonn_db"]);
  });
});
