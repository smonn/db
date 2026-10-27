import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists other cascade; drop schema public cascade; create schema public;",
  );
});

const facts = async () => Object.fromEntries(await introspect(db.driver));

describe("introspect domains", () => {
  it("reads a domain's base, folded NOT NULL, default, and each check", async () => {
    await db.driver.execute(`
      create type public.mood as enum ('a', 'b');
      create domain public.posint as integer not null default 1 constraint positive check (value > 0);
      create domain public.calm as public.mood default 'a';
    `);

    const read = await facts();

    expect(read["public\0posint"]).toStrictEqual({
      kind: "domain",
      name: "posint",
      parent: "public",
      payload: { base: "integer", notNull: true, default: "1", defaultVolatile: false },
    });
    expect(read["public\0posint\0positive"]).toStrictEqual({
      kind: "domain check",
      name: "positive",
      parent: "public\0posint",
      payload: { expression: "(VALUE > 0)" },
    });
    expect(read["public\0calm"]).toMatchObject({
      payload: { base: "public.mood", notNull: false, default: "'a'::public.mood" },
    });
    expect(Object.keys(read).filter((key) => key.startsWith("public\0posint\0"))).toStrictEqual([
      "public\0posint\0positive",
    ]);
    expect(Object.keys(read).filter((key) => key.startsWith("public\0calm\0"))).toStrictEqual([]);
  });

  it("reads each schema's domains under that schema only", async () => {
    await db.driver.execute(`
      create schema other;
      create domain public.here as integer constraint positive check (value > 0);
      create domain other.here as integer;
      create domain other.there as integer;
    `);

    expect(Object.keys(await facts()).toSorted()).toStrictEqual([
      "other",
      "other\0here",
      "other\0there",
      "public",
      "public\0here",
      "public\0here\0positive",
    ]);
  });

  it("reads whether a domain's default calls a volatile function", async () => {
    await db.driver.execute(`
      create domain public.id as uuid default gen_random_uuid();
      create domain public.label as text default 'random()';
      create domain public.bare as text;
    `);

    const read = await facts();

    expect(read["public\0id"]).toMatchObject({ payload: { defaultVolatile: true } });
    expect(read["public\0label"]).toMatchObject({ payload: { defaultVolatile: false } });
    expect(read["public\0bare"]).toMatchObject({ payload: { defaultVolatile: false } });
  });

  it("reads a NOT VALID check as the same fact as a valid one", async () => {
    await db.driver.execute(`
      create domain public.d as integer;
      alter domain public.d add constraint positive check (value > 0) not valid;
    `);

    expect((await facts())["public\0d\0positive"]).toMatchObject({
      payload: { expression: "(VALUE > 0)" },
    });
  });

  it("skips as Unmodeled a domain over a domain or an array, or with its own collation", async () => {
    await db.driver.execute(`
      create domain public.d as integer;
      create domain public.over_domain as public.d check (value > 0);
      create domain public.over_array as integer[] check (cardinality(value) > 0);
      create domain public.collated as text collate "C" check (value <> '');
    `);

    expect(Object.keys(await facts())).toStrictEqual(["public", "public\0d"]);
  });
});
