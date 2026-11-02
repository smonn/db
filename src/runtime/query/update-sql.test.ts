import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { not } from "./refs.ts";
import { sql } from "./sql.ts";
import { update } from "./update.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity("always").primaryKey(),
      email: c.text().notNull(),
      name: c.text(),
      n: c.integer().notNull(),
      tags: c.text().array().notNull(),
      born: c
        .integer()
        .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` }),
    })),
  },
});
const { users } = db.public;

/** A plain-JS caller can pass what TypeScript rejects, such as an undefined value or an unknown key. */
const looseSet = (values: Record<string, unknown>) => update(users).set(values);

describe("update renders", () => {
  it("renders each value as a bound param, then where", () => {
    expect(
      update(users)
        .set({ email: "x@example.com", name: null })
        .where((u) => u.id.eq(1))
        .toSql(),
    ).toStrictEqual({
      text: 'update "public"."users" set "email" = $1, "name" = $2 where "id" = $3',
      params: ["x@example.com", null, 1],
    });
  });

  it("renders allRows with no where", () => {
    expect(update(users).set({ n: 0 }).allRows().toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = $1',
      params: [0],
    });
  });

  it("combines repeated where calls with and", () => {
    const statement = update(users)
      .set({ n: 0 })
      .where((u) => u.email.like("%@example.com"))
      .where((u) => u.id.gt(1));
    expect(statement.toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = $1 where ("email" like $2 and "id" > $3)',
      params: [0, "%@example.com", 1],
    });
  });

  it("takes the predicates from selects: not, in, includes, null checks", () => {
    const { text } = update(users)
      .set({ n: 0 })
      .where((u) => not(u.id.in([1])))
      .where((u) => u.tags.includes("a"))
      .where((u) => u.name.isNull())
      .toSql();
    expect(text).toBe(
      'update "public"."users" set "n" = $1 where ((not ("id" = any($2)) and $3 = any("tags")) and "name" is null)',
    );
  });

  it("encodes a set value and a compared value through the column's codec", () => {
    expect(
      update(users)
        .set({ born: "#9" })
        .where((u) => u.born.eq("#5"))
        .toSql().params,
    ).toStrictEqual([9, 5]);
  });

  it("inlines an Expr value with no codec", () => {
    const statement = update(users)
      .set({ n: sql.expr<number>`1 + 1`, born: sql.expr<string | null>`7` })
      .allRows();
    expect(statement.toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = 1 + 1, "born" = 7',
      params: [],
    });
  });

  it("calls a value's callback with the columns", () => {
    const statement = update(users)
      .set({ n: (u) => sql.expr<number>`${u.n} + ${1}` })
      .allRows();
    expect(statement.toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = "n" + $1',
      params: [1],
    });
  });

  it("skips an undefined value", () => {
    const statement = looseSet({ email: undefined, n: 5, name: undefined }).allRows();
    expect(statement.toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = $1',
      params: [5],
    });
  });

  it("sets columns in the order the keys are given", () => {
    expect(update(users).set({ n: 1, email: "a" }).allRows().toSql().text).toBe(
      'update "public"."users" set "n" = $1, "email" = $2',
    );
  });

  it("refuses a set with no column to set", () => {
    expect(() => update(users).set({})).toThrow("update needs at least one column to set");
    expect(() => looseSet({ n: undefined })).toThrow("update needs at least one column to set");
  });

  it("refuses a key that is no column, the message key of an identity always column too", () => {
    expect(() => looseSet({ nope: 1 })).toThrow('"nope" is not a column of "public"."users"');
    const key = "id is generated always, so update can't set it";
    expect(() => looseSet({ [key]: 5 })).toThrow(`"${key}" is not a column of "public"."users"`);
  });

  it("appends returning to a filtered update, named by key", () => {
    const statement = update(users)
      .set({ n: 4 })
      .where((u) => u.id.eq(1))
      .returning((u) => ({ key: u.id, mail: u.email }));
    expect(statement.toSql()).toStrictEqual({
      text: 'update "public"."users" set "n" = $1 where "id" = $2 returning "id" as "key", "email" as "mail"',
      params: [4, 1],
    });
  });

  it("appends returning to allRows", () => {
    expect(
      update(users)
        .set({ n: 4 })
        .allRows()
        .returning((u) => ({ id: u.id }))
        .toSql().text,
    ).toBe('update "public"."users" set "n" = $1 returning "id"');
  });

  it("refuses returning with no column", () => {
    expect(() =>
      update(users)
        .set({ n: 4 })
        .allRows()
        .returning(() => ({})),
    ).toThrow("returning needs at least one column");
  });

  it("is refused inside sql at each unfinished step", () => {
    expect(() => sql`select ${update(users)}`).toThrow(
      "sql takes values, not statements: value 1 is an unfinished statement",
    );
    expect(() => sql`select ${update(users).set({ n: 0 })}`).toThrow(
      "sql takes values, not statements: value 1 is an unfinished statement",
    );
    expect(() => sql`select ${update(users).set({ n: 0 }).allRows()}`).toThrow(
      "sql takes values, not statements: value 1 is a statement",
    );
  });

  it("throws naming defineDatabase for a table it never named", () => {
    const bare: unknown = defineTable((c) => ({ id: c.text().notNull() }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
    const call = () => update(bare as typeof users);
    expect(call).toThrow(/lacks SQL names.*defineDatabase/u);
  });
});
