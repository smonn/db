import { beforeEach, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { namesOf } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public;");
});

// pg_depend leaves out built-in functions, so volatility comes from the function's name.
it("marks a default that calls a volatile function", async () => {
  await db.driver.execute(`
    create sequence seq;
    create function stable_one() returns integer language sql stable as 'select 1';
    create function volatile_one() returns integer language sql volatile as 'select 1';
    create table t (
      a double precision default random(),
      b uuid default gen_random_uuid(),
      c bigint default nextval('seq'),
      d text default random()::text,
      e integer default volatile_one(),
      f integer default stable_one(),
      g timestamptz default now(),
      h timestamptz default clock_timestamp(),
      i integer default 7,
      j text default 'random()'
    )`);

  const catalog = await introspect(db.driver);

  const volatile = [...catalog.values()]
    .filter((fact) => fact.kind === "default")
    .map((fact) => [namesOf(catalog, fact)[2], fact.payload.volatile]);
  expect(volatile).toStrictEqual([
    ["a", true],
    ["b", true],
    ["c", true],
    ["d", true],
    ["e", true],
    ["f", false],
    ["g", false],
    ["h", true],
    ["i", false],
    ["j", false],
  ]);
});
