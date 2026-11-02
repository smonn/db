import { beforeAll, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import { insert } from "./insert.ts";
import { sql } from "./sql.ts";
import { update } from "./update.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);
const db = defineDatabase({
  public: {
    pairs: defineTable((c) => ({
      id: c.integer().notNull().primaryKey(),
      other: c.integer().notNull(),
    })),
  },
});
const { pairs } = db.public;

describe("a sql.expr fragment renders as one parenthesised term", () => {
  beforeAll(async () => {
    await testDatabase.driver.execute(
      "create table public.pairs (id integer primary key, other integer not null); insert into public.pairs values (1, 20), (2, 10), (3, 20)",
    );
  });

  it("orders by the pair a comma joins, descending as a whole", async () => {
    const query = from(pairs)
      .pick("id")
      .orderBy((p) => sql.expr`${p.other}, ${p.id}`.desc());

    expect(query.toSql().text).toBe(
      'select "id" from "public"."pairs" order by ("pairs"."other", "pairs"."id") desc',
    );
    expect(await client.all(query)).toStrictEqual([{ id: 3 }, { id: 1 }, { id: 2 }]);
  });

  it("selects the pair under its own key alone", async () => {
    const query = from(pairs)
      .select((p) => ({ pair: sql.expr`${p.id}, ${p.other}` }))
      .where((p) => p.id.eq(1));

    expect(query.toSql().text).toBe(
      'select ("id", "other") as "pair" from "public"."pairs" where "id" = $1',
    );
    expect(await client.all(query)).toStrictEqual([{ pair: "(1,20)" }]);
  });

  it("wraps a fragment that asc adds to", () => {
    const query = from(pairs)
      .pick("id")
      .orderBy((p) => sql.expr`${p.id} + 1`.asc({ nulls: "first" }));

    expect(query.toSql().text).toBe(
      'select "id" from "public"."pairs" order by ("pairs"."id" + 1) asc nulls first',
    );
  });

  it("leaves a bare orderBy term alone, which may name its own direction", async () => {
    const query = from(pairs)
      .pick("id")
      .orderBy((p) => [sql.expr`${p.other} using >`, sql.expr`${p.id} desc`]);

    expect(query.toSql().text).toBe(
      'select "id" from "public"."pairs" order by "pairs"."other" using >, "pairs"."id" desc',
    );
    expect(await client.all(query)).toStrictEqual([{ id: 3 }, { id: 1 }, { id: 2 }]);
  });

  it("wraps a fragment in a join's on, so a comma can't add a table", async () => {
    const joined = from(pairs)
      .innerJoin(pairs, (a, b) => sql.expr`${a.id} = ${b.id}`)
      .select((a) => ({ id: a.id }));
    const extraTable = from(pairs)
      .innerJoin(pairs, (a, b) => sql.expr`${a.id} = ${b.id}, public.pairs as extra`)
      .select((a) => ({ id: a.id }));

    expect(joined.toSql().text).toContain('on ("pairs"."id" = "pairs_2"."id")');
    await expect(client.all(extraTable)).rejects.toThrow(/syntax error/u);
  });

  it("wraps a fragment in returning", () => {
    const query = update(pairs)
      .set({ other: 5 })
      .where((p) => p.id.eq(1))
      .returning((p) => ({ pair: sql.expr`${p.id}, ${p.other}` }));

    expect(query.toSql().text).toBe(
      'update "public"."pairs" set "other" = $1 where "id" = $2 returning ("id", "other") as "pair"',
    );
  });

  it("wraps a fragment in values, valuesMany, and set", () => {
    expect(
      insert(pairs)
        .values({ id: 4, other: sql.expr<number>`1 + 1` })
        .toSql().text,
    ).toBe('insert into "public"."pairs" ("id", "other") values ($1, (1 + 1))');
    expect(
      insert(pairs)
        .valuesMany([{ id: 4, other: sql.expr<number>`1 + 1` }])
        .toSql().text,
    ).toBe('insert into "public"."pairs" ("id", "other") values ($1, (1 + 1))');
    expect(
      update(pairs)
        .set({ other: (p) => sql.expr<number>`${p.other} + 1` })
        .where((p) => p.id.eq(1))
        .toSql().text,
    ).toBe('update "public"."pairs" set "other" = ("other" + 1) where "id" = $1');
  });

  it("refuses a comma in values instead of reading it as two cells", async () => {
    const query = insert(pairs).values({ id: 4, other: sql.expr<number>`1, 2` });

    await expect(client.all(query.returning((p) => ({ id: p.id })))).rejects.toThrow(
      /record|column "other"/u,
    );
  });

  it("wraps a fragment in doUpdate", () => {
    const query = insert(pairs)
      .values({ id: 1, other: 1 })
      .onConflict((p) => [p.id])
      .doUpdate((existing, excluded) => ({
        other: sql.expr<number>`${existing.other} + ${excluded.other}`,
      }));

    expect(query.toSql().text).toContain(
      'do update set "other" = ("public"."pairs"."other" + "excluded"."other")',
    );
  });

  it("leaves a ref and a comparison unwrapped", () => {
    const query = from(pairs)
      .select((p) => ({ id: p.id, same: p.id.eq(p.other) }))
      .orderBy((p) => [p.id.eq(1), p.id.eq(2).desc(), p.other.desc()]);

    expect(query.toSql().text).toBe(
      'select "id", "id" = "other" as "same" from "public"."pairs" order by "pairs"."id" = $1, "pairs"."id" = $2 desc, "pairs"."other" desc',
    );
  });
});
