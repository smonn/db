import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public;");
});

describe("introspect array columns", () => {
  it("reads the type as format_type spells it, and ignores declared dimensions", async () => {
    await db.driver.execute(`
      create type public.mood as enum ('sad', 'ok');
      create table public.t (
        ints integer[],
        grid integer[][],
        sized varchar(20)[3],
        moods public.mood[] not null,
        stamps timestamptz[]
      );
    `);

    const catalog = Object.fromEntries(await introspect(db.driver));

    expect(
      ["ints", "grid", "sized", "moods", "stamps"].map(
        (name) => catalog[`public\0t\0${name}`]?.payload,
      ),
    ).toStrictEqual([
      { type: "integer[]", notNull: false },
      { type: "integer[]", notNull: false },
      { type: "character varying(20)[]", notNull: false },
      { type: "public.mood[]", notNull: true },
      { type: "timestamp with time zone[]", notNull: false },
    ]);
  });

  it("skips a column that is an array of a composite or range type", async () => {
    await db.driver.execute(`
      create type public.pair as (a integer, b integer);
      create table public.other (id integer);
      create table public.t (
        id integer,
        pairs public.pair[],
        spans int4range[],
        others public.other[],
        tags text[]
      );
    `);

    const catalog = await introspect(db.driver);

    expect(
      [...catalog.values()].filter((fact) => fact.parent === "public\0t").map((fact) => fact.name),
    ).toStrictEqual(["id", "tags"]);
  });
});
