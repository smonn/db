import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public;");
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
      payload: { base: "integer", notNull: true, default: "1" },
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
