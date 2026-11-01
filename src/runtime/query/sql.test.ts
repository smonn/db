import { describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { deleteFrom } from "./delete.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import type { Query, Statement } from "./statement.ts";
import { sql } from "./sql.ts";

describe("sql", () => {
  it("binds each value to a numbered placeholder", () => {
    expect(sql`select ${1}::int, ${"a"}`.toSql()).toStrictEqual({
      text: "select $1::int, $2",
      params: [1, "a"],
    });
  });

  it("is a Query of the row type it is given", () => {
    expectTypeOf(sql<{ id: string }>`select id from t`).toEqualTypeOf<Query<{ id: string }>>();
  });

  it("is a Statement, not a Query, without a row type", () => {
    expectTypeOf(sql`delete from t`).toEqualTypeOf<Statement>();
    expectTypeOf(sql`delete from t`).not.toExtend<Query<unknown>>();
  });

  it("rejects a statement interpolated into another", () => {
    const users = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text().notNull() })) },
    });
    expect(() => sql`select * from (${sql`select 1`}) as one`).toThrow(
      "sql takes values, not statements: value 1 is a statement",
    );
    expect(() => sql`select ${1}, (${from(users.public.users)})`).toThrow(
      "sql takes values, not statements: value 2 is a statement",
    );
  });

  it("rejects an unfinished statement by name, not as a statement", () => {
    const { users } = defineDatabase({
      public: { users: defineTable((c) => ({ id: c.text().notNull() })) },
    }).public;
    expect(() => sql`select ${deleteFrom(users)}`).toThrow(
      "sql takes values, not statements: value 1 is an unfinished statement",
    );
    expect(() => sql`select ${1}, ${insert(users)}`).toThrow(
      "sql takes values, not statements: value 2 is an unfinished statement",
    );
  });

  it("rejects a statement inside an array value", () => {
    expect(() => sql`select ${[1, sql`select 2`]}`).toThrow(
      "sql takes values, not statements: value 1 contains a statement",
    );
    expect(() => sql`select ${[[sql`select 3`]]}`).toThrow(
      "sql takes values, not statements: value 1 contains a statement",
    );
    expect(sql`select ${[1, 2]}`.toSql()).toStrictEqual({ text: "select $1", params: [[1, 2]] });
  });
});
