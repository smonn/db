import { assert, describe, expect, expectTypeOf, it } from "vitest";
import { defineDatabase } from "./database.ts";
import { defineTable, type Row } from "./definition.ts";
import type { ColumnRefs } from "./refs.ts";
import type { ColumnFactories } from "./factories.ts";

const columns = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer(), c: c.text() });

const pair = (c: ColumnFactories) => ({ a: c.integer(), b: c.integer() });

describe("a unique entry in the second callback", () => {
  it("lists two or more columns, in order, and takes a name and nullsNotDistinct", () => {
    const t = defineTable(columns, (r) => ({
      unique: [
        { columns: [r.b, r.a] },
        { columns: [r.a, r.b, r.c], name: "uq_abc", nullsNotDistinct: true },
      ],
    }));

    expect(t.uniques).toStrictEqual([
      { name: undefined, columns: ["b", "a"], nullsNotDistinct: false },
      { name: "uq_abc", columns: ["a", "b", "c"], nullsNotDistinct: true },
    ]);
    expectTypeOf<Row<typeof t>>().toEqualTypeOf<{
      a: number | null;
      b: number | null;
      c: string | null;
    }>();
  });

  it("is empty without one, and reaches the table `defineDatabase` returns", () => {
    expect(defineTable(columns).uniques).toStrictEqual([]);
    const t = defineTable(columns, (r) => ({ unique: [{ columns: [r.a, r.b] }] }));
    expect(defineDatabase({ public: { t } }).public.t.uniques).toStrictEqual(t.uniques);
  });

  it("sits beside a primary key and a column's own unique()", () => {
    const t = defineTable(
      (c) => ({ a: c.integer(), b: c.integer(), c: c.text().unique() }),
      (r) => ({ primaryKey: [r.a, r.b], unique: [{ columns: [r.b, r.a] }] }),
    );
    expect(t.primaryKey).toStrictEqual(["a", "b"]);
    expect(t.uniques).toHaveLength(1);
    expect(t.columns.c.state.unique).toBe(true);
  });

  it("rejects fewer than two columns, by type and at load", () => {
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- one column calls unique() on the column.
        (r) => ({ unique: [{ columns: [r.a] }] }),
      ),
    ).toThrow(
      "The table's unique lists fewer than two columns; call unique() on the column instead",
    );
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- no column at all.
        () => ({ unique: [{ columns: [] }] }),
      ),
    ).toThrow("fewer than two columns");
  });

  it("rejects a column twice", () => {
    expect(() => defineTable(columns, (r) => ({ unique: [{ columns: [r.a, r.b, r.a] }] }))).toThrow(
      'The table\'s unique lists "a" twice',
    );
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
        (r) => ({ unique: [{ columns: [r.a, foreign.b] }] }),
      ),
    ).toThrow('The table\'s unique takes "b" from another table');
    // The types compare tables by their columns, so only the load check catches a table with the same ones.
    expect(() => defineTable(pair, (r) => ({ unique: [{ columns: [r.a, foreign.b] }] }))).toThrow(
      'takes "b" from another table',
    );
  });

  it("rejects a name that is not a string and nullsNotDistinct that is not a boolean", () => {
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- a name is a string.
        (r) => ({ unique: [{ columns: [r.a, r.b], name: 1 }] }),
      ),
    ).toThrow("takes its name as a string");
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- nullsNotDistinct is a boolean.
        (r) => ({ unique: [{ columns: [r.a, r.b], nullsNotDistinct: "yes" }] }),
      ),
    ).toThrow("takes nullsNotDistinct as a boolean");
  });

  it("rejects an unknown key by name, and an entry that is not an object in a list", () => {
    expect(() =>
      // TypeScript lets an extra key through an arrow function's inferred return, so only the load check catches `where`, which belongs to indexes.
      defineTable(columns, (r) => ({ unique: [{ columns: [r.a, r.b], where: "true" }] })),
    ).toThrow('does not take "where"');
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- a list of entries.
        (r) => ({ unique: { columns: [r.a, r.b] } }),
      ),
    ).toThrow("The table's unique takes a list of");
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- an entry is an object, not a bare list of columns.
        (r) => ({ unique: [[r.a, r.b]] }),
      ),
    ).toThrow("The table's unique does not take");
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- an entry is an object.
        () => ({ unique: [null] }),
      ),
    ).toThrow("The table's unique takes a list of");
    expect(() =>
      defineTable(
        columns,
        // @ts-expect-error -- an entry is an object.
        () => ({ unique: [3] }),
      ),
    ).toThrow("The table's unique takes a list of");
  });
});
