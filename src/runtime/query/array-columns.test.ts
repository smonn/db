import { beforeEach, describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient, from, insert, sql } from "./index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const arrays = defineTable((c) => ({
  id: c.integer().notNull(),
  text: c.text().array(),
  varchar: c.varchar(20).array(),
  smallint: c.smallint().array(),
  integer: c.integer().array(),
  bigint: c.bigint().array(),
  numeric: c.numeric().array(),
  real: c.real().array(),
  doublePrecision: c.doublePrecision().array(),
  boolean: c.boolean().array(),
  uuid: c.uuid().array(),
  date: c.date().array(),
  timestamp: c.timestamp().array(),
  timestamptz: c.timestamptz().array(),
  jsonb: c.jsonb<{ n: number } | string>().array(),
  bytea: c.bytea().array(),
}));
const db = defineDatabase({ public: { arrays } });

const arrayColumns = Object.entries(arrays.columns).filter(([name]) => name !== "id");
const columnNames = arrayColumns.map(([name]) => name);
const createTable = `create table public.arrays (id integer not null, ${arrayColumns
  .map(([name, column]) => `"${name}" ${column.state.sqlType}[]`)
  .join(", ")})`;

const at = new Date("2024-02-29T12:34:56.789Z");

// Each array holds a NULL element, and text that reads like NULL, a delimiter, or a quote.
const filled = {
  id: 1,
  text: ["NULL", null, 'a,"b"\\', ""],
  varchar: ["{x}", null],
  smallint: [-32768, null],
  integer: [2147483647, null],
  bigint: [9007199254740993n, null],
  numeric: ["12345678901234567890.123456789", null],
  real: [1.5, null],
  doublePrecision: [0.1, null],
  boolean: [true, false, null],
  uuid: ["123e4567-e89b-12d3-a456-426614174000", null],
  date: ["2024-02-29", null],
  timestamp: [at, null],
  timestamptz: [at, null],
  jsonb: [{ n: 1 }, null, "s"],
  bytea: [new Uint8Array([0, 1, 254, 255]), null],
};

const empty = { id: 2, ...Object.fromEntries(columnNames.map((name) => [name, []])) };

beforeEach(async () => {
  await testDatabase.driver.execute(`drop table if exists public.arrays; ${createTable}`);
});

describe("array columns through the query builder", () => {
  it("round-trips arrays of every type, with NULL elements, and empty arrays", async () => {
    await client.run(insert(db.public.arrays).values([filled, empty]));

    const rows = await client.all(from(db.public.arrays));

    expect(rows).toStrictEqual([filled, empty]);
  });

  it("sends an array value as array text that the server types from the column", () => {
    const { params } = insert(db.public.arrays)
      .values({ id: 1, bigint: [1n, null], timestamp: [at], jsonb: [{ n: 1 }, "s"] })
      .toSql();

    expect(params).toStrictEqual([
      1,
      '{"1",NULL}',
      '{"2024-02-29 12:34:56.789+00"}',
      String.raw`{"{\"n\":1}","\"s\""}`,
    ]);
  });

  it("compares an array column with an array", async () => {
    await client.run(insert(db.public.arrays).values([filled, empty]));

    const rows = await client.all(
      from(db.public.arrays)
        .select((a) => ({ id: a.id }))
        .where((a) => a.bigint.eq([9007199254740993n, null])),
    );

    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("names the column when an element can't be written", () => {
    expect(() =>
      insert(db.public.arrays)
        .values({ id: 1, timestamp: [new Date(Number.NaN)] })
        .toSql(),
    ).toThrow(`Can't write the array in column "timestamp" of "public"."arrays"`);
  });
});

describe("array values in a raw sql template", () => {
  it("reads built-in arrays parsed", async () => {
    await client.run(insert(db.public.arrays).values(filled));

    const rows = await client.all(
      sql<{ bigint: (bigint | null)[]; timestamp: (Date | null)[] }>`
        select bigint, timestamp from public.arrays
      `,
    );

    expect(rows).toStrictEqual([{ bigint: filled.bigint, timestamp: filled.timestamp }]);
  });

  it("binds an array where Postgres infers an array type", async () => {
    await client.run(insert(db.public.arrays).values([filled, empty]));

    const rows = await client.all(
      sql<{ id: number }>`select id from public.arrays where ${9007199254740993n} = any(bigint)
        and bigint = ${filled.bigint}`,
    );

    expect(rows).toStrictEqual([{ id: 1 }]);
  });
});
