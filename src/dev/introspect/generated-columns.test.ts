import { beforeEach, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { namesOf } from "../catalog/index.ts";
import { introspect } from "./introspect.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public;");
});

it("reads a generation expression and its storage as a fact under its column", async () => {
  await db.driver.execute(`
    create table t (
      n integer,
      plain integer,
      doubled integer generated always as (n * 2) stored,
      tripled integer generated always as (n * 3) virtual,
      implicit integer generated always as (n + 1)
    )`);

  const catalog = await introspect(db.driver);

  const facts = [...catalog.values()]
    .filter((fact) => ["default", "generated"].includes(fact.kind))
    .map((fact) => [namesOf(catalog, fact).join("."), fact.payload]);
  expect(facts).toStrictEqual([
    ["public.t.doubled.generated", { expression: "(n * 2)", storage: "stored" }],
    ["public.t.tripled.generated", { expression: "(n * 3)", storage: "virtual" }],
    ["public.t.implicit.generated", { expression: "(n + 1)", storage: "virtual" }],
  ]);
});
