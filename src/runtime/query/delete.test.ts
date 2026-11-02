import { beforeEach, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient, type Client } from "./client.ts";
import { deleteFrom } from "./delete.ts";
import { from } from "./from.ts";
import { not } from "./refs.ts";
import type { Many, Query, Statement } from "./statement.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().notNull(),
      email: c.text().notNull(),
      name: c.text(),
      tags: c.text().array().notNull(),
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
      `create table public.users (id integer not null, email text not null, name text, tags text[] not null, born integer)`,
      `insert into public.users values
        (1, 'ann@example.com', 'Ann', '{a}', 5),
        (2, 'bo@example.com', null, '{a,b}', 7),
        (3, 'cy@example.org', 'Cy', '{}', null)`,
    ].join("; "),
  );
});

const ids = async (): Promise<number[]> =>
  (
    await client.all(
      from(users)
        .pick("id")
        .orderBy((u) => u.id),
    )
  ).map((row) => row.id);

describe("deleteFrom", () => {
  it("renders where as a bound param", () => {
    expect(
      deleteFrom(users)
        .where((u) => u.id.eq(1))
        .toSql(),
    ).toStrictEqual({ text: 'delete from "public"."users" where "id" = $1', params: [1] });
  });

  it("renders allRows with no where", () => {
    expect(deleteFrom(users).allRows().toSql()).toStrictEqual({
      text: 'delete from "public"."users"',
      params: [],
    });
  });

  it("combines repeated where calls with and", () => {
    const statement = deleteFrom(users)
      .where((u) => u.email.like("%@example.com"))
      .where((u) => u.id.gt(1));
    expect(statement.toSql()).toStrictEqual({
      text: 'delete from "public"."users" where ("email" like $1 and "id" > $2)',
      params: ["%@example.com", 1],
    });
  });

  it("encodes a compared value through its column's codec", () => {
    expect(
      deleteFrom(users)
        .where((u) => u.born.eq("#5"))
        .toSql().params,
    ).toStrictEqual([5]);
  });

  it("takes the predicates from selects: not, in, includes, null checks", () => {
    const { text } = deleteFrom(users)
      .where((u) => not(u.id.in([1])))
      .where((u) => u.tags.includes("a"))
      .where((u) => u.name.isNull())
      .toSql();
    expect(text).toBe(
      'delete from "public"."users" where ((not ("id" = any($1)) and $2 = any("tags")) and "name" is null)',
    );
  });

  it("appends returning to a filtered delete, named by key", () => {
    const statement = deleteFrom(users)
      .where((u) => u.id.eq(1))
      .returning((u) => ({ key: u.id, mail: u.email }));
    expect(statement.toSql()).toStrictEqual({
      text: 'delete from "public"."users" where "id" = $1 returning "id" as "key", "email" as "mail"',
      params: [1],
    });
  });

  it("appends returning to allRows", () => {
    expect(
      deleteFrom(users)
        .allRows()
        .returning((u) => ({ id: u.id }))
        .toSql().text,
    ).toBe('delete from "public"."users" returning "id"');
  });

  it("refuses returning with no column", () => {
    expect(() =>
      deleteFrom(users)
        .allRows()
        .returning(() => ({})),
    ).toThrow("returning needs at least one column");
  });

  it("refuses to run before where or allRows, for a JavaScript caller", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A plain-JS caller passes it; TypeScript rejects it.
    const unfinished = deleteFrom(users) as unknown as Statement;
    await expect(client.run(unfinished)).rejects.toThrow(
      "deleteFrom needs where() or allRows() before it runs",
    );
    expect(await ids()).toStrictEqual([1, 2, 3]);
  });

  it("throws naming defineDatabase for a table it never named", () => {
    const bare: unknown = defineTable((c) => ({ id: c.text().notNull() }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
    const call = () => deleteFrom(bare as typeof users);
    expect(call).toThrow(/lacks SQL names.*defineDatabase/u);
  });
});

describe("deleteFrom on Postgres", () => {
  it("deletes the rows a where matches and reports the count", async () => {
    const result = await client.run(deleteFrom(users).where((u) => u.email.like("%@example.com")));
    expect(result).toStrictEqual({ count: 2 });
    expect(await ids()).toStrictEqual([3]);
  });

  it("deletes the rows every where call keeps", async () => {
    const result = await client.run(
      deleteFrom(users)
        .where((u) => u.email.like("%@example.com"))
        .where((u) => u.id.gt(1)),
    );
    expect(result).toStrictEqual({ count: 1 });
    expect(await ids()).toStrictEqual([1, 3]);
  });

  it("deletes every row with allRows", async () => {
    expect(await client.run(deleteFrom(users).allRows())).toStrictEqual({ count: 3 });
    expect(await ids()).toStrictEqual([]);
  });

  it("deletes no row when none match", async () => {
    const result = await client.run(deleteFrom(users).where((u) => u.id.eq(99)));
    expect(result).toStrictEqual({ count: 0 });
    expect(await ids()).toStrictEqual([1, 2, 3]);
  });

  it("returns the deleted rows through client.all, decoded by the column codecs", async () => {
    const rows = await client.all(
      deleteFrom(users)
        .where((u) => u.id.in([1, 2]))
        .returning((u) => ({ id: u.id, born: u.born, tags: u.tags })),
    );
    expect(rows.toSorted((a, b) => a.id - b.id)).toStrictEqual([
      { id: 1, born: "#5", tags: ["a"] },
      { id: 2, born: "#7", tags: ["a", "b"] },
    ]);
    expect(await ids()).toStrictEqual([3]);
  });

  it("returns the one deleted row through client.one", async () => {
    const row = await client.one(
      deleteFrom(users)
        .where((u) => u.id.eq(3))
        .returning((u) => ({ email: u.email })),
    );
    expect(row).toStrictEqual({ email: "cy@example.org" });
    expect(await ids()).toStrictEqual([1, 2]);
  });

  it("rejects client.one when the where matches no row", async () => {
    await expect(
      client.one(
        deleteFrom(users)
          .where((u) => u.id.eq(99))
          .returning((u) => ({ id: u.id })),
      ),
    ).rejects.toThrow("Expected one row but the query returned 0");
  });

  it("returns every row of allRows through client.all", async () => {
    const rows = await client.all(
      deleteFrom(users)
        .allRows()
        .returning((u) => ({ id: u.id })),
    );
    expect(rows).toHaveLength(3);
    expect(await ids()).toStrictEqual([]);
  });

  it("rejects a codec that throws when the statement renders", async () => {
    const throwing = defineDatabase({
      public: {
        users: defineTable((c) => ({
          id: c.integer().codec({
            encode: (): number => {
              throw new Error("no encode");
            },
            decode: (base) => base,
          }),
        })),
      },
    }).public.users;
    const statement = deleteFrom(throwing).where((u) => u.id.eq(1));
    await expect(client.run(statement)).rejects.toThrow(
      /codec of column "id".*threw while encoding/u,
    );
    expect(await ids()).toStrictEqual([1, 2, 3]);
  });
});

type RunArgument = Parameters<Client["run"]>[0];
type AllArgument = Parameters<Client["all"]>[0];
type OneArgument = Parameters<Client["one"]>[0];

describe("deleteFrom types", () => {
  it("is no Statement until where or allRows picks the rows", () => {
    const unfinished = deleteFrom(users);
    expectTypeOf(unfinished).not.toExtend<RunArgument>();
    expectTypeOf(unfinished).toHaveProperty("where");
    expectTypeOf(unfinished).toHaveProperty("allRows");
    expectTypeOf(unfinished).not.toHaveProperty("returning");
  });

  it("is a count Statement once picked, and no Query without returning", () => {
    const filtered = deleteFrom(users).where((u) => u.id.eq(1));
    const every = deleteFrom(users).allRows();
    expectTypeOf(filtered).toExtend<RunArgument>();
    expectTypeOf(every).toExtend<RunArgument>();
    expectTypeOf(filtered).not.toExtend<AllArgument>();
    expectTypeOf(every).not.toExtend<AllArgument>();
    expectTypeOf(filtered).not.toExtend<OneArgument>();
    expectTypeOf(every).not.toExtend<OneArgument>();
  });

  it("types returning over the deleted row", () => {
    const returned = deleteFrom(users)
      .where((u) => u.id.eq(1))
      .returning((u) => ({ key: u.id, name: u.name, born: u.born }));
    expectTypeOf(returned).toExtend<
      Query<{ key: number; name: string | null; born: string | null }>
    >();
    expectTypeOf(returned).toExtend<RunArgument>();
  });

  it("carries the many marker through returning only for allRows", () => {
    const every = deleteFrom(users)
      .allRows()
      .returning((u) => ({ id: u.id }));
    const some = deleteFrom(users)
      .where((u) => u.id.eq(1))
      .returning((u) => ({ id: u.id }));
    expectTypeOf(every).toExtend<Many>();
    expectTypeOf(some).not.toExtend<Many>();
    expectTypeOf(every).toExtend<AllArgument>();
    expectTypeOf(every).not.toExtend<OneArgument>();
    expectTypeOf(some).toExtend<AllArgument>();
    expectTypeOf(some).toExtend<OneArgument>();
  });

  it("offers the calls a column's class takes, as from does", () => {
    const unfinished = deleteFrom(users);
    const filtered = unfinished.where((u) => u.email.ilike("a%"));
    expect(filtered.toSql().text).toContain("ilike");
    /* oxlint-disable typescript/no-unsafe-return, typescript/no-unsafe-call -- each rejected call is the point. */
    // @ts-expect-error includes is for array columns
    void unfinished.where((u) => u.email.includes("a"));
    // @ts-expect-error like is for text columns
    void unfinished.where((u) => u.id.like("1%"));
    /* oxlint-enable typescript/no-unsafe-return, typescript/no-unsafe-call */
  });
});
