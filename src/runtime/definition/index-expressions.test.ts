import { assert, describe, expect, it } from "vitest";
import { sql } from "../query/index.ts";
import { fragment, identifier } from "../sql/index.ts";
import { defineTable } from "./definition.ts";
import type { ColumnFactories } from "./factories.ts";
import type { ColumnRefs } from "./refs.ts";

const columns = (c: ColumnFactories) => ({ a: c.text(), b: c.text(), n: c.integer() });

const pair = (c: ColumnFactories) => ({ a: c.text(), b: c.text() });

type Refs = ColumnRefs<ReturnType<typeof columns>>;

/** Defines a table whose second callback returns `indexes` as given, past the types. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test hands malformed entries to a typed API.
const loose = defineTable as unknown as (
  define: typeof columns,
  extras: (r: Refs) => { indexes: unknown },
) => unknown;

const load = (entry: (r: Refs) => unknown) => () =>
  loose(columns, (r) => ({ indexes: [entry(r)] }));

describe("an expression key in the second callback's indexes", () => {
  it("holds the expression as DDL text, each reference as its quoted column", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [{ columns: [sql`lower(${r.a})`, r.b, sql`(${r.n} + 1)`], name: "ix" }],
    }));

    expect(t.indexes[0]?.keys).toStrictEqual([
      { expression: 'lower("a")', descending: false, nullsFirst: false },
      { column: "b", descending: false, nullsFirst: false },
      { expression: '("n" + 1)', descending: false, nullsFirst: false },
    ]);
  });

  it("takes an order and NULLs placement through { key, order, nulls }", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [
        {
          columns: [
            { key: sql`lower(${r.a})`, order: "desc" },
            { key: sql`upper(${r.b})`, nulls: "first" },
          ],
          name: "ix",
        },
      ],
    }));

    expect(t.indexes[0]?.keys).toStrictEqual([
      { expression: 'lower("a")', descending: true, nullsFirst: true },
      { expression: 'upper("b")', descending: false, nullsFirst: true },
    ]);
  });

  it("takes a fragment, and inlines one nested in another", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [
        {
          columns: [fragment`lower(${identifier("a")})`, fragment`${r.b} || ${fragment`'x'`}`],
          name: "ix",
        },
      ],
    }));

    expect(t.indexes[0]?.keys).toStrictEqual([
      { expression: 'lower("a")', descending: false, nullsFirst: false },
      { expression: `"b" || 'x'`, descending: false, nullsFirst: false },
    ]);
  });

  it("may name a column that is also a plain key, which INCLUDE still cannot repeat", () => {
    expect(
      defineTable(columns, (r) => ({
        indexes: [{ columns: [r.a, sql`lower(${r.a})`], name: "ix" }],
      })).indexes,
    ).toHaveLength(1);
    expect(
      load((r) => ({ columns: [r.a, sql`lower(${r.b})`], include: [r.a], name: "ix" })),
    ).toThrow('lists "a" twice');
  });

  it("demands its own name, by type and at load", () => {
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- Postgres's default name for an expression says nothing and collides.
        (r) => ({ indexes: [{ columns: [sql`lower(${r.a})`] }] }),
      ),
    ).toThrow("lists an expression key without a name");
    expect(
      defineTable(columns, (r) => ({ indexes: [{ columns: [r.a], where: sql`${r.b} is null` }] }))
        .indexes,
    ).toHaveLength(1);
  });

  it("rejects a value in the expression, which DDL cannot bind", () => {
    expect(load((r) => ({ columns: [sql`${r.n} + ${1}`], name: "ix" }))).toThrow(
      "takes column references in an sql expression, not values",
    );
    expect(load((r) => ({ columns: [r.a], where: sql`${r.n} > ${0}` }))).toThrow(
      "takes column references in an sql expression, not values",
    );
  });

  it("rejects another table's reference, and an empty expression", () => {
    const held: { refs?: ColumnRefs<ReturnType<typeof pair>> } = {};
    defineTable(pair, (t) => {
      held.refs = t;
      return {};
    });
    const foreign = held.refs;
    assert(foreign !== undefined);
    expect(load(() => ({ columns: [sql`lower(${foreign.b})`], name: "ix" }))).toThrow(
      'takes "b" from another table',
    );
    expect(load(() => ({ columns: [fragment`  `], name: "ix" }))).toThrow(
      "takes an sql expression that is empty",
    );
  });
});

describe("where in the second callback's indexes", () => {
  it("holds the predicate as DDL text, and works with unique", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [{ columns: [r.a], unique: true, where: sql`${r.b} is not null` }],
    }));

    expect(t.indexes[0]).toMatchObject({ unique: true, where: '"b" is not null' });
  });

  it("is undefined without one", () => {
    expect(defineTable(columns, (r) => ({ indexes: [{ columns: [r.a] }] })).indexes[0]?.where).toBe(
      undefined,
    );
  });

  it("takes an sql expression only", () => {
    expect(load((r) => ({ columns: [r.a], where: "b is null" }))).toThrow(
      "takes where as an sql expression",
    );
  });
});
