import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { sql } from "./sql.ts";
import type { Statement } from "./statement.ts";
import { update } from "./update.ts";

const db = defineDatabase({
  public: {
    users: defineTable((c) => ({
      id: c.integer().identity("always").primaryKey(),
      n: c.integer().notNull(),
      email: c.text().notNull(),
      name: c.text(),
      born: c
        .integer()
        .codec({ encode: (value: string) => Number(value.slice(1)), decode: (base) => `#${base}` }),
    })),
  },
});
const { users } = db.public;

/** A plain-JS caller can pass what TypeScript rejects, such as an undefined value or an unknown key. */
const looseSet = (values: Record<string, unknown>) => update(users).set(values);

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

beforeEach(async () => {
  await testDatabase.driver.execute(
    [
      "drop table if exists public.users",
      `create table public.users (id integer generated always as identity primary key, n integer not null, email text not null, name text, born integer)`,
      `insert into public.users (n, email, name, born) values
        (1, 'ann@example.com', 'Ann', 5),
        (2, 'bo@example.com', null, 7),
        (3, 'cy@example.org', 'Cy', null)`,
    ].join("; "),
  );
});

const rows = () =>
  client.all(
    from(users)
      .pick("id", "email", "name", "n", "born")
      .orderBy((u) => u.id),
  );

describe("update on Postgres", () => {
  it("refuses to run before where or allRows, for a JavaScript caller", async () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- A plain-JS caller passes it; TypeScript rejects it.
    const unfinished = update(users).set({ n: 0 }) as unknown as Statement;
    await expect(client.run(unfinished)).rejects.toThrow(
      "update needs where() or allRows() before it runs",
    );
    expect((await rows()).map((row) => row.n)).toStrictEqual([1, 2, 3]);
  });

  it("updates the rows a where matches and reports the count", async () => {
    const result = await client.run(
      update(users)
        .set({ name: "Example", n: 10 })
        .where((u) => u.email.like("%@example.com")),
    );
    expect(result).toStrictEqual({ count: 2 });
    expect((await rows()).map((row) => [row.name, row.n])).toStrictEqual([
      ["Example", 10],
      ["Example", 10],
      ["Cy", 3],
    ]);
  });

  it("updates the rows every where call keeps", async () => {
    const result = await client.run(
      update(users)
        .set({ n: 0 })
        .where((u) => u.email.like("%@example.com"))
        .where((u) => u.id.gt(1)),
    );
    expect(result).toStrictEqual({ count: 1 });
    expect((await rows()).map((row) => row.n)).toStrictEqual([1, 0, 3]);
  });

  it("updates every row with allRows", async () => {
    expect(await client.run(update(users).set({ n: 0 }).allRows())).toStrictEqual({ count: 3 });
    expect((await rows()).map((row) => row.n)).toStrictEqual([0, 0, 0]);
  });

  it("updates no row when none match", async () => {
    const result = await client.run(
      update(users)
        .set({ n: 0 })
        .where((u) => u.id.eq(99)),
    );
    expect(result).toStrictEqual({ count: 0 });
    expect((await rows()).map((row) => row.n)).toStrictEqual([1, 2, 3]);
  });

  it("sets a nullable column to null and leaves a skipped one alone", async () => {
    await client.run(looseSet({ name: null, email: undefined }).where((u) => u.id.eq(1)));
    expect((await rows())[0]).toMatchObject({ email: "ann@example.com", name: null });
  });

  it("encodes a set value through the column's codec", async () => {
    await client.run(
      update(users)
        .set({ born: "#42" })
        .where((u) => u.id.eq(3)),
    );
    expect((await rows())[2]?.born).toBe("#42");
  });

  it("sets a column from an expression over itself", async () => {
    await client.run(
      update(users)
        .set({ n: sql.expr<number>`n + 1` })
        .allRows(),
    );
    expect((await rows()).map((row) => row.n)).toStrictEqual([2, 3, 4]);
  });

  it("sets a column from a callback's expression, bound params included", async () => {
    await client.run(
      update(users)
        .set({
          n: (u) => sql.expr<number>`${u.n} * ${10}`,
          name: (u) => sql.expr<string | null>`upper(${u.email})`,
        })
        .where((u) => u.id.eq(2)),
    );
    expect((await rows())[1]).toMatchObject({ n: 20, name: "BO@EXAMPLE.COM" });
  });

  it("returns the new values through client.all, decoded by the column codecs", async () => {
    const result = await client.all(
      update(users)
        .set({ n: 7, born: "#1" })
        .where((u) => u.id.in([1, 2]))
        .returning((u) => ({ id: u.id, n: u.n, born: u.born })),
    );
    expect(result.toSorted((a, b) => a.id - b.id)).toStrictEqual([
      { id: 1, n: 7, born: "#1" },
      { id: 2, n: 7, born: "#1" },
    ]);
  });

  it("returns the one updated row through client.one", async () => {
    const row = await client.one(
      update(users)
        .set({ email: "new@example.com" })
        .where((u) => u.id.eq(3))
        .returning((u) => ({ email: u.email })),
    );
    expect(row).toStrictEqual({ email: "new@example.com" });
  });

  it("rejects client.one when the where matches no row", async () => {
    await expect(
      client.one(
        update(users)
          .set({ n: 0 })
          .where((u) => u.id.eq(99))
          .returning((u) => ({ id: u.id })),
      ),
    ).rejects.toThrow("Expected one row but the query returned 0");
  });

  it("returns every row of allRows through client.all", async () => {
    const result = await client.all(
      update(users)
        .set({ n: 0 })
        .allRows()
        .returning((u) => ({ id: u.id })),
    );
    expect(result).toHaveLength(3);
  });

  it("rejects a codec that throws when the statement renders", async () => {
    const throwing = defineDatabase({
      public: {
        users: defineTable((c) => ({
          n: c.text().codec({
            encode: (value: string): string => {
              throw new Error(`cannot encode ${value}`);
            },
            decode: (base: string) => base,
          }),
        })),
      },
    }).public.users;
    const statement = update(throwing).set({ n: "x" }).allRows();
    await expect(client.run(statement)).rejects.toThrow(
      /codec of column "n".*threw while encoding/u,
    );
    expect((await rows()).map((row) => row.n)).toStrictEqual([1, 2, 3]);
  });
});
