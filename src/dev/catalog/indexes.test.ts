import { describe, expect, it } from "vitest";
import {
  defineDatabase,
  defineTable,
  type ColumnFactories,
  type ColumnRefs,
} from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./definition-catalog.ts";

const columns = (c: ColumnFactories) => ({ a: c.text(), b: c.text(), c: c.text() });

type Refs = ColumnRefs<ReturnType<typeof columns>>;

/** A `t` table whose second callback declares the indexes `indexes` returns. */
function catalogOf(
  indexes: (t: Refs) => readonly object[],
  define: (c: ColumnFactories) => ReturnType<typeof columns> = columns,
  table = "t",
) {
  return definitionCatalog(
    defineDatabase({
      public: {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the entries are checked in runtime/definition's tests.
        [table]: defineTable(define, ((t: Refs) => ({ indexes: indexes(t) })) as never),
      },
    }),
  );
}

/** A table whose only index takes `name`. */
const named = (name: string) =>
  defineTable(
    (c) => ({ a: c.text() }),
    (r) => ({ indexes: [{ columns: [r.a], name }] }),
  );

const twice = (second?: { name: string }) =>
  definitionCatalog(
    defineDatabase({ public: { t: defineTable((c) => ({ a: c.text().index().index(second) })) } }),
  );

/** A `t` table with an identity `a` and a unique `b`, whose index on `b` takes `index`, beside `other`. */
const two = (index: object, other = defineTable(columns)) =>
  definitionCatalog(
    defineDatabase({
      public: {
        t: defineTable(
          (c) => ({ a: c.integer().identity(), b: c.text().unique() }),
          (r) => ({ indexes: [{ columns: [r.b], ...index }] }),
        ),
        other,
      },
    }),
  );

const indexesOf = (catalog: ReturnType<typeof definitionCatalog>) =>
  [...catalog.values()]
    .filter((fact) => fact.kind === "index")
    .map((fact) => [fact.name, fact.payload]);

const btree = (...keyColumns: string[]) => ({
  unique: false,
  method: "btree",
  keys: keyColumns.map((column) => ({ column, descending: false, nullsFirst: false })),
  include: [],
  nullsNotDistinct: false,
});

describe("an index in the Definition", () => {
  it("takes Postgres's name, <table>_<columns joined by _>_idx, and keeps its key order", () => {
    expect(indexesOf(catalogOf((t) => [{ columns: [t.b, t.a, t.c] }]))).toStrictEqual([
      ["t_b_a_c_idx", btree("b", "a", "c")],
    ]);
  });

  it("takes the name the Definition gives, and every option", () => {
    const catalog = catalogOf((t) => [
      {
        columns: [
          { key: t.a, order: "desc" },
          { key: t.b, nulls: "first" },
        ],
        include: [t.c],
        method: "hash",
        unique: true,
        nullsNotDistinct: true,
        name: "ix",
      },
    ]);

    expect(indexesOf(catalog)).toStrictEqual([
      [
        "ix",
        {
          unique: true,
          method: "hash",
          keys: [
            { column: "a", descending: true, nullsFirst: true },
            { column: "b", descending: false, nullsFirst: true },
          ],
          include: ["c"],
          nullsNotDistinct: true,
        },
      ],
    ]);
  });

  it("keys under its table, beside a unique constraint, as a relation of its own", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          t: defineTable(
            (c) => ({ a: c.text().unique().index(), b: c.text() }),
            (r) => ({ indexes: [{ columns: [r.a, r.b] }] }),
          ),
        },
      }),
    );

    expect([...catalog.keys()].filter((key) => key.includes("\0\0"))).toStrictEqual([
      "public\0t\0\0t_a_key",
      "public\0t\0\0index\0t_a_idx",
      "public\0t\0\0index\0t_a_b_idx",
    ]);
  });

  it("is a column's .index() with the column's method and name", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          t: defineTable((c) => ({
            a: c.text().index(),
            b: c.text().index({ method: "hash" }).index({ name: "by_b", method: "gin" }),
          })),
        },
      }),
    );

    expect(indexesOf(catalog)).toStrictEqual([
      ["t_a_idx", btree("a")],
      ["t_b_idx", { ...btree("b"), method: "hash" }],
      ["by_b", { ...btree("b"), method: "gin" }],
    ]);
  });

  it("takes a name of 63 bytes, and refuses a derived or given one over it", () => {
    const fits = `${"t".repeat(57)}_a_idx`;
    expect(fits).toHaveLength(63);
    expect(() => catalogOf((t) => [{ columns: [t.a] }], columns, "t".repeat(57))).not.toThrow();
    expect(() => catalogOf((t) => [{ columns: [t.a] }], columns, "t".repeat(58))).toThrow(
      `the index name "${"t".repeat(58)}_a_idx" is longer than 63 bytes`,
    );
    expect(() => catalogOf((t) => [{ columns: [t.a], name: "n".repeat(64) }])).toThrow(
      "is longer than 63 bytes",
    );
    expect(() => catalogOf((t) => [{ columns: [t.a], name: "n".repeat(63) }])).not.toThrow();
  });

  it("refuses an empty name", () => {
    expect(() => catalogOf((t) => [{ columns: [t.a], name: "" }])).toThrow(
      "has an empty index name",
    );
  });

  it("refuses two unnamed .index() calls on one column, until one has a name", () => {
    expect(() => twice()).toThrow(
      'the index on "public"."t" ("a") and the index on "public"."t" ("a") both take the index name "t_a_idx"; give one of them another name with index({ name }) or an indexes entry\'s { name }',
    );
    expect(() => twice({ name: "t_a_second" })).not.toThrow();
  });

  it("refuses an indexes entry that takes a name an index already has", () => {
    expect(() =>
      definitionCatalog(
        defineDatabase({
          public: {
            t: defineTable(
              (c) => ({ a: c.text().index(), b: c.text() }),
              (r) => ({ indexes: [{ columns: [r.a] }] }),
            ),
          },
        }),
      ),
    ).toThrow('both take the index name "t_a_idx"');
  });

  it("refuses the name of a table, an identity sequence, or a key's index", () => {
    expect(() => two({ name: "other" })).toThrow(
      'takes the index name "other", which is also the name of the table "public"."other"; give the index another name',
    );
    expect(() => two({ name: "t_a_seq" })).toThrow(
      "which is also the name of the identity sequence",
    );
    expect(() => two({ name: "t_b_key" })).toThrow(
      'the unique constraint on "public"."t" ("b") and the index on "public"."t" ("b") both take the index name "t_b_key"',
    );
  });

  it("clashes with an index on another table of the schema, but not with a foreign key's name", () => {
    const user = defineTable((c) => ({ id: c.integer().primaryKey() }));
    expect(() =>
      definitionCatalog(defineDatabase({ public: { x: named("shared"), y: named("shared") } })),
    ).toThrow('both take the index name "shared"');

    // A foreign key is a constraint, not a relation, so an index may share its name.
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          user,
          order: defineTable(
            (c) => ({ user_id: c.integer().references(() => user.columns.id, { name: "same" }) }),
            (r) => ({ indexes: [{ columns: [r.user_id], name: "same" }] }),
          ),
        },
      }),
    );

    expect(
      [...catalog.values()].filter(({ name }) => name === "same").map(({ kind }) => kind),
    ).toStrictEqual(["index", "foreign key"]);
  });

  it("allows the same index name in two schemas", () => {
    expect(() =>
      definitionCatalog(
        defineDatabase({ public: { t: named("same") }, other: { t: named("same") } }),
      ),
    ).not.toThrow();
  });
});
