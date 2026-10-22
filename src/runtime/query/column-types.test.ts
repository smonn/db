import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient, from } from "./index.ts";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const everything = defineTable((c) => ({
  id: c.integer().notNull(),
  text: c.text(),
  varchar: c.varchar(20),
  smallint: c.smallint(),
  integer: c.integer(),
  bigint: c.bigint(),
  numeric: c.numeric(),
  scaled: c.numeric(12, 3),
  real: c.real(),
  doublePrecision: c.doublePrecision(),
  boolean: c.boolean(),
  uuid: c.uuid(),
  date: c.date(),
  timestamp: c.timestamp(),
  timestamptz: c.timestamptz(),
  jsonb: c.jsonb<{ tags: string[]; nested: { n: number } }>(),
  bytea: c.bytea(),
}));
const db = defineDatabase({ public: { everything } });

const columnNames = Object.keys(everything.columns);
const createTable = `create table public.everything (${Object.entries(everything.columns)
  .map(([name, col]) => `"${name}" ${col.state.sqlType}${col.state.notNull ? " not null" : ""}`)
  .join(", ")})`;

const filled = {
  id: 1,
  text: "héllo",
  varchar: "short",
  smallint: -32768,
  integer: 2147483647,
  bigint: 9007199254740993n,
  numeric: "12345678901234567890.123456789",
  scaled: "1234.500",
  real: 1.5,
  doublePrecision: 0.1,
  boolean: true,
  uuid: "123e4567-e89b-12d3-a456-426614174000",
  date: "2024-02-29",
  timestamp: new Date("2024-02-29T12:34:56.789Z"),
  timestamptz: new Date("2024-02-29T12:34:56.789Z"),
  jsonb: { tags: ["a", "b"], nested: { n: 1 } },
  bytea: new Uint8Array([0, 1, 254, 255]),
};

async function insert(row: Record<string, unknown>): Promise<void> {
  const names = columnNames.map((name) => `"${name}"`).join(", ");
  const marks = columnNames.map((_, i) => `$${i + 1}`).join(", ");
  await testDatabase.driver.query(
    `insert into public.everything (${names}) values (${marks})`,
    columnNames.map((name) => row[name] ?? null),
  );
}

describe("every column type through the postgres-js driver", () => {
  it("round-trips a filled row as the Definition's value types", async () => {
    await testDatabase.driver.execute(createTable);
    await insert(filled);

    const rows = await client.all(from(db.public.everything));

    expect(rows).toStrictEqual([filled]);
    expectTypeOf(rows).toEqualTypeOf<
      {
        id: number;
        text: string | null;
        varchar: string | null;
        smallint: number | null;
        integer: number | null;
        bigint: bigint | null;
        numeric: string | null;
        scaled: string | null;
        real: number | null;
        doublePrecision: number | null;
        boolean: boolean | null;
        uuid: string | null;
        date: string | null;
        timestamp: Date | null;
        timestamptz: Date | null;
        jsonb: { tags: string[]; nested: { n: number } } | null;
        bytea: Uint8Array | null;
      }[]
    >();
  });

  it("reads a row of nulls", async () => {
    await testDatabase.driver.execute("delete from public.everything");
    await insert({ id: 2 });

    const rows = await client.all(from(db.public.everything));

    expect(rows).toStrictEqual([
      { ...Object.fromEntries(columnNames.map((name) => [name, null])), id: 2 },
    ]);
  });

  it("reads timestamps as UTC whatever the session time zone", async () => {
    await testDatabase.driver.execute("delete from public.everything");
    const [row] = await testDatabase.driver.session(async (session) => {
      await session.execute(`
        set time zone 'Asia/Tokyo';
        insert into public.everything (id, timestamp, timestamptz, date)
        values (3, '2024-03-01 00:00:00', '2024-03-01 00:00:00+00', '2024-03-01');
      `);
      return createClient(session).all(
        from(db.public.everything).select((e) => ({
          timestamp: e.timestamp,
          timestamptz: e.timestamptz,
          date: e.date,
        })),
      );
    });

    expect(row).toStrictEqual({
      timestamp: new Date("2024-03-01T00:00:00Z"),
      timestamptz: new Date("2024-03-01T00:00:00Z"),
      date: "2024-03-01",
    });
  });
});
