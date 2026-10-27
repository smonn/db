import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { Scan } from "../diff/index.ts";
import { unmodeledBlockers } from "./blockers.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(`
    drop schema public cascade; create schema public;
    create table public.users (id integer primary key, name text default 'x',
      upper_name text generated always as (upper(name)) stored);
    create table public.orders (id integer, user_id integer references public.users (id));
    create table public.log (x integer);
    create rule copy as on insert to public.log do also select u.name from public.users u;`);
});

const table = (name: string): Scan => ({
  walk: "drop",
  object: { type: "table", names: ["public", name], args: [] },
});
const column = (walk: Scan["walk"], name: string): Scan => ({
  walk,
  object: { type: "table column", names: ["public", "users", name], args: [] },
});

/** The lines naming a target or a blocker, without the header and the hint. */
async function blockerLines(scans: readonly Scan[]): Promise<readonly string[]> {
  const message = await unmodeledBlockers(db.driver, scans);
  return message?.split("\n").slice(1, -1) ?? [];
}

describe("unmodeledBlockers", () => {
  it("reports a retype's generated column as the column, and leaves out the column's own default", async () => {
    expect(await blockerLines([column("retype", "name")])).toStrictEqual([
      "  table column public.users.name, which it retypes:",
      "    rule copy on public.log",
      "    table column public.users.upper_name",
    ]);
  });

  it("leaves out a generated column whose expression the plan drops", async () => {
    const expression: Scan = {
      walk: "remove",
      object: { type: "default value", names: ["public", "users", "upper_name"], args: [] },
    };

    expect(await blockerLines([column("retype", "name"), expression])).toStrictEqual([
      "  table column public.users.name, which it retypes:",
      "    rule copy on public.log",
    ]);
  });

  it("stops a drop's walk at a column the plan retypes, but not at a view's own column", async () => {
    await db.driver.execute(`
      create type public.mood as enum ('a', 'b');
      create table public.t (m public.mood);
      create function public.noop() returns trigger language plpgsql as 'begin return new; end';
      create trigger tr before update of m on public.t for each row execute function public.noop();
      create view public.moods as select m, m as again from public.t;`);

    expect(
      await blockerLines([
        { walk: "drop", object: { type: "type", names: [`"public"."mood"`], args: [] } },
        { walk: "retype", object: { type: "table column", names: ["public", "t", "m"], args: [] } },
      ]),
    ).toStrictEqual([
      "  type public.mood, which it drops:",
      "    view public.moods",
      "  table column public.t.m, which it retypes:",
      "    trigger tr on public.t",
      "    view public.moods",
    ]);
  });

  it("leaves out a retype's dependent that a planned drop removes", async () => {
    expect(
      await blockerLines([column("retype", "name"), column("drop", "upper_name"), table("log")]),
    ).toStrictEqual([]);
  });

  it("leaves out a dependent of one drop that another drop removes", async () => {
    expect(await blockerLines([table("users")])).toStrictEqual([
      "  table public.users, which it drops:",
      "    rule copy on public.log",
      "    table constraint orders_user_id_fkey on public.orders",
    ]);
    expect(await blockerLines([table("users"), table("orders"), table("log")])).toStrictEqual([]);
  });

  it("names an Unmodeled table once, not each column its identity reaches", async () => {
    await db.driver.execute(`
      create schema extra;
      create table extra.parts (id integer generated always as identity) partition by range (id);`);

    expect(
      await blockerLines([
        { walk: "drop", object: { type: "schema", names: ["extra"], args: [] } },
      ]),
    ).toStrictEqual(["  schema extra, which it drops:", "    table extra.parts"]);
  });

  it("returns nothing without scans", async () => {
    expect(await unmodeledBlockers(db.driver, [])).toBeUndefined();
  });
});
