import { beforeEach, describe, expect, it } from "vitest";
import type { Queryable } from "../../runtime/ports/index.ts";
import { useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

const at = new Date("2026-01-01T00:00:00Z");

beforeEach(async () => {
  await db.driver.execute(`
    drop table if exists stamps;
    create table stamps (
      id int primary key,
      ts timestamp,
      tz timestamptz,
      tss timestamp[],
      tzs timestamptz[]
    );
    insert into stamps values (
      1, '2026-01-01 00:00:00', '2026-01-01 00:00:00+00',
      array['2026-01-01 00:00:00']::timestamp[], array['2026-01-01 00:00:00+00']::timestamptz[]
    );
  `);
});

// The test database's own zone is UTC, where the misbinding doesn't show.
function inTokyo<T>(fn: (session: Queryable) => Promise<T>): Promise<T> {
  return db.driver.session(async (session) => {
    await session.execute("set time zone 'Asia/Tokyo'");
    return fn(session);
  });
}

function dayFrom(column: string, use: string): string {
  return `select id from stamps where ${column} >= ${use} and ${column} < ${use} + interval '1 day'`;
}

describe("postgresJsDriver Date params in hand-written SQL", () => {
  it("compares one Date param with a timestamp and a timestamptz in any session zone", async () => {
    const { rows } = await inTokyo((session) =>
      session.query("select id from stamps where ts >= $1 and tz <= $1", [at]),
    );
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("compares the timestamptz first, then the timestamp", async () => {
    const { rows } = await inTokyo((session) =>
      session.query("select id from stamps where tz <= $1 and ts >= $1", [at]),
    );
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("refuses interval arithmetic on a repeated Date param unless every use is cast", async () => {
    const refused = /operator does not exist: timestamp.* < interval/u;
    await expect(inTokyo((session) => session.query(dayFrom("ts", "$1"), [at]))).rejects.toThrow(
      refused,
    );
    await expect(inTokyo((session) => session.query(dayFrom("tz", "$1"), [at]))).rejects.toThrow(
      refused,
    );
    const { rows } = await inTokyo((session) =>
      session.query(dayFrom("tz", "$1::timestamptz"), [at]),
    );
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("matches a Date array with any()", async () => {
    const { rows } = await inTokyo((session) =>
      session.query("select id from stamps where ts = any($1) and tz = any($1)", [[at]]),
    );
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("compares a Date array with array columns", async () => {
    const { rows } = await inTokyo((session) =>
      session.query("select id from stamps where tss = $1 and tzs = $1", [[at]]),
    );
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("writes Date arrays, with nulls and nested arrays, to array columns", async () => {
    const rows = await inTokyo(async (session) => {
      await session.query("insert into stamps (id, tss, tzs) values (2, $1, $2)", [
        [at, null],
        [at, at],
      ]);
      await session.query("insert into stamps (id, tss) values (3, $1)", [[[at], [at]]]);
      return (await session.query("select id, tss, tzs from stamps where id > 1 order by id")).rows;
    });
    expect(rows).toStrictEqual([
      { id: 2, tss: [at, null], tzs: [at, at] },
      { id: 3, tss: [[at], [at]], tzs: null },
    ]);
  });

  it("reads an empty and a non-Date array", async () => {
    const { rows } = await db.driver.query("select $1::int[] as a, $2::text[] as b", [
      [],
      ["x", "y"],
    ]);
    expect(rows).toStrictEqual([{ a: [], b: ["x", "y"] }]);
  });

  it("writes a Date in a text array as UTC timestamp text", async () => {
    const { rows } = await db.driver.query("select $1::text[] as a", [[at, "x"]]);
    expect(rows).toStrictEqual([{ a: ["2026-01-01 00:00:00.000+00", "x"] }]);
  });
});
