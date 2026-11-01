import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable, type Row } from "../definition/index.ts";
import { createClient } from "./client.ts";
import { from } from "./from.ts";
import type { Ordering, Refs } from "./refs.ts";

const testDatabase = useTestDatabase();
const client = createClient(testDatabase.driver);

const db = defineDatabase({
  public: {
    scores: defineTable((c) => ({
      id: c.text().notNull(),
      points: c.integer().notNull(),
      note: c.text(),
    })),
  },
});
const scores = from(db.public.scores);
const ALL = '"id", "points", "note"';

type NullsOptions = { readonly nulls?: "first" | "last" };
type NotNullableOptions = { readonly "nulls needs a nullable column"?: never };

const ids = async (query: typeof scores) => (await client.all(query)).map((row) => row.id);

const orderedIds = (...order: Parameters<typeof scores.orderBy>) => ids(scores.orderBy(...order));

/** Plain-JS callers reach options TypeScript rejects. */
const orderByOptions = (options: unknown) => () =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
  scores.orderBy((s) => s.note.asc(options as { nulls: "first" }));

describe("orderBy", () => {
  it("renders an ordering, a bare column, and a list in order", () => {
    expect(scores.orderBy((s) => s.id.asc()).toSql()).toStrictEqual({
      text: `select ${ALL} from "public"."scores" order by "id" asc`,
      params: [],
    });
    expect(scores.orderBy((s) => s.points.desc()).toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "points" desc`,
    );
    expect(scores.orderBy((s) => s.points).toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "points"`,
    );
    expect(scores.orderBy((s) => [s.points.desc(), s.id, s.note.asc()]).toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "points" desc, "id", "note" asc`,
    );
  });

  it("appends on a repeated call", () => {
    const query = scores.orderBy((s) => s.points.desc()).orderBy((s) => [s.id, s.note.desc()]);
    expect(query.toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "points" desc, "id", "note" desc`,
    );
  });

  it("places nulls on a nullable column", () => {
    const first = scores.orderBy((s) => s.note.asc({ nulls: "first" }));
    const last = scores.orderBy((s) => s.note.desc({ nulls: "last" }));
    expect(first.toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "note" asc nulls first`,
    );
    expect(last.toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "note" desc nulls last`,
    );
    expect(scores.orderBy((s) => s.note.asc({})).toSql().text).toBe(
      `select ${ALL} from "public"."scores" order by "note" asc`,
    );
  });

  it("follows the SQL names defineDatabase mapped, and quotes them", () => {
    const odd = defineDatabase({
      public: { "Odd Table": defineTable((c) => ({ rank: c.integer().name("Odd Rank") })) },
    });
    expect(
      from(odd.public["Odd Table"])
        .orderBy((o) => [o.rank.desc(), o.rank])
        .toSql().text,
    ).toBe(
      'select "Odd Rank" as "rank" from "public"."Odd Table" order by "Odd Rank" desc, "Odd Rank"',
    );
  });

  it("goes after where and before limit and offset, whichever call comes first", () => {
    const query = scores
      .offset(4)
      .limit(2)
      .orderBy((s) => s.id.desc())
      .where((s) => s.points.gt(1));
    expect(query.toSql()).toStrictEqual({
      text: `select ${ALL} from "public"."scores" where "points" > $1 order by "id" desc limit $2 offset $3`,
      params: [1, 2, 4],
    });
  });

  it("keeps the select", () => {
    const query = scores.select((s) => ({ p: s.points })).orderBy((s) => s.id);
    expect(query.toSql().text).toBe('select "points" as "p" from "public"."scores" order by "id"');
  });

  it("refuses an empty list, an unknown option, and a bad nulls value", () => {
    expect(() => scores.orderBy(() => [])).toThrow("orderBy needs at least one column");
    expect(orderByOptions({ nulls: "middle" })).toThrow(
      'nulls must be "first" or "last", got "middle"',
    );
    expect(orderByOptions({ nulls: 1 })).toThrow('nulls must be "first" or "last", got 1');
    expect(orderByOptions({ nulss: "first" })).toThrow('Unknown ordering option "nulss"');
    expect(orderByOptions({ a: 1, nulls: "first", b: 2 })).toThrow(
      'Unknown ordering option "a", "b"',
    );
  });

  it("types an ordering and a list of them, and keeps the row type", () => {
    type ScoreRefs = Refs<Row<typeof db.public.scores>>;
    expectTypeOf<ReturnType<ScoreRefs["id"]["asc"]>>().toEqualTypeOf<Ordering>();
    expectTypeOf<Parameters<ScoreRefs["note"]["asc"]>[0]>().toEqualTypeOf<
      NullsOptions | undefined
    >();
    expectTypeOf<Parameters<ScoreRefs["id"]["asc"]>[0]>().toEqualTypeOf<
      NotNullableOptions | undefined
    >();
    expectTypeOf<Parameters<ScoreRefs["points"]["desc"]>[0]>().toEqualTypeOf<
      NotNullableOptions | undefined
    >();
    expectTypeOf<Parameters<ScoreRefs["note"]["desc"]>[0]>().toEqualTypeOf<
      NullsOptions | undefined
    >();
    expectTypeOf(scores.orderBy((s) => s.id)).toEqualTypeOf(scores);
  });
});

describe("limit and offset", () => {
  it("render as params, with no orderBy needed", () => {
    expect(scores.limit(5).toSql()).toStrictEqual({
      text: `select ${ALL} from "public"."scores" limit $1`,
      params: [5],
    });
    expect(scores.offset(10).toSql()).toStrictEqual({
      text: `select ${ALL} from "public"."scores" offset $1`,
      params: [10],
    });
    expect(scores.limit(5).offset(10).toSql().text).toBe(
      `select ${ALL} from "public"."scores" limit $1 offset $2`,
    );
  });

  it("accept zero and the largest safe integer", () => {
    expect(scores.limit(0).toSql().params).toStrictEqual([0]);
    expect(scores.offset(Number.MAX_SAFE_INTEGER).toSql().params).toStrictEqual([
      Number.MAX_SAFE_INTEGER,
    ]);
  });

  it("replace an earlier call", () => {
    expect(scores.limit(5).limit(7).offset(1).offset(2).toSql().params).toStrictEqual([7, 2]);
  });

  it("throw unless the count is a non-negative safe integer", () => {
    const bad = [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
    ];
    for (const count of bad) {
      expect(() => scores.limit(count)).toThrow(
        `limit needs a non-negative safe integer, got ${count}`,
      );
      expect(() => scores.offset(count)).toThrow(
        `offset needs a non-negative safe integer, got ${count}`,
      );
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Plain-JS callers reach this; TypeScript rejects it.
    expect(() => scores.limit("5" as unknown as number)).toThrow(
      "limit needs a non-negative safe integer, got 5",
    );
  });

  it("do not change the row type", () => {
    expectTypeOf(scores.limit(1).offset(1)).toEqualTypeOf(scores);
  });
});

describe("ordering and paging against Postgres", () => {
  beforeAll(async () => {
    await testDatabase.driver.execute(`
      create table public.scores (id text not null, points int not null, note text);
      insert into public.scores values
        ('a', 3, 'x'), ('b', 5, null), ('c', 3, 'y'), ('d', 8, null), ('e', 5, 'z');
    `);
  });

  it("sorts by several keys, mixing directions", async () => {
    expect(await ids(scores.orderBy((s) => [s.points.desc(), s.id.desc()]))).toStrictEqual([
      "d",
      "e",
      "b",
      "c",
      "a",
    ]);
    expect(await ids(scores.orderBy((s) => s.points).orderBy((s) => s.id.desc()))).toStrictEqual([
      "c",
      "a",
      "e",
      "b",
      "d",
    ]);
  });

  it("places NULLs where asked, and by Postgres's default without nulls", async () => {
    expect(await orderedIds((s) => [s.note.asc({ nulls: "first" }), s.id])).toStrictEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
    expect(await orderedIds((s) => [s.note.asc({ nulls: "last" }), s.id])).toStrictEqual([
      "a",
      "c",
      "e",
      "b",
      "d",
    ]);
    expect(await orderedIds((s) => [s.note.desc({ nulls: "last" }), s.id])).toStrictEqual([
      "e",
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(await orderedIds((s) => [s.note.asc(), s.id])).toStrictEqual(["a", "c", "e", "b", "d"]);
    expect(await orderedIds((s) => [s.note.desc(), s.id])).toStrictEqual(["b", "d", "e", "c", "a"]);
  });

  it("pages with limit and offset, each alone and together", async () => {
    const sorted = scores.orderBy((s) => s.id);
    expect(await ids(sorted.limit(2))).toStrictEqual(["a", "b"]);
    expect(await ids(sorted.offset(3))).toStrictEqual(["d", "e"]);
    expect(await ids(sorted.limit(2).offset(1))).toStrictEqual(["b", "c"]);
    expect(await ids(sorted.limit(0))).toStrictEqual([]);
    expect(await ids(sorted.offset(10))).toStrictEqual([]);
    expect(await ids(scores.limit(3))).toHaveLength(3);
  });

  it("filters, sorts, and pages together", async () => {
    const page = scores
      .where((s) => s.points.gte(5))
      .orderBy((s) => s.id.desc())
      .limit(2)
      .offset(1);
    expect(await ids(page)).toStrictEqual(["d", "b"]);
  });

  it("leaves client.one to count the rows that come back, ignoring limit(1)", async () => {
    const everyone = scores.orderBy((s) => s.id);
    await expect(client.one(everyone)).rejects.toThrow("Expected one row but the query returned 5");
    expect(await client.one(everyone.limit(1))).toStrictEqual({ id: "a", points: 3, note: "x" });
    await expect(client.one(everyone.limit(0))).rejects.toThrow(
      "Expected one row but the query returned 0",
    );
    await expect(client.one(everyone.limit(2))).rejects.toThrow(
      "Expected one row but the query returned 2",
    );
  });

  it("orders and pages by a column pick leaves out", async () => {
    const page = scores
      .pick("id", "note")
      .where((s) => s.points.gte(5))
      .orderBy((s) => s.points.desc())
      .orderBy((s) => s.id)
      .limit(2)
      .offset(1);
    expect(await client.all(page)).toStrictEqual([
      { id: "b", note: null },
      { id: "e", note: "z" },
    ]);
  });
});
