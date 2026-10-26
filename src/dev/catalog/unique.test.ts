import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { definitionCatalog } from "./definition-catalog.ts";

const catalogOf = (table: string, unique: Parameters<typeof entries>[0]) =>
  definitionCatalog(defineDatabase({ public: { [table]: entries(unique) } }));

const entries = (
  unique: readonly { name?: string; nullsNotDistinct?: boolean; columns: readonly string[] }[],
) =>
  defineTable(
    (c) => ({ a: c.text(), b: c.text(), c: c.text(), long_column_name: c.text() }),
    (t) => ({
      unique: unique.map(({ columns, ...rest }) => ({
        ...rest,
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the test names columns by key.
        columns: columns.map((name) => t[name as "a"]) as unknown as [typeof t.a, typeof t.a],
      })),
    }),
  );

const uniquesOf = (catalog: ReturnType<typeof definitionCatalog>) =>
  [...catalog.values()]
    .filter((fact) => fact.kind === "unique")
    .map((fact) => [fact.name, fact.payload]);

describe("a multi-column unique constraint", () => {
  it("takes Postgres's name, <table>_<columns joined by _>_key, and keeps its column order", () => {
    expect(uniquesOf(catalogOf("t", [{ columns: ["b", "a", "c"] }]))).toStrictEqual([
      ["t_b_a_c_key", { columns: ["b", "a", "c"], nullsNotDistinct: false }],
    ]);
  });

  it("takes the name the Definition gives and its nullsNotDistinct", () => {
    expect(
      uniquesOf(catalogOf("t", [{ columns: ["a", "b"], name: "uq_ab", nullsNotDistinct: true }])),
    ).toStrictEqual([["uq_ab", { columns: ["a", "b"], nullsNotDistinct: true }]]);
  });

  it("keys under its table beside a column's own unique()", () => {
    const catalog = definitionCatalog(
      defineDatabase({
        public: {
          t: defineTable(
            (c) => ({ a: c.text().unique(), b: c.text() }),
            (r) => ({ unique: [{ columns: [r.a, r.b] }] }),
          ),
        },
      }),
    );
    expect([...catalog.keys()].filter((key) => key.includes("\0\0"))).toStrictEqual([
      "public\0t\0\0t_a_key",
      "public\0t\0\0t_a_b_key",
    ]);
  });

  it("refuses a derived name over 63 bytes, and keeps one at exactly 63", () => {
    const fits = `${"t".repeat(55)}_a_b_key`;
    expect(fits).toHaveLength(63);
    expect(() => catalogOf("t".repeat(55), [{ columns: ["a", "b"] }])).not.toThrow();
    expect(() => catalogOf("t".repeat(56), [{ columns: ["a", "b"] }])).toThrow(
      "is longer than 63 bytes",
    );
  });

  it("refuses a name over 63 bytes, counted in bytes, and an empty one", () => {
    expect(() => catalogOf("t", [{ columns: ["a", "b"], name: "é".repeat(32) }])).toThrow(
      "is longer than 63 bytes",
    );
    expect(() => catalogOf("t", [{ columns: ["a", "b"], name: "n".repeat(63) }])).not.toThrow();
    expect(() => catalogOf("t", [{ columns: ["a", "b"], name: "" }])).toThrow(
      'the unique constraint on "public"."t" ("a", "b") has an empty constraint name',
    );
  });

  it("refuses two that take one name, and a name another key in the schema holds", () => {
    expect(() => catalogOf("t", [{ columns: ["a", "b"] }, { columns: ["a", "b"] }])).toThrow(
      'the unique constraint on "public"."t" ("a", "b") and the unique constraint on "public"."t" ("a", "b") both take the constraint name "t_a_b_key"',
    );
    expect(() =>
      definitionCatalog(
        defineDatabase({
          public: {
            t: defineTable(
              (c) => ({ a: c.text().unique(), b: c.text(), a_b: c.text() }),
              (r) => ({ unique: [{ columns: [r.a, r.b], name: "t_a_key" }] }),
            ),
          },
        }),
      ),
    ).toThrow('both take the constraint name "t_a_key"');
  });

  it("refuses the name of a table in its schema", () => {
    expect(() =>
      definitionCatalog(
        defineDatabase({
          public: {
            users: defineTable((c) => ({ id: c.integer() })),
            t: entries([{ columns: ["a", "b"], name: "users" }]),
          },
        }),
      ),
    ).toThrow('takes the constraint name "users", which is also the name of the table');
  });
});
