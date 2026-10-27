import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { diff } from "./diff.ts";

type Tables = Readonly<Record<string, Readonly<Record<string, string>>>>;

function schema(tables: Tables): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  for (const [table, columns] of Object.entries(tables)) {
    builder.table("app", table);
    for (const [name, type] of Object.entries(columns)) {
      builder.column("app", table, name, { type, notNull: false });
    }
  }
  return builder.build();
}

function withTable(table: string, extra: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  builder.table("app", table);
  builder.column("app", table, "id", { type: "text", notNull: false });
  extra(builder);
  return builder.build();
}

const hintsOf = (from: Tables, to: Tables): string[] => [...diff(schema(from), schema(to)).hints];

describe("rename hints", () => {
  it("names the renamedFrom to add when a table drops one column and adds one of the same type", () => {
    const hints = hintsOf(
      { t: { id: "text", name: "text" } },
      { t: { id: "text", title: "text" } },
    );

    expect(hints).toStrictEqual([
      'column "app"."t"."title" may be a rename of "name": add .renamedFrom("name") to it',
    ]);
  });

  it("stays quiet when the types differ, or more than one column drops or adds", () => {
    expect(hintsOf({ t: { name: "text" } }, { t: { title: "integer" } })).toStrictEqual([]);
    expect(hintsOf({ t: { a: "text", b: "text" } }, { t: { c: "text" } })).toStrictEqual([]);
    expect(hintsOf({ t: { a: "text" } }, { t: { b: "text", c: "text" } })).toStrictEqual([]);
  });

  it("names the renamedFrom to add when a schema drops a table and adds one with identical columns", () => {
    const hints = hintsOf(
      { users: { id: "text", name: "text" } },
      { people: { id: "text", name: "text" } },
    );

    expect(hints).toStrictEqual([
      'table "app"."people" may be a rename of "users": add renamedFrom: "users" to its second callback',
    ]);
  });

  it("stays quiet when the columns differ or several tables drop or add", () => {
    expect(hintsOf({ a: { id: "text" } }, { b: { id: "integer" } })).toStrictEqual([]);
    expect(hintsOf({ a: { id: "text" } }, { b: { key: "text" } })).toStrictEqual([]);
    expect(hintsOf({ a: { id: "text" }, b: { id: "text" } }, { c: { id: "text" } })).toStrictEqual(
      [],
    );
  });

  it("still names a renamed table when its columns come in another order", () => {
    const hints = hintsOf(
      { users: { id: "text", name: "text", email: "text" } },
      { people: { email: "text", id: "text", name: "text" } },
    );

    expect(hints).toStrictEqual([
      'table "app"."people" may be a rename of "users": add renamedFrom: "users" to its second callback',
    ]);
  });

  it("still names a renamed table beside a new enum or domain", () => {
    const hints = diff(
      withTable("users", () => {}),
      withTable("people", (builder) => {
        builder.enumType("app", "mood", { labels: ["a"] });
        builder.domain("app", "code", {
          base: "text",
          default: null,
          defaultVolatile: false,
          notNull: false,
        });
      }),
    ).hints;

    expect(hints).toStrictEqual([
      'table "app"."people" may be a rename of "users": add renamedFrom: "users" to its second callback',
    ]);
  });

  it("stays quiet for a table with no columns", () => {
    expect(hintsOf({ a: {} }, { b: {} })).toStrictEqual([]);
  });
});
