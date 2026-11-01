import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { defineDatabase, defineDomain, defineTable } from "../definition/index.ts";
import { createClient, from, insert } from "./index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const domains = {
  domjsonb: defineDomain((c) => c.jsonb()),
};
const t = defineTable((c) => ({
  id: c.integer().notNull(),
  b: c.domain(domains.domjsonb),
}));
const db = defineDatabase({ public: { ...domains, t } });

const setup = [
  "drop table if exists public.t",
  "drop domain if exists public.domjsonb",
  "create domain public.domjsonb as jsonb",
  "create table public.t (id integer not null, b public.domjsonb)",
].join("; ");

beforeAll(async () => {
  // Created once: the connection has not met these types, and postgres.js caches prepared statements.
  await testDatabase.driver.execute(setup);
});

beforeEach(async () => {
  await testDatabase.driver.execute("truncate public.t");
});

const values: [string, unknown][] = [
  ["an object", { a: 1, nested: [true, null, "x"] }],
  ["an array", [1, "two", null]],
  ["a string", "text"],
  ["a number", 42],
  ["a boolean", false],
];

describe("domains over jsonb", () => {
  it.each(values)("round-trips %s through insert and a select", async (_name, value) => {
    await client.run(insert(db.public.t).values({ id: 1, b: value }));

    const rows = await client.all(from(db.public.t));

    expect(rows).toStrictEqual([{ id: 1, b: value }]);
  });

  it("inserts several rows at once, and a NULL", async () => {
    await client.run(
      insert(db.public.t).values([
        { id: 1, b: { a: 1 } },
        { id: 2, b: "two" },
        { id: 3, b: null },
      ]),
    );

    const rows = await client.all(from(db.public.t));

    expect(rows).toStrictEqual([
      { id: 1, b: { a: 1 } },
      { id: 2, b: "two" },
      { id: 3, b: null },
    ]);
  });

  it("matches a jsonb domain column with eq", async () => {
    await client.run(
      insert(db.public.t).values([
        { id: 1, b: { a: 1 } },
        { id: 2, b: { a: 2 } },
      ]),
    );

    const rows = await client.all(
      from(db.public.t)
        .select((r) => ({ id: r.id }))
        .where((r) => r.b.eq({ a: 2 })),
    );

    expect(rows).toStrictEqual([{ id: 2 }]);
  });

  it("returns the inserted value from returning", async () => {
    const rows = await client.all(
      insert(db.public.t)
        .values({ id: 1, b: { a: 1 } })
        .returning((r) => ({ b: r.b })),
    );

    expect(rows).toStrictEqual([{ b: { a: 1 } }]);
  });
});
