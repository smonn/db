import { describe, expect, it } from "vitest";
import type { Catalog, Fact } from "../catalog/index.ts";
import { diff } from "./diff.ts";

function schema(name: string): [string, Fact] {
  return [name, { kind: "schema", name, parent: undefined, payload: {} }];
}

function table(schemaName: string, name: string): [string, Fact] {
  return [`${schemaName}.${name}`, { kind: "table", name, parent: schemaName, payload: {} }];
}

function column(tablePath: string, name: string, notNull = false): [string, Fact] {
  return [
    `${tablePath}.${name}`,
    { kind: "column", name, parent: tablePath, payload: { type: "text", notNull } },
  ];
}

function catalog(...facts: [string, Fact][]): Catalog {
  return new Map(facts);
}

describe("diff", () => {
  it("emits nothing for equal catalogs", () => {
    const users = catalog(schema("public"), table("public", "users"), column("public.users", "id"));
    expect(diff(users, users)).toBe("");
  });

  it("creates a schema, then its tables with their columns in catalog order", () => {
    const to = catalog(
      schema("auth"),
      table("auth", "users"),
      column("auth.users", "name", true),
      column("auth.users", "email"),
      table("auth", "empty"),
    );
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
    const from = catalog(schema("public"), table("public", "users"), column("public.users", "id"));
    const to = catalog(
      schema("public"),
      table("public", "users"),
      column("public.users", "id"),
      column("public.users", "zeta"),
      column("public.users", "alpha"),
      schema("b"),
      table("b", "t"),
      schema("a"),
    );
    expect(diff(from, to)).toBe(
      `create schema "b";

create schema "a";

create table "b"."t" ();

alter table "public"."users" add column "zeta" text;

alter table "public"."users" add column "alpha" text;
`,
    );
  });

  it("quotes identifiers, doubling embedded quotes", () => {
    const to = catalog(schema('we"ird'));
    expect(diff(catalog(), to)).toBe(`create schema "we""ird";\n`);
  });

  it("refuses a drop, which v0.1 can't emit yet", () => {
    const from = catalog(schema("public"), table("public", "users"));
    expect(() => diff(from, catalog(schema("public")))).toThrow(
      "Can't drop table public.users yet",
    );
  });

  it("refuses a changed fact, which v0.1 can't alter yet", () => {
    const from = catalog(schema("public"), table("public", "users"), column("public.users", "id"));
    const to = catalog(
      schema("public"),
      table("public", "users"),
      column("public.users", "id", true),
    );
    expect(() => diff(from, to)).toThrow("Can't alter column public.users.id yet");
  });
});
