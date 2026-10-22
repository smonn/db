import { describe, expect, it } from "vitest";
import { useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

describe("postgresJsTypes timestamps", () => {
  it("reads BC and five-digit years as Dates", async () => {
    const { rows } = await db.driver.query(`
      select '0044-03-15 12:00:00.5 BC'::timestamp as bc,
        '10000-01-01 00:00:00'::timestamp as far,
        '0044-03-15 12:00:00.5+00 BC'::timestamptz as bctz,
        '10000-01-01 00:00:00+00'::timestamptz as fartz
    `);
    expect(rows).toStrictEqual([
      {
        bc: new Date("-000043-03-15T12:00:00.500Z"),
        far: new Date("+010000-01-01T00:00:00Z"),
        bctz: new Date("-000043-03-15T12:00:00.500Z"),
        fartz: new Date("+010000-01-01T00:00:00Z"),
      },
    ]);
  });

  it("reads a timestamptz whose zone offset has seconds", async () => {
    const rows = await db.driver.transaction(async (tx) => {
      await tx.execute("set local time zone 'Asia/Tokyo'");
      return (await tx.query("select '1850-01-01 00:00:00+00'::timestamptz as lmt")).rows;
    });
    expect(rows).toStrictEqual([{ lmt: new Date("1850-01-01T00:00:00Z") }]);
  });

  it("writes BC and five-digit-year Dates back unchanged", async () => {
    await db.driver.execute("create table extremes (n int, ts timestamp, tz timestamptz)");
    const bc = new Date("-000043-03-15T12:00:00.500Z");
    const far = new Date("+010000-01-01T00:00:00Z");
    await db.driver.query("insert into extremes values (1, $1, $1), (2, $2, $2)", [bc, far]);
    const { rows } = await db.driver.query("select ts, tz from extremes order by n");
    expect(rows).toStrictEqual([
      { ts: bc, tz: bc },
      { ts: far, tz: far },
    ]);
  });

  it("writes a string param to a timestamptz as postgres.js reads it into a Date", async () => {
    const { rows } = await db.driver.query("select $1::timestamptz as tz", [
      "2024-02-29T12:34:56.789Z",
    ]);
    expect(rows).toStrictEqual([{ tz: new Date("2024-02-29T12:34:56.789Z") }]);
  });

  it.each([
    ["'infinity'::timestamp", "infinity"],
    ["'-infinity'::timestamp", "-infinity"],
    ["'infinity'::timestamptz", "infinity"],
    ["'294276-12-31 23:59:59'::timestamp", "294276-12-31 23:59:59"],
  ])("refuses to read %s, naming the value", async (literal, text) => {
    await expect(db.driver.query(`select ${literal} as t`)).rejects.toThrow(
      `Can't read timestamp "${text}" as a Date`,
    );
  });
});

describe("postgresJsTypes in a session that changes the output style", () => {
  it.each([
    [
      "datestyle = 'SQL, DMY'",
      "'2024-03-04 05:06:07'::timestamp",
      'timestamp "04/03/2024 05:06:07" as a Date',
    ],
    ["datestyle = 'SQL, DMY'", "'2024-03-04'::date", 'date "04/03/2024" as YYYY-MM-DD'],
    ["bytea_output = 'escape'", "'\\x0102ff'::bytea", String.raw`bytea "\001\002\377" as hex`],
  ])("with %s, refuses to read %s, naming the value", async (setting, literal, message) => {
    const read = db.driver.transaction(async (tx) => {
      await tx.execute(`set local ${setting}`);
      await tx.query(`select ${literal} as v`);
    });
    await expect(read).rejects.toThrow(`Can't read ${message}`);
  });
});

describe("postgresJsTypes dates", () => {
  it("reads BC and infinite dates as Postgres writes them", async () => {
    const { rows } = await db.driver.query(
      "select '0044-03-15 BC'::date as bc, 'infinity'::date as inf, '10000-01-01'::date as far",
    );
    expect(rows).toStrictEqual([{ bc: "0044-03-15 BC", inf: "infinity", far: "10000-01-01" }]);
  });
});
