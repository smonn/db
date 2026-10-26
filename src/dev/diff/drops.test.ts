import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

const db = useTestDatabase();

const text = { type: "text", notNull: false };
const id = { type: "integer", notNull: true };

function catalog(build: (builder: CatalogBuilder) => void = () => {}): Catalog {
  const builder = catalogBuilder();
  build(builder);
  return builder.build();
}

/** Table `t` in `schema`: `id` is an identity primary key, and `a` has a default and is unique. */
function fullTable(builder: CatalogBuilder, schema: string, name = "t"): void {
  builder.table(schema, name);
  builder.column(schema, name, "id", id);
  builder.columnIdentity(schema, name, "id", { generated: "always" });
  builder.column(schema, name, "a", text);
  builder.columnDefault(schema, name, "a", { expression: "'x'::text", volatile: false });
  builder.primaryKey(schema, name, `${name}_pkey`, { columns: ["id"] });
  builder.unique(schema, name, `${name}_a_key`, { columns: ["a"], nullsNotDistinct: false });
}

function publicOnly(builder: CatalogBuilder): void {
  builder.schema("public");
}

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists app cascade; drop schema public cascade; create schema public",
  );
});

describe("drops", () => {
  it("drops a column without dropping its default or identity first", () => {
    const from = catalog((b) => {
      b.schema("public");
      b.table("public", "t");
      b.column("public", "t", "keep", text);
      b.column("public", "t", "a", text);
      b.columnDefault("public", "t", "a", { expression: "'x'::text", volatile: false });
      b.column("public", "t", "n", id);
      b.columnIdentity("public", "t", "n", { generated: "by default" });
    });
    const to = catalog((b) => {
      b.schema("public");
      b.table("public", "t");
      b.column("public", "t", "keep", text);
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop column "a";`,
      `alter table "public"."t" drop column "n";\n`,
    ]);
  });

  it("drops in the source catalog's order, not by name", () => {
    const from = catalog((b) => {
      b.schema("public");
      b.table("public", "t");
      b.column("public", "t", "z", text);
      b.column("public", "t", "a", text);
    });
    const to = catalog((b) => {
      b.schema("public");
      b.table("public", "t");
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop column "z";`,
      `alter table "public"."t" drop column "a";\n`,
    ]);
  });

  it("drops a table and nothing it holds", () => {
    const from = catalog((b) => {
      publicOnly(b);
      fullTable(b, "public");
    });

    expect(diff(from, catalog(publicOnly))).toBe(`drop table "public"."t";\n`);
  });

  it("drops a schema's tables before the schema, since a drop without CASCADE refuses to empty it", () => {
    const from = catalog((b) => {
      b.schema("app");
      fullTable(b, "app", "t");
      fullTable(b, "app", "u");
    });

    expect(diff(from, catalog()).split("\n\n")).toStrictEqual([
      `drop table "app"."t";`,
      `drop table "app"."u";`,
      `drop schema "app";\n`,
    ]);
  });

  it("drops unique constraints, primary keys, columns, tables, then schemas", () => {
    const from = catalog((b) => {
      b.schema("app");
      b.table("app", "gone");
      publicOnly(b);
      fullTable(b, "public", "old");
      fullTable(b, "public", "t");
      b.column("public", "t", "b", text);
    });
    const to = catalog((b) => {
      publicOnly(b);
      b.table("public", "t");
      b.column("public", "t", "id", id);
      b.columnIdentity("public", "t", "id", { generated: "always" });
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_a_key";`,
      `alter table "public"."t" drop constraint "t_pkey";`,
      `alter table "public"."t" drop column "a";`,
      `alter table "public"."t" drop column "b";`,
      `drop table "app"."gone";`,
      `drop table "public"."old";`,
      `drop schema "app";\n`,
    ]);
  });

  it("never emits CASCADE", () => {
    const from = catalog((b) => {
      b.schema("app");
      fullTable(b, "app");
      publicOnly(b);
      fullTable(b, "public");
    });

    expect(diff(from, catalog(publicOnly))).not.toMatch(/cascade/iu);
  });
});

describe("renamed Definition keys", () => {
  it("drops and creates a renamed table", () => {
    const from = catalog((b) => {
      publicOnly(b);
      b.table("public", "old");
      b.column("public", "old", "a", text);
    });
    const to = catalog((b) => {
      publicOnly(b);
      b.table("public", "fresh");
      b.column("public", "fresh", "a", text);
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `drop table "public"."old";`,
      `create table "public"."fresh" (\n  "a" text\n);\n`,
    ]);
  });

  it("drops and adds a renamed column", () => {
    const from = catalog((b) => {
      publicOnly(b);
      b.table("public", "t");
      b.column("public", "t", "old", text);
    });
    const to = catalog((b) => {
      publicOnly(b);
      b.table("public", "t");
      b.column("public", "t", "fresh", text);
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop column "old";`,
      `alter table "public"."t" add column "fresh" text;\n`,
    ]);
  });

  it("creates a renamed schema with its tables and drops the old one last", () => {
    const from = catalog((b) => {
      b.schema("old");
      b.table("old", "t");
    });
    const to = catalog((b) => {
      b.schema("fresh");
      b.table("fresh", "t");
    });

    expect(diff(from, to).split("\n\n")).toStrictEqual([
      `drop table "old"."t";`,
      `create schema "fresh";`,
      `create table "fresh"."t" ();`,
      `drop schema "old";\n`,
    ]);
  });
});

describe("against Postgres", () => {
  it("drops a schema holding tables with keys, defaults, and identities", async () => {
    await db.driver.execute(`
      create schema app;
      create table app.t (id integer generated always as identity primary key, a text default 'x' unique);
      create table app.u (id integer generated always as identity primary key, a text default 'x' unique);
    `);

    await db.driver.execute(diff(await introspect(db.driver), catalog(publicOnly)));

    expect(await introspect(db.driver)).toStrictEqual(catalog(publicOnly));
  });

  it("drops keys, columns, and tables from a schema it keeps", async () => {
    await db.driver.execute(`
      create table old (id integer generated always as identity primary key);
      create table t (
        id integer generated always as identity constraint t_pkey primary key,
        a text default 'x' constraint t_a_key unique,
        b text
      );
    `);
    const wanted = catalog((b) => {
      publicOnly(b);
      b.table("public", "t");
      b.column("public", "t", "id", id);
      b.columnIdentity("public", "t", "id", { generated: "always" });
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });
});
