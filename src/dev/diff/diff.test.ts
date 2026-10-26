import { describe, expect, it } from "vitest";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import {
  catalogBuilder,
  definitionCatalog,
  type Catalog,
  type CatalogBuilder,
} from "../catalog/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

const text = { type: "text", notNull: false };
const textNotNull = { type: "text", notNull: true };

function catalog(build: (builder: CatalogBuilder) => void = () => {}): Catalog {
  const builder = catalogBuilder();
  build(builder);
  return builder.build();
}

function users(builder: CatalogBuilder): void {
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "id", text);
}

describe("diff", () => {
  it("emits nothing for equal catalogs", () => {
    expect(diff(catalog(users), catalog(users))).toBe("");
  });

  it("creates a schema, then its tables with their columns in catalog order", () => {
    const to = catalog((b) => {
      b.schema("auth");
      b.table("auth", "users");
      b.column("auth", "users", "name", textNotNull);
      b.column("auth", "users", "email", text);
      b.table("auth", "empty");
    });
    expect(diff(catalog(), to)).toBe(
      `create schema "auth";

create table "auth"."users" (
  "name" text not null,
  "email" text
);

create table "auth"."empty" ();
`,
    );
  });

  it("orders schemas before tables before added columns, keeping catalog order within each", () => {
    const to = catalog((b) => {
      users(b);
      b.column("public", "users", "zeta", text);
      b.column("public", "users", "alpha", text);
      b.schema("b");
      b.table("b", "t");
      b.schema("a");
    });
    expect(diff(catalog(users), to)).toBe(
      `create schema "b";

create schema "a";

create table "b"."t" ();

alter table "public"."users" add column "zeta" text;

alter table "public"."users" add column "alpha" text;
`,
    );
  });

  it("keeps a table whose name holds a dot apart from the column it spells", () => {
    const to = definitionCatalog(
      defineDatabase({
        public: {
          users: defineTable((c) => ({ archive: c.text() })),
          "users.archive": defineTable((c) => ({ id: c.text() })),
        },
      }),
    );
    expect(diff(catalog(), to)).toBe(
      `create schema "public";

create table "public"."users" (
  "archive" text
);

create table "public"."users.archive" (
  "id" text
);
`,
    );
  });

  it("quotes identifiers, doubling embedded quotes", () => {
    const to = catalog((b) => {
      b.schema('we"ird');
    });
    expect(diff(catalog(), to)).toBe(`create schema "we""ird";\n`);
  });

  it("orders drops, then creates, then column alters, then key adds", () => {
    const from = catalog((b) => {
      b.schema("public");
      b.table("public", "gone");
      b.table("public", "t");
      b.column("public", "t", "a", text);
      b.column("public", "t", "b", { type: "integer", notNull: false });
      b.columnDefault("public", "t", "b", { expression: "1", volatile: false });
      b.column("public", "t", "c", textNotNull);
      b.primaryKey("public", "t", "t_pkey", { columns: ["c"] });
      b.unique("public", "t", "t_a_key", { columns: ["a"], nullsNotDistinct: false });
    });
    const to = catalog((b) => {
      b.schema("app");
      b.table("app", "u");
      b.schema("public");
      b.table("public", "t");
      b.column("public", "t", "b", { type: "bigint", notNull: true });
      b.columnDefault("public", "t", "b", { expression: "1", volatile: false });
      b.column("public", "t", "c", text);
      b.column("public", "t", "d", text);
      b.primaryKey("public", "t", "t_pkey", { columns: ["b"] });
      b.unique("public", "t", "t_d_key", { columns: ["d"], nullsNotDistinct: false });
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_a_key";`,
      `alter table "public"."t" drop constraint "t_pkey";`,
      `alter table "public"."t" drop column "a";`,
      `drop table "public"."gone";`,
      `create schema "app";`,
      `create table "app"."u" ();`,
      `alter table "public"."t" add column "d" text;`,
      `alter table "public"."t" alter column "b" drop default;`,
      `alter table "public"."t" alter column "b" type bigint;`,
      `alter table "public"."t" alter column "b" set not null;`,
      `alter table "public"."t" alter column "c" drop not null;`,
      `alter table "public"."t" alter column "b" set default (1);`,
      `alter table "public"."t" add constraint "t_pkey" primary key ("b");`,
      `alter table "public"."t" add constraint "t_d_key" unique ("d");\n`,
    ]);
  });
});
