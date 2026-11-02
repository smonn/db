import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { deleteFrom } from "./delete.ts";
import type { Expr } from "./expr.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import { and, not, or, type Predicate } from "./refs.ts";
import { sql } from "./sql.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().notNull(),
      email: c.text().notNull().name("E-mail"),
      name: c.text(),
      born: c
        .integer()
        .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` }),
    })),
  },
});
const { users } = db.public;

beforeEach(async () => {
  await testDatabase.driver.execute(
    [
      "drop table if exists public.users",
      `create table public.users (id integer not null, "E-mail" text not null, name text, born integer)`,
      `insert into public.users values
        (1, 'Ann@Example.com', 'Ann', 5),
        (2, 'bo@example.com', null, 7),
        (3, 'CY@example.org', 'Cy', null)`,
    ].join("; "),
  );
});

const lowered = (email: unknown) => sql.expr<string>`lower(${email})`;

const ids = async (query: ReturnType<typeof from<typeof users>>): Promise<number[]> =>
  (await client.all(query.pick("id").orderBy((u) => u.id))).map((row) => row.id);

describe("sql.expr", () => {
  it("renders a ref as its quoted column and binds every other value", () => {
    const query = from(users).where((u) => sql.expr`lower(${u.email}) = ${"bo@example.com"}`);
    expect(query.toSql()).toStrictEqual({
      text: 'select "id", "E-mail" as "email", "name", "born" from "public"."users" where lower("E-mail") = $1',
      params: ["bo@example.com"],
    });
  });

  it("inlines an Expr or predicate in parentheses, numbering params in order", () => {
    const query = from(users).where(
      (u) => sql.expr`${lowered(sql.expr`${u.email}`)} like ${"%.com"} and ${u.id.gt(1)}`,
    );
    const { text, params } = query.toSql();
    expect(text).toMatch(/ where \(lower\(\("E-mail"\)\)\) like \$1 and \("id" > \$2\)$/u);
    expect(params).toStrictEqual(["%.com", 1]);
  });

  it("is an Expr of its type argument, unknown without one", () => {
    expectTypeOf(sql.expr<string>`'a'`).toEqualTypeOf<Expr<string>>();
    expectTypeOf(sql.expr`'a'`).toEqualTypeOf<Expr>();
  });

  it("refuses a statement or an unfinished one, also inside an array", () => {
    expect(() => sql.expr`(${sql`select 1`})`).toThrow(
      "sql.expr takes values, not statements: value 1 is a statement",
    );
    expect(() => sql.expr`${1} in (${from(users).pick("id")})`).toThrow(
      "sql.expr takes values, not statements: value 2 is a statement",
    );
    expect(() => sql.expr`${deleteFrom(users)}`).toThrow(
      "sql.expr takes values, not statements: value 1 is an unfinished statement",
    );
    expect(() => sql.expr`${insert(users)}`).toThrow(
      "sql.expr takes values, not statements: value 1 is an unfinished statement",
    );
    expect(() => sql.expr`${[deleteFrom(users).allRows()]}`).toThrow(
      "sql.expr takes values, not statements: value 1 contains a statement",
    );
  });
});

const named = (u: { name: unknown }) => sql.expr<boolean | null>`${u.name} like ${"A%"}`;

describe("an Expr in where", () => {
  it("filters on Postgres, and repeated calls combine with and", async () => {
    const query = from(users)
      .where((u) => sql.expr`lower(${u.email}) like ${"%example.com"}`)
      .where((u) => sql.expr`${u.id} <> ${2}`);
    expect(await ids(query)).toStrictEqual([1]);
  });

  it("takes a boolean | null Expr in where, and, or, and not", async () => {
    expect(await ids(from(users).where(named))).toStrictEqual([1]);
    expect(await ids(from(users).where((u) => not(named(u))))).toStrictEqual([3]);
    expect(await ids(from(users).where((u) => and(named(u), u.id.eq(1))))).toStrictEqual([1]);
    expect(await ids(from(users).where((u) => or(named(u), u.id.eq(2))))).toStrictEqual([1, 2]);
  });

  it("wraps a hand-written term of and or or, so its own or binds first", async () => {
    const query = from(users).where((u) =>
      and(sql.expr`${u.id} = ${1} or ${u.id} = ${3}`, u.name.eq("Cy")),
    );
    expect(query.toSql().text).toMatch(
      / where \(\("id" = \$1 or "id" = \$2\) and "name" = \$3\)$/u,
    );
    expect(await ids(query)).toStrictEqual([3]);
  });

  it("filters a delete", async () => {
    const deleted = deleteFrom(users)
      .where((u) => sql.expr`${u.born} > ${6}`)
      .returning((u) => ({ id: u.id }));
    expect(await client.all(deleted)).toStrictEqual([{ id: 2 }]);
  });

  it("types Predicate as Expr<boolean>, and infers an untyped Expr's type from where", () => {
    expectTypeOf<Predicate>().toEqualTypeOf<Expr<boolean>>();
    expectTypeOf(and).returns.toEqualTypeOf<Predicate>();
    from(users).where((u) => {
      const filter = sql.expr`${u.id} > 1`;
      expectTypeOf(filter).toEqualTypeOf<Expr>();
      return sql.expr`${u.id} > 1`;
    });
  });
});

describe("an Expr in select and returning", () => {
  it("selects beside refs under its key, with no codec", async () => {
    const query = from(users)
      .select((u) => ({
        id: u.id,
        born: u.born,
        rawBorn: sql.expr<number | null>`${u.born}`,
        mail: sql.expr<string>`lower(${u.email})`,
      }))
      .orderBy((u) => u.id)
      .limit(1);
    expect(query.toSql().text).toBe(
      'select "id", "born", "born" as "rawBorn", lower("E-mail") as "mail" from "public"."users" order by "users"."id" limit $1',
    );
    const rows = await client.all(query);
    expectTypeOf(rows).toEqualTypeOf<
      { id: number; born: string | null; rawBorn: number | null; mail: string }[]
    >();
    expect(rows).toStrictEqual([{ id: 1, born: "#5", rawBorn: 5, mail: "ann@example.com" }]);
  });

  it("does not decode an Expr whose key names a codec column", async () => {
    const query = from(users)
      .select((u) => ({ born: sql.expr<number>`${u.born} + ${1}` }))
      .where((u) => u.id.eq(1));
    expect(await client.one(query)).toStrictEqual({ born: 6 });
  });

  it("returns an Expr from insert and delete", async () => {
    const inserted = insert(users)
      .values({ id: 4, email: "Di@example.com" })
      .returning((u) => ({ id: u.id, mail: sql.expr<string>`lower(${u.email})` }));
    expect(await client.one(inserted)).toStrictEqual({ id: 4, mail: "di@example.com" });
    const deleted = deleteFrom(users)
      .where((u) => u.id.eq(4))
      .returning((u) => ({ upper: sql.expr<string>`upper(${u.email})` }));
    expect(await client.one(deleted)).toStrictEqual({ upper: "DI@EXAMPLE.COM" });
  });

  it("types an untyped Expr's value as unknown", async () => {
    const rows = await client.all(from(users).select(() => ({ one: sql.expr`1` })));
    expectTypeOf(rows).toEqualTypeOf<{ one: unknown }[]>();
    expect(rows).toStrictEqual([{ one: 1 }, { one: 1 }, { one: 1 }]);
  });
});

describe("an Expr in orderBy", () => {
  it("sorts bare, or by asc or desc with nulls placed", async () => {
    expect(await ids(from(users).orderBy((u) => lowered(u.email)))).toStrictEqual([1, 2, 3]);
    const byLower = from(users)
      .pick("id")
      .orderBy((u) => lowered(u.email).desc());
    expect(byLower.toSql().text).toBe(
      'select "id" from "public"."users" order by lower("E-mail") desc',
    );
    expect((await client.all(byLower)).map((row) => row.id)).toStrictEqual([3, 2, 1]);
    const byName = from(users)
      .pick("id")
      .orderBy((u) => [sql.expr<string | null>`upper(${u.name})`.asc({ nulls: "first" }), u.id]);
    expect(byName.toSql().text).toBe(
      'select "id" from "public"."users" order by upper("name") asc nulls first, "users"."id"',
    );
    expect((await client.all(byName)).map((row) => row.id)).toStrictEqual([2, 1, 3]);
  });

  it("sorts by a predicate, false first", async () => {
    const query = from(users)
      .pick("id")
      .orderBy((u) => [u.name.isNull(), u.id.desc()]);
    expect(query.toSql().text).toBe(
      'select "id" from "public"."users" order by "name" is null, "users"."id" desc',
    );
    expect((await client.all(query)).map((row) => row.id)).toStrictEqual([3, 1, 2]);
  });

  it("offers nulls only when the Expr's type includes null", () => {
    type Options<V> = NonNullable<Parameters<Expr<V>["desc"]>[0]>;
    type Nulls = "first" | "last" | undefined;
    expectTypeOf<Options<string | null>["nulls"]>().toEqualTypeOf<Nulls>();
    expectTypeOf<Options<unknown>["nulls"]>().toEqualTypeOf<Nulls>();
    expectTypeOf<Options<string>>().toEqualTypeOf<{
      readonly "nulls needs a nullable column"?: never;
    }>();
  });
});

describe("an Expr in values", () => {
  it("inserts an Expr in place of a value, with no codec", async () => {
    await client.run(
      insert(users).values({
        id: 4,
        email: sql.expr`lower(${"DI@Example.com"})`,
        born: sql.expr`${9}`,
      }),
    );
    await client.run(
      insert(users).valuesMany([
        { id: 5, email: "e@example.com", name: sql.expr`upper(${"eve"})` },
        { id: sql.expr`${2} * 3`, email: "f@example.com" },
      ]),
    );
    const rows = await client.all(
      from(users)
        .where((u) => u.id.gt(3))
        .select((u) => ({ id: u.id, email: u.email, name: u.name, born: sql.expr`${u.born}` }))
        .orderBy((u) => u.id),
    );
    expect(rows).toStrictEqual([
      { id: 4, email: "di@example.com", name: null, born: 9 },
      { id: 5, email: "e@example.com", name: "EVE", born: null },
      { id: 6, email: "f@example.com", name: null, born: null },
    ]);
  });

  it("renders the Expr inline and binds its values", () => {
    expect(
      insert(users)
        .values({ id: sql.expr`${7} + 1`, email: "a" })
        .toSql(),
    ).toStrictEqual({
      text: 'insert into "public"."users" ("id", "E-mail") values ($1 + 1, $2)',
      params: [7, "a"],
    });
  });
});
