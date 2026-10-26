import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";
import { table } from "./column-attributes.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

const int = { type: "integer" };
const stored = (expression: string) => ({ expression, storage: "stored" }) as const;
const virtual = (expression: string) => ({ expression, storage: "virtual" }) as const;

describe("generated columns against Postgres", () => {
  it("creates a table and adds columns with expressions, leaving no remaining diff", async () => {
    await db.driver.execute("create table t (a integer)");
    const wanted = table({
      a: int,
      s: { ...int, generated: stored("(a * 2)") },
      v: { ...int, generated: virtual("(a * 3)") },
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
    expect(diff(await introspect(db.driver), wanted)).toBe("");
  });

  it("changes and drops expressions in place, keeping the stored values", async () => {
    await db.driver.execute(`
      create table t (
        a integer,
        s integer generated always as (a * 2) stored,
        v integer generated always as (a * 2) virtual,
        d integer generated always as (a * 2) stored
      );
      insert into t (a) values (1), (2);`);
    const wanted = table({
      a: int,
      s: { ...int, generated: stored("(a * 3)") },
      v: { ...int, generated: virtual("(a * 3)") },
      d: int,
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
    const { rows } = await db.driver.query("select s, v, d from t order by a");
    expect(rows).toStrictEqual([
      { s: 3, v: 3, d: 2 },
      { s: 6, v: 6, d: 4 },
    ]);
  });

  it("rebuilds the columns Postgres can't alter, restoring their keys", async () => {
    await db.driver.execute(`
      create table t (
        a integer primary key,
        p integer unique,
        v integer generated always as (a * 2) virtual,
        w integer generated always as (a * 2) stored,
        x integer
      )`);
    const builder = catalogBuilder();
    builder.schema("public");
    builder.table("public", "t");
    builder.column("public", "t", "a", { type: "integer", notNull: true });
    for (const column of ["p", "v", "w", "x"]) {
      builder.column("public", "t", column, { type: "integer", notNull: false });
    }
    builder.columnGenerated("public", "t", "p", stored("(a + 1)"));
    builder.columnGenerated("public", "t", "w", virtual("(a * 2)"));
    builder.columnGenerated("public", "t", "x", virtual("(a * 5)"));
    builder.primaryKey("public", "t", "t_pkey", { columns: ["a"] });
    builder.unique("public", "t", "t_p_key", { columns: ["p"], nullsNotDistinct: false });
    const wanted = builder.build();

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const after = await introspect(db.driver);
    expect(after).toStrictEqual(wanted);
    expect(diff(after, wanted)).toBe("");
  });
});
