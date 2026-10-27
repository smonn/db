import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { diff } from "./diff.ts";
import { plain, withIndex } from "./indexes.test-helper.ts";

type Names = {
  readonly primaryKeys: readonly string[];
  readonly uniques: readonly string[];
  readonly foreignKeys: readonly string[];
  /** Over column `y` of table `a`. */
  readonly indexes: readonly string[];
  /** Over column `y` of table `b`. */
  readonly indexesOnB: readonly string[];
  readonly sequences: readonly string[];
};

const NONE: Names = {
  primaryKeys: [],
  uniques: [],
  foreignKeys: [],
  indexes: [],
  indexesOnB: [],
  sequences: [],
};

const target = { schema: "app", table: "b", columns: ["x"] };

function keysOf(builder: CatalogBuilder, names: Names): void {
  for (const name of names.primaryKeys) builder.primaryKey("app", "a", name, { columns: ["x"] });
  for (const name of names.uniques) {
    builder.unique("app", "a", name, { columns: ["y"], nullsNotDistinct: false });
  }
  for (const name of names.foreignKeys) {
    builder.foreignKey("app", "a", name, {
      columns: ["y"],
      target,
      onDelete: "no action",
      onUpdate: "no action",
      match: "simple",
      deferrable: "not deferrable",
    });
  }
}

function relationsOf(builder: CatalogBuilder, names: Names): void {
  for (const name of names.indexes) builder.index("app", "a", name, plain("y"));
  for (const name of names.indexesOnB) builder.index("app", "b", name, plain("y"));
  for (const sequence of names.sequences) {
    builder.columnIdentity("app", "a", "x", { generated: "always", sequence });
  }
}

/** A builder holding tables `a` and `b` with columns `x` and `y`. */
function baseTables(): CatalogBuilder {
  const builder = catalogBuilder();
  builder.schema("app");
  for (const table of ["a", "b"]) {
    builder.table("app", table);
    builder.column("app", table, "x", { type: "integer", notNull: true });
    builder.column("app", table, "y", { type: "integer", notNull: true });
  }
  return builder;
}

/** Tables `a` and `b` with columns `x` and `y`, and the named keys, indexes, and sequence. */
function tables(names: Partial<Names>): Catalog {
  const builder = baseTables();
  keysOf(builder, { ...NONE, ...names });
  relationsOf(builder, { ...NONE, ...names });
  return builder.build();
}

/** Table `a` with an index of each name over its column. */
function indexed(entries: readonly (readonly [name: string, column: string])[]): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  builder.table("app", "a");
  builder.column("app", "a", "x", { type: "integer", notNull: true });
  builder.column("app", "a", "y", { type: "integer", notNull: true });
  for (const [name, column] of entries) builder.index("app", "a", name, plain(column));
  return builder.build();
}

const statements = (from: Partial<Names>, to: Partial<Names>): string[] =>
  diff(tables(from), tables(to)).sql.trimEnd().split("\n\n");

describe("renames by payload", () => {
  it("renames a primary key, unique, foreign key, index, and sequence, with no Hazard", () => {
    const result = diff(
      tables({
        primaryKeys: ["a_pkey"],
        uniques: ["a_y_key"],
        foreignKeys: ["a_y_fkey"],
        indexes: ["a_y_idx"],
        sequences: ["a_seq"],
      }),
      tables({
        primaryKeys: ["b_pkey"],
        uniques: ["b_y_key"],
        foreignKeys: ["b_y_fkey"],
        indexes: ["b_y_idx"],
        sequences: ["b_seq"],
      }),
    );

    expect(result.sql.trimEnd().split("\n\n")).toStrictEqual([
      `alter table "app"."a" rename constraint "a_pkey" to "b_pkey";`,
      `alter table "app"."a" rename constraint "a_y_key" to "b_y_key";`,
      `alter table "app"."a" rename constraint "a_y_fkey" to "b_y_fkey";`,
      `alter index "app"."a_y_idx" rename to "b_y_idx";`,
      `alter sequence "app"."a_seq" rename to "b_seq";`,
    ]);
    expect(result.hazards).toStrictEqual([]);
  });

  it("drops and adds when two dropped indexes match one added", () => {
    expect(statements({ indexes: ["i", "j"] }, { indexes: ["k"] })).toStrictEqual([
      `drop index "app"."i";`,
      `drop index "app"."j";`,
      expect.stringContaining(`create index "k"`),
    ]);
  });

  it("drops and adds when one dropped index matches two added", () => {
    expect(statements({ indexes: ["k"] }, { indexes: ["i", "j"] })).toStrictEqual([
      `drop index "app"."k";`,
      expect.stringContaining(`create index "i"`),
      expect.stringContaining(`create index "j"`),
    ]);
  });

  it("drops and adds when the payload differs", () => {
    const { sql } = diff(indexed([["i", "y"]]), indexed([["k", "x"]]));

    expect(sql).not.toContain("rename");
    expect(sql).toContain(`drop index "app"."i"`);
    expect(sql).toContain(`create index "k"`);
  });

  it("drops and adds when the match is under another table", () => {
    expect(statements({ indexes: ["i"] }, { indexesOnB: ["j"] })).toStrictEqual([
      `drop index "app"."i";`,
      expect.stringContaining(`create index "j" on "app"."b"`),
    ]);
  });

  it("keeps an index on a rebuilt column a drop and an add under its own name", () => {
    const generated = { expression: "(a * 2)", storage: "stored" } as const;

    const { sql } = diff(withIndex([], "ix", plain("s")), withIndex([generated], "ix", plain("s")));

    expect(sql).not.toContain("rename");
    expect(sql).toContain(`drop index "public"."ix"`);
    expect(sql).toContain(`create index "ix"`);
  });

  it("leaves a name that a dropped index still holds to the drop", () => {
    // `j` changes from `x` to `y`, so it drops, and `i` has the payload it is added with.
    const { sql } = diff(
      indexed([
        ["i", "y"],
        ["j", "x"],
      ]),
      indexed([["j", "y"]]),
    );

    expect(sql).not.toContain("rename");
    expect(sql).toContain(`drop index "app"."i"`);
    expect(sql).toContain(`drop index "app"."j"`);
    expect(sql).toContain(`create index "j"`);
  });

  it("renames a sequence together with a changed identity mode", () => {
    const builder = baseTables();
    builder.columnIdentity("app", "a", "x", { generated: "by default", sequence: "b_seq" });

    const { sql } = diff(tables({ sequences: ["a_seq"] }), builder.build());

    expect(sql.trimEnd().split("\n\n")).toStrictEqual([
      `alter sequence "app"."a_seq" rename to "b_seq";`,
      `alter table "app"."a" alter column "x" set generated by default;`,
    ]);
  });
});
