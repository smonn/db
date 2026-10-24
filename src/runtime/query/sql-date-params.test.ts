import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { createClient, sql } from "./index.ts";

const testDatabase = useTestDatabase();

const at = new Date("2026-01-01T00:00:00Z");

beforeEach(async () => {
  await testDatabase.driver.execute(`
    drop table if exists stamps;
    create table stamps (id int primary key, ts timestamp, tz timestamptz);
    insert into stamps values (1, '2026-01-01 00:00:00', '2026-01-01 00:00:00+00');
  `);
});

describe("sql with Date params", () => {
  it("binds an array of Dates as an array, whatever the session zone", async () => {
    const rows = await testDatabase.driver.session(async (session) => {
      await session.execute("set time zone 'Asia/Tokyo'");
      return createClient(session).all(
        sql<{ id: number }>`select id from stamps where ts = any(${[at]}) and tz = any(${[at]})`,
      );
    });
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("needs a cast where nothing names the type of a Date", async () => {
    const client = createClient(testDatabase.driver);
    await expect(
      client.all(sql<{ t: Date }>`select ${at} - interval '1 hour' as t`),
    ).rejects.toThrow("invalid input syntax for type interval");
    const rows = await client.all(
      sql<{ t: Date }>`select ${at}::timestamptz - interval '1 hour' as t`,
    );
    expect(rows).toStrictEqual([{ t: new Date("2025-12-31T23:00:00Z") }]);
  });
});
