import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { diff } from "./diff.ts";

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

  it("quotes identifiers, doubling embedded quotes", () => {
    const to = catalog((b) => {
      b.schema('we"ird');
    });
    expect(diff(catalog(), to)).toBe(`create schema "we""ird";\n`);
  });

  it("refuses a drop, which v0.1 can't emit yet", () => {
    const to = catalog((b) => {
      b.schema("public");
    });
    const from = catalog((b) => {
      b.schema("public");
      b.table("public", "users");
    });
    expect(() => diff(from, to)).toThrow("Can't drop table public.users yet");
  });

  it("refuses a changed fact, which v0.1 can't alter yet", () => {
    const to = catalog((b) => {
      b.schema("public");
      b.table("public", "users");
      b.column("public", "users", "id", textNotNull);
    });
    expect(() => diff(catalog(users), to)).toThrow("Can't alter column public.users.id yet");
  });
});
