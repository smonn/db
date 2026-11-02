import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { sql } from "./sql.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: {
    scores: defineTable((c) => ({ id: c.integer().notNull(), points: c.integer().notNull() })),
  },
});

describe("orderBy with a colliding output alias", () => {
  beforeAll(async () => {
    await testDatabase.driver.execute(
      "create table public.scores (id integer not null, points integer not null); insert into public.scores values (1, 20), (2, 10)",
    );
  });

  it("orders the input column for bare, ascending and descending orderings", async () => {
    const selected = from(db.public.scores).select((s) => ({ id: s.points }));
    const ascending = [{ id: 20 }, { id: 10 }];

    expect(await client.all(selected.orderBy((s) => s.id))).toStrictEqual(ascending);
    expect(await client.all(selected.orderBy((s) => s.id.asc()))).toStrictEqual(ascending);
    expect(await client.all(selected.orderBy((s) => s.id.desc()))).toStrictEqual([
      { id: 10 },
      { id: 20 },
    ]);
  });

  it("orders the input column for a ref inside an orderBy fragment", async () => {
    const selected = from(db.public.scores).select((s) => ({ id: s.points }));

    expect(await client.all(selected.orderBy((s) => sql.expr`${s.id}`.asc()))).toStrictEqual([
      { id: 20 },
      { id: 10 },
    ]);
    expect(await client.all(selected.orderBy((s) => sql.expr`(${s.id})`.asc()))).toStrictEqual([
      { id: 20 },
      { id: 10 },
    ]);
    expect(await client.all(selected.orderBy((s) => sql.expr`${s.id}`.desc()))).toStrictEqual([
      { id: 10 },
      { id: 20 },
    ]);
  });

  it("keeps a ref in where and select bare on a single table", () => {
    const query = from(db.public.scores)
      .select((s) => ({ id: s.id, doubled: sql.expr<number>`${s.points} * 2` }))
      .where((s) => sql.expr<boolean>`${s.id} = 1`)
      .orderBy((s) => sql.expr`${s.id}`.asc());

    expect(query.toSql().text).toBe(
      'select "id", "points" * 2 as "doubled" from "public"."scores" where "id" = 1 order by "scores"."id" asc',
    );
  });
});
