import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { namesOf } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(`
    drop extension if exists hstore;
    drop schema public cascade;
    create schema public;
  `);
});

describe("introspect enums", () => {
  it("reads an enum's labels in sort order, including one added in the middle", async () => {
    await db.driver.execute(`
      create type public.mood as enum ('sad', 'ok');
      alter type public.mood add value 'meh' after 'sad';
      alter type public.mood add value 'low' before 'sad';
    `);

    expect(Object.fromEntries(await introspect(db.driver))["public\0mood"]).toStrictEqual({
      kind: "enum",
      name: "mood",
      parent: "public",
      payload: { labels: ["low", "sad", "meh", "ok"] },
    });
  });

  it("reads an enum with no labels", async () => {
    await db.driver.execute("create type public.none as enum ()");

    expect(Object.fromEntries(await introspect(db.driver))["public\0none"]).toMatchObject({
      payload: { labels: [] },
    });
  });

  it("skips an enum an extension owns", async () => {
    await db.driver.execute(`
      create extension hstore;
      create type public.owned as enum ('a');
      alter extension hstore add type public.owned;
      create type public.kept as enum ('b');
    `);

    const catalog = await introspect(db.driver);

    expect([...catalog.values()].map((fact) => namesOf(catalog, fact).join("."))).toStrictEqual([
      "public",
      "public.kept",
    ]);
  });
});
