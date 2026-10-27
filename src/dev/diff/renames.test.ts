import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type Rename } from "../catalog/index.ts";
import { diff } from "./diff.ts";

type Columns = Readonly<Record<string, string>>;

function people(columns: Columns, table = "people"): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  builder.table("app", table);
  for (const [name, type] of Object.entries(columns)) {
    builder.column("app", table, name, { type, notNull: false });
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

describe("diff with renames", () => {
  it("renames a column, flagging the rename and nothing else", () => {
    const catalog = people({ full_name: "text" });
    const result = diff(catalog, catalog, [renameColumn]);

    const statement = `alter table "app"."people" rename column "name" to "full_name";`;
    expect(result.sql).toBe(`-- hazard: rename\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "rename", statement }]);
  });

  it("renames a table", () => {
    const catalog = people({ id: "text" });

    expect(diff(catalog, catalog, [renameTable]).sql).toBe(
      `-- hazard: rename\nalter table "app"."users" rename to "people";\n`,
    );
  });

  it("runs the rename before a retype of the same column, under the new name", () => {
    const { sql } = diff(people({ full_name: "integer" }), people({ full_name: "bigint" }), [
      renameColumn,
    ]);

    expect(sql.split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "app"."people" rename column "name" to "full_name";`,
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\n` +
        `alter table "app"."people" alter column "full_name" type bigint;\n`,
    ]);
  });

  it("runs table renames before column renames, ahead of every other change", () => {
    const from = people({ full_name: "text", gone: "text" });
    const to = people({ full_name: "text", fresh: "text" });

    const { sql } = diff(from, to, [renameColumn, renameTable]);

    const statements = sql.trimEnd().split("\n\n");
    expect(statements.map((statement) => statement.split("\n").at(-1))).toStrictEqual([
      `alter table "app"."users" rename to "people";`,
      `alter table "app"."people" rename column "name" to "full_name";`,
      `alter table "app"."people" drop column "gone";`,
      `alter table "app"."people" add column "fresh" text;`,
    ]);
  });

  it("refuses a rename the catalog doesn't hold under the new name", () => {
    const catalog = people({ id: "text" });

    expect(() => diff(catalog, catalog, [renameColumn])).toThrow(
      "the renamed column app.people.full_name isn't in the catalog",
    );
    expect(() => diff(catalog, catalog, [{ ...renameTable, name: "gone" }])).toThrow(
      "the renamed table app.gone isn't in the catalog",
    );
  });

  it("stays a plain diff with no renames", () => {
    const catalog = people({ id: "text" });

    expect(diff(catalog, catalog, [])).toStrictEqual({
      sql: "",
      hazards: [],
      hints: [],
      scans: [],
    });
  });
});
