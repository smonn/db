import { assert, describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase, defineTable, type Row } from "./definition.ts";
import type { ColumnFactories } from "./factories.ts";
import type { ColumnRefs } from "./refs.ts";

const columns = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer(), c: c.text() });

const pair = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer() });

type Refs = ColumnRefs<ReturnType<typeof columns>>;

/** Defines a table whose second callback returns `indexes` as given, past the types. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test hands malformed entries to a typed API.
const loose = defineTable as unknown as (
  define: typeof columns,
  extras: (r: Refs) => { indexes: unknown },
) => unknown;

const loadRaw = (indexes: (r: Refs) => unknown) => () =>
  loose(columns, (r) => ({ indexes: indexes(r) }));

const load = (entry: (r: Refs) => unknown) => loadRaw((r) => [entry(r)]);

describe("an indexes entry in the second callback", () => {
  it("takes keys in order and defaults every option", () => {
    const t = defineTable(columns, (r) => ({ indexes: [{ columns: [r.b, r.a] }] }));

    expect(t.indexes).toStrictEqual([
      {
        name: undefined,
        keys: [
          { column: "b", descending: false, nullsFirst: false },
          { column: "a", descending: false, nullsFirst: false },
        ],
        include: [],
        method: "btree",
        unique: false,
        nullsNotDistinct: false,
      },
    ]);
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      a: number | null;
      b: number | null;
      c: string | null;
    }>();
  });

  it("accepts one column, unlike a unique or a primary key", () => {
    expect(defineTable(columns, (r) => ({ indexes: [{ columns: [r.a] }] })).indexes).toHaveLength(
      1,
    );
  });

  it("takes every option", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [
        {
          columns: [r.a, r.b],
          include: [r.c],
          method: "hash",
          unique: true,
          nullsNotDistinct: true,
          name: "ix",
        },
      ],
    }));

    expect(t.indexes[0]).toMatchObject({
      name: "ix",
      include: ["c"],
      method: "hash",
      unique: true,
      nullsNotDistinct: true,
    });
  });

  it.each(["btree", "hash", "gin", "gist", "brin"] as const)("takes the method %s", (method) => {
    expect(
      defineTable(columns, (r) => ({ indexes: [{ columns: [r.a], method }] })).indexes[0]?.method,
    ).toBe(method);
  });

  it("wraps a key to set its order and where NULLs sort", () => {
    const t = defineTable(columns, (r) => ({
      indexes: [
        {
          columns: [
            { key: r.a, order: "desc" },
            { key: r.b, order: "desc", nulls: "last" },
            { key: r.c, nulls: "first" },
          ],
        },
      ],
    }));

    expect(t.indexes[0]?.keys).toStrictEqual([
      { column: "a", descending: true, nullsFirst: true },
      { column: "b", descending: true, nullsFirst: false },
      { column: "c", descending: false, nullsFirst: true },
    ]);
    expect(
      defineTable(columns, (r) => ({
        indexes: [{ columns: [{ key: r.a, order: "asc", nulls: "last" }] }],
      })).indexes[0]?.keys,
    ).toStrictEqual([{ column: "a", descending: false, nullsFirst: false }]);
  });

  it("is empty without one, and reaches the table `defineDatabase` returns", () => {
    expect(defineTable(columns).indexes).toStrictEqual([]);
    const t = defineTable(columns, (r) => ({ indexes: [{ columns: [r.a, r.b] }] }));
    expect(defineDatabase({ public: { t } }).public.t.indexes).toStrictEqual(t.indexes);
  });

  it("rejects no column, by type and at load", () => {
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- an index needs a column.
        () => ({ indexes: [{ columns: [] }] }),
      ),
    ).toThrow("The table's indexes lists no columns");
  });

  it("rejects no key even when INCLUDE has columns", () => {
    expect(load((r) => ({ columns: [], include: [r.a] }))).toThrow("lists no columns");
  });

  it("rejects a column twice, in the keys or beside INCLUDE", () => {
    expect(() =>
      defineTable(columns, (r) => ({ indexes: [{ columns: [r.a, { key: r.a, order: "desc" }] }] })),
    ).toThrow('The table\'s indexes lists "a" twice');
    expect(() =>
      defineTable(columns, (r) => ({ indexes: [{ columns: [r.a], include: [r.a] }] })),
    ).toThrow('The table\'s indexes lists "a" twice');
  });

  it("rejects another table's references, by type where the columns differ and at load always", () => {
    const held: { refs?: ColumnRefs<ReturnType<typeof pair>> } = {};
    defineTable(pair, (t) => {
      held.refs = t;
      return {};
    });
    const foreign = held.refs;
    assert(foreign !== undefined);
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- "b" belongs to a table with other columns.
        (r) => ({ indexes: [{ columns: [r.a, foreign.b] }] }),
      ),
    ).toThrow('The table\'s indexes takes "b" from another table');
    expect(() =>
      defineTable(pair, (r) => ({ indexes: [{ columns: [r.a], include: [foreign.b] }] })),
    ).toThrow('takes "b" from another table');
    expect(() =>
      defineTable(pair, (r) => ({ indexes: [{ columns: [{ key: foreign.a }, r.b] }] })),
    ).toThrow('takes "a" from another table');
  });

  it("rejects a method, order, nulls, name, or flag of the wrong kind", () => {
    expect(load((r) => ({ columns: [r.a], method: "spgist" }))).toThrow(
      'The table\'s indexes entry takes the method "btree", "hash", "gin", "gist", "brin", not "spgist"',
    );
    expect(load((r) => ({ columns: [{ key: r.a, order: "up" }] }))).toThrow(
      'takes order "asc" or "desc"',
    );
    expect(load((r) => ({ columns: [{ key: r.a, nulls: "middle" }] }))).toThrow(
      'takes nulls "first" or "last"',
    );
    expect(load((r) => ({ columns: [r.a], name: 1 }))).toThrow("takes its name as a string");
    expect(load((r) => ({ columns: [r.a], unique: "yes" }))).toThrow("takes unique as a boolean");
    expect(load((r) => ({ columns: [r.a], nullsNotDistinct: 1 }))).toThrow(
      "takes nullsNotDistinct as a boolean",
    );
    expect(load((r) => ({ columns: r.a }))).toThrow("takes columns as a list");
    expect(load((r) => ({ columns: [r.a], include: r.b }))).toThrow("takes include as a list");
  });

  it("rejects an unknown key by name, and a shape that is not a list of entries", () => {
    expect(load(() => ({ columns: [], where: "true" }))).toThrow('does not take "where"');
    expect(loadRaw(() => ({}))).toThrow("The table's indexes takes a list of");
    expect(loadRaw(() => [null])).toThrow("The table's indexes takes a list of");
    expect(() =>
      defineTable(columns, (r) => ({
        // TypeScript lets an extra key through an arrow function's inferred return, so only the load check catches it.
        indexes: [{ columns: [{ key: r.a, collate: "C" }] }],
      })),
    ).toThrow('does not take "collate"');
  });
});

describe("index() on a column", () => {
  it("records nothing by default and one entry per call, in order", () => {
    const t = defineTable((c) => ({
      plain: c.text(),
      one: c.text().index(),
      two: c.text().index({ name: "by_two" }).index({ method: "hash" }),
    }));

    expect(t.columns.plain.state.indexes).toStrictEqual([]);
    expect(t.columns.one.state.indexes).toStrictEqual([{ name: undefined, method: "btree" }]);
    expect(t.columns.two.state.indexes).toStrictEqual([
      { name: "by_two", method: "btree" },
      { name: undefined, method: "hash" },
    ]);
  });

  it("sits beside a primary key, a unique, a reference, and a default", () => {
    const t = defineTable((c) => ({
      id: c.integer().primaryKey().index(),
      email: c.text().unique().index().default("''"),
    }));

    expect(t.columns.id.state).toMatchObject({ primaryKey: true });
    expect(t.columns.email.state.indexes).toHaveLength(1);
  });

  it("takes only name and method, and rejects a bad one when called", () => {
    expect(() =>
      defineTable((c) => ({
        // @ts-expect-error -- .index() takes no unique.
        a: c.text().index({ unique: true }),
      })),
    ).toThrow('index() does not take "unique"; it takes { name, method }');
    expect(() =>
      defineTable((c) => ({
        // @ts-expect-error -- not a method.
        a: c.text().index({ method: "spgist" }),
      })),
    ).toThrow('index() takes the method "btree"');
    expect(() =>
      defineTable((c) => ({
        // @ts-expect-error -- a name is a string.
        a: c.text().index({ name: 1 }),
      })),
    ).toThrow("index() takes its name as a string");
  });
});
