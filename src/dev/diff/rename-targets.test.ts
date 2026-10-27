import { describe, expect, it } from "vitest";
import {
  catalogBuilder,
  type Catalog,
  type CatalogBuilder,
  type Rename,
} from "../catalog/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";
import { renameAction } from "./renames.ts";

const DOMAIN = { base: "text", default: null, defaultVolatile: false, notNull: false };

function catalogWith(build: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  build(builder);
  return builder.build();
}

const table: Rename = { kind: "table", schema: "app", name: "thing", was: "old" };
const column: Rename = { kind: "column", schema: "app", table: "code", name: "short", was: "old" };

describe("renameAction", () => {
  it("refuses a table rename when the name holds a type, not a table", () => {
    const from = catalogWith((b) => {
      b.enumType("app", "thing", { labels: ["a"] });
    });

    expect(() => renameAction(table, from)).toThrow(
      "the renamed table app.thing isn't in the catalog",
    );
  });

  it("refuses a column rename when the path holds a domain check, not a column", () => {
    const from = catalogWith((b) => {
      b.domain("app", "code", DOMAIN);
      b.domainCheck("app", "code", "short", { expression: "length(VALUE) < 9" });
    });

    expect(() => renameAction(column, from)).toThrow(
      "the renamed column app.code.short isn't in the catalog",
    );
  });
});

function keys(names: Record<string, string>): Catalog {
  return catalogWith((b) => {
    for (const [tableName, key] of Object.entries(names)) {
      b.table("app", tableName);
      b.column("app", tableName, "c", { type: "text", notNull: false });
      b.unique("app", tableName, key, { columns: ["c"], nullsNotDistinct: false });
    }
  });
}

describe("a rename by payload beside a drop of the same name elsewhere", () => {
  it("renames the key of one table while another table drops a key of the new name", () => {
    const from = keys({ a: "k1", b: "k2" });
    const to = catalogWith((b) => {
      b.table("app", "a");
      b.column("app", "a", "c", { type: "text", notNull: false });
      b.unique("app", "a", "k2", { columns: ["c"], nullsNotDistinct: false });
      b.table("app", "b");
      b.column("app", "b", "c", { type: "text", notNull: false });
    });

    expect(bareDiff(from, to).trim().split("\n\n")).toStrictEqual([
      `alter table "app"."a" rename constraint "k1" to "k2";`,
      `alter table "app"."b" drop constraint "k2";`,
    ]);
    expect(diff(from, to).hazards).toStrictEqual([]);
  });
});
