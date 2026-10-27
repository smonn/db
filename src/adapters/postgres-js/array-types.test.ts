import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "./test-database.test-helper.ts";

const db = useTestDatabase();

const at = new Date("2026-01-01T00:00:00Z");

// One array of each type the Definition can declare, each with a NULL element.
const cases: readonly (readonly [type: string, literal: string, value: readonly unknown[]])[] = [
  ["text", `'{a,NULL,"NULL",""}'`, ["a", null, "NULL", ""]],
  ["varchar(5)", "'{a,NULL}'", ["a", null]],
  ["smallint", "'{-32768,NULL}'", [-32768, null]],
  ["integer", "'{1,NULL}'", [1, null]],
  ["bigint", "'{9007199254740993,NULL}'", [9007199254740993n, null]],
  ["numeric", "'{1.10,NULL}'", ["1.10", null]],
  ["real", "'{1.5,NULL}'", [1.5, null]],
  ["double precision", "'{0.25,NULL}'", [0.25, null]],
  ["boolean", "'{t,f,NULL}'", [true, false, null]],
  [
    "uuid",
    "'{00000000-0000-0000-0000-000000000001,NULL}'",
    ["00000000-0000-0000-0000-000000000001", null],
  ],
  ["date", "'{2026-01-01,NULL}'", ["2026-01-01", null]],
  ["timestamp", "'{2026-01-01 00:00:00,NULL}'", [at, null]],
  ["timestamptz", "'{2026-01-01 00:00:00+00,NULL}'", [at, null]],
  ["jsonb", `'{"{\\"a\\": [1]}",NULL,"\\"s\\""}'`, [{ a: [1] }, null, "s"]],
  ["bytea", String.raw`'{"\\x00ff",NULL}'`, [Uint8Array.of(0, 255), null]],
];

describe("postgresJsTypes arrays", () => {
  it.each(cases)("reads %s[] with a NULL element", async (type, literal, value) => {
    const { rows } = await db.driver.query(`select ${literal}::${type}[] as a`);
    expect(rows).toStrictEqual([{ a: value }]);
  });

  it.each(cases)("reads an empty %s[]", async (type) => {
    const { rows } = await db.driver.query(`select '{}'::${type}[] as a`);
    expect(rows).toStrictEqual([{ a: [] }]);
  });

  it.each(cases)("writes %s[] and reads it back", async (type, _, value) => {
    await db.driver.execute(`drop table if exists arrays; create table arrays (a ${type}[])`);
    // postgres.js caches a statement's param types by its text, so each type gets its own text.
    await db.driver.query(`insert into arrays values ($1), ($2) -- ${type}`, [value, []]);
    const { rows } = await db.driver.query("select a from arrays");
    expect(rows).toStrictEqual([{ a: value }, { a: [] }]);
  });

  it("reads catalog arrays, nested arrays, and box arrays", async () => {
    const { rows } = await db.driver.query(`
      select array['pg_class', null]::name[] as names, '{{1,2},{3,NULL}}'::int[] as nested,
        array[box '((1,1),(0,0))', box '((2,2),(1,1))'] as boxes
    `);
    expect(rows).toStrictEqual([
      {
        names: ["pg_class", null],
        nested: [
          [1, 2],
          [3, null],
        ],
        boxes: ["(1,1),(0,0)", "(2,2),(1,1)"],
      },
    ]);
  });
});

describe("postgresJsDriver array params", () => {
  beforeEach(async () => {
    await db.driver.execute(`
      drop table if exists docs;
      create table docs (id int, doc jsonb, tzs timestamptz[], ids bigint[]);
    `);
  });

  it("binds a bigint array where Postgres infers bigint[]", async () => {
    await db.driver.query("insert into docs (id, ids) values (1, $1)", [[1n, null]]);
    const { rows } = await db.driver.query("select id from docs where 1 = any($1)", [[1n, 2n]]);
    expect(rows).toStrictEqual([{ id: 1 }]);
  });

  it("sends a Date array to a jsonb param as JSON", async () => {
    await db.driver.query("insert into docs (id, doc) values (1, $1)", [[at, null]]);
    const { rows } = await db.driver.query("select doc from docs");
    expect(rows).toStrictEqual([{ doc: ["2026-01-01T00:00:00.000Z", null] }]);
  });

  it("sends an array that mixes Dates with timestamp text", async () => {
    await db.driver.query("insert into docs (id, tzs) values (1, $1)", [
      [at, "2026-01-02 00:00:00+00"],
    ]);
    const { rows } = await db.driver.query("select tzs from docs");
    expect(rows).toStrictEqual([{ tzs: [at, new Date("2026-01-02T00:00:00Z")] }]);
  });

  it("names the param that holds an Invalid Date", async () => {
    await expect(
      db.driver.query("insert into docs (id, tzs) values (1, $2)", [1, [at, new Date(Number.NaN)]]),
    ).rejects.toThrow("Param $2 holds an Invalid Date");
    await expect(db.driver.query("select $1::timestamptz", [new Date(Number.NaN)])).rejects.toThrow(
      "Param $1 holds an Invalid Date",
    );
  });
});
