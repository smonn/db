import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { catalogBuilder, type Catalog } from "./catalog.ts";
import { appliedRenames, declaredRenames, type Rename } from "./renames.ts";

/** Schema `app` holding each table, which has the columns named. */
function shadow(tables: Readonly<Record<string, readonly string[]>>): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  for (const [table, columns] of Object.entries(tables)) {
    builder.table("app", table);
    for (const column of columns)
      builder.column("app", table, column, { type: "text", notNull: false });
  }
  return builder.build();
}

const renameTable: Rename = { kind: "table", schema: "app", name: "people", was: "users" };
const renameColumn: Rename = {
  kind: "column",
  schema: "app",
  table: "people",
  name: "full_name",
  was: "name",
};

describe("declaredRenames", () => {
  it("lists a table's marker, then each column's, with the schema and new names", () => {
    const people = defineTable(
      (c) => ({ id: c.text(), full_name: c.text().renamedFrom("name") }),
      () => ({ renamedFrom: "users" }),
    );
    const plain = defineTable((c) => ({ id: c.text() }));

    expect(declaredRenames(defineDatabase({ app: { plain, people } }))).toStrictEqual([
      renameTable,
      renameColumn,
    ]);
  });

  it("lists nothing without a marker", () => {
    const plain = defineTable((c) => ({ id: c.text() }));

    expect(declaredRenames(defineDatabase({ app: { plain } }))).toStrictEqual([]);
  });
});

describe("appliedRenames", () => {
  it("applies a rename whose old name is in the Shadow and new name is not", () => {
    const applied = appliedRenames([renameTable], shadow({ users: ["id"] }));

    expect(applied).toStrictEqual([renameTable]);
  });

  it("ignores a table marker whose old name is gone", () => {
    expect(appliedRenames([renameTable], shadow({ people: ["id"] }))).toStrictEqual([]);
    expect(appliedRenames([renameTable], shadow({}))).toStrictEqual([]);
  });

  it("throws when the old and new table names both exist", () => {
    const both = shadow({ users: ["id"], people: ["id"] });

    expect(() => appliedRenames([renameTable], both)).toThrow(
      'table "app"."people" has renamedFrom "users", but the Shadow database holds both',
    );
  });

  it("applies a column rename under the table's new name, or its old name when the table renames too", () => {
    expect(appliedRenames([renameColumn], shadow({ people: ["name"] }))).toStrictEqual([
      renameColumn,
    ]);
    expect(appliedRenames([renameTable, renameColumn], shadow({ users: ["name"] }))).toStrictEqual([
      renameTable,
      renameColumn,
    ]);
  });

  it("ignores a column marker whose old name is gone or whose table is new", () => {
    expect(appliedRenames([renameColumn], shadow({ people: ["full_name"] }))).toStrictEqual([]);
    expect(appliedRenames([renameColumn], shadow({}))).toStrictEqual([]);
  });

  it("throws when the old and new column names both exist", () => {
    const both = shadow({ people: ["name", "full_name"] });

    expect(() => appliedRenames([renameColumn], both)).toThrow(
      'column "app"."people"."full_name" has renamedFrom "name", but the Shadow database holds both',
    );
  });

  it("lists table renames before column renames", () => {
    const applied = appliedRenames([renameColumn, renameTable], shadow({ users: ["name"] }));

    expect(applied).toStrictEqual([renameTable, renameColumn]);
  });
});
