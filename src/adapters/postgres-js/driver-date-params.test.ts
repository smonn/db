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
      // Text, since postgres.js hands the timestamp parser a NULL element as the string "NULL".
      return (
        await session.query(
          "select id, tss::text as tss, tzs::text as tzs from stamps where id > 1 order by id",
        )
      ).rows;
    });
    expect(rows).toStrictEqual([
      {
        id: 2,
        tss: '{"2026-01-01 00:00:00",NULL}',
        tzs: '{"2026-01-01 09:00:00+09","2026-01-01 09:00:00+09"}',
      },
      { id: 3, tss: '{{"2026-01-01 00:00:00"},{"2026-01-01 00:00:00"}}', tzs: null },
    ]);
  });

  it("reads an empty and a non-Date array as postgres.js does", async () => {
    const { rows } = await db.driver.query("select $1::int[] as a, $2::text[] as b", [
      [],
      ["x", "y"],
    ]);
    expect(rows).toStrictEqual([{ a: [], b: ["x", "y"] }]);
  });

  it("names the param when an array mixes Dates with other values", async () => {
    await expect(db.driver.query("select $1::text[]", [[at, "x"]])).rejects.toThrow(
      "Param $1 mixes Dates with other values in an array",
    );
  });
});
