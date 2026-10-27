import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder, type Key } from "../catalog/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { retyped } from "./rebuilt.ts";

type Spec = { readonly columns?: readonly string[]; readonly type?: string };

/** `public.t` and the columns the spec names, each of the given type. */
function tableWith({ columns = [], type = "integer" }: Spec): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const name of columns) builder.column("public", "t", name, { type, notNull: false });
  return builder.build();
}

function keyOf(catalog: Catalog, kind: string): Key {
  const found = [...catalog].find(([, fact]) => fact.kind === kind);
  if (found === undefined) throw new Error(`no ${kind} fact`);
  return found[0];
}

describe("retyped", () => {
  const withColumn = tableWith({ columns: ["c"] });
  const column = keyOf(withColumn, "column");

  it("is true when the column's type changes, and false when it keeps it", () => {
    const changed = tableWith({ columns: ["c"], type: "bigint" });

    expect(retyped(column, { from: withColumn, to: changed })).toBe(true);
    expect(retyped(column, { from: withColumn, to: withColumn })).toBe(false);
  });

  it("is false when either catalog lacks the column", () => {
    const without = tableWith({});

    expect(retyped(column, { from: withColumn, to: without })).toBe(false);
    expect(retyped(column, { from: without, to: withColumn })).toBe(false);
    expect(retyped(column, { from: without, to: without })).toBe(false);
  });

  it("is false for a key that isn't a column", () => {
    const table = keyOf(withColumn, "table");

    expect(retyped(table, { from: withColumn, to: withColumn })).toBe(false);
  });
});

const GENERATED = { expression: "(1)", storage: "stored" } as const;
const ADD_GENERATED = `alter table "public"."a" add column "s" integer generated always as ((1)) stored;`;

type Piece = (builder: CatalogBuilder) => void;

/** `a (s)` and `b (s)`, with the pieces added after both tables. */
function twoTables(...pieces: Piece[]): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  for (const table of ["a", "b"]) {
    builder.table("public", table);
    builder.column("public", table, "s", { type: "integer", notNull: false });
  }
  for (const piece of pieces) piece(builder);
  return builder.build();
}

const generatedA: Piece = (builder) => {
  builder.columnGenerated("public", "a", "s", GENERATED);
};
const uniqueB: Piece = (builder) => {
  builder.unique("public", "b", "b_s_key", { columns: ["s"], nullsNotDistinct: false });
};

/** `a (k, s)`, with the pieces added after the table. */
function oneTable(...pieces: Piece[]): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "a");
  builder.column("public", "a", "k", { type: "integer", notNull: false });
  builder.column("public", "a", "s", { type: "integer", notNull: false });
  for (const piece of pieces) piece(builder);
  return builder.build();
}

const uniqueK: Piece = (builder) => {
  builder.unique("public", "a", "a_k_key", { columns: ["k"], nullsNotDistinct: false });
};

/** `a.s` with an identity before its generation, which is stored or virtual. */
function identityThenGenerated(storage: "stored" | "virtual"): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "a");
  builder.column("public", "a", "s", { type: "integer", notNull: false });
  builder.columnIdentity("public", "a", "s", { generated: "always" });
  builder.columnGenerated("public", "a", "s", { ...GENERATED, storage });
  return builder.build();
}

describe("a rebuilt column", () => {
  it("takes no key of another table's column of the same name with it", () => {
    const from = twoTables(uniqueB);
    const to = twoTables(generatedA, uniqueB);

    expect(bareDiff(from, to).trim().split("\n\n")).toStrictEqual([
      `alter table "public"."a" drop column "s";`,
      ADD_GENERATED,
    ]);
  });

  it("takes no key of the same table's other columns with it", () => {
    const from = oneTable(uniqueK);
    const to = oneTable((builder) => {
      builder.columnGenerated("public", "a", "s", GENERATED);
      uniqueK(builder);
    });

    expect(bareDiff(from, to).trim().split("\n\n")).toStrictEqual([
      `alter table "public"."a" drop column "s";`,
      ADD_GENERATED,
    ]);
  });

  it("reads a column's generation from its generated fact, whatever else it holds", () => {
    expect(bareDiff(identityThenGenerated("stored"), identityThenGenerated("stored"))).toBe("");
    expect(bareDiff(identityThenGenerated("stored"), identityThenGenerated("virtual"))).toContain(
      'drop column "s"',
    );
  });
});
