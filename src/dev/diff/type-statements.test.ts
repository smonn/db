import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { table } from "./column-attributes.test-helper.ts";
import { diff } from "./diff.ts";
import { enumTypes } from "./enums.ts";

function catalogWith(build: (builder: CatalogBuilder) => void): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  build(builder);
  return builder.build();
}

const DOMAIN = { base: "text", default: null, defaultVolatile: false, notNull: false };

describe("enumTypes", () => {
  it("lists only the enums, spelled as a column's type is", () => {
    const catalog = catalogWith((b) => {
      b.enumType("public", "mood", { labels: ["a"] });
      b.domain("public", "code", DOMAIN);
      b.table("public", "users");
      b.column("public", "users", "id", { type: "integer", notNull: false });
    });

    expect(enumTypes(catalog)).toStrictEqual(new Set(["public.mood"]));
  });
});

describe("create domain", () => {
  const empty = catalogWith(() => {});

  it("writes only the base for a domain with no default, NOT NULL, or check", () => {
    const to = catalogWith((b) => {
      b.domain("public", "code", DOMAIN);
    });

    expect(bareDiff(empty, to)).toBe(`create domain "public"."code" as text;\n`);
  });

  it("writes the NOT NULL, default, and checks it has", () => {
    const to = catalogWith((b) => {
      b.domain("public", "code", { ...DOMAIN, default: "'x'::text", notNull: true });
      b.domainCheck("public", "code", "short", { expression: "length(VALUE) < 9" });
    });

    expect(bareDiff(empty, to)).toBe(
      `create domain "public"."code" as text not null default ('x'::text) constraint "short" check (length(VALUE) < 9);\n`,
    );
  });
});

describe("the hazards of adding a column to an existing table", () => {
  const text = { type: "text" };
  const kinds = (column: Parameters<typeof table>[0][string]): string[] =>
    diff(table({ a: text }), table({ a: text, b: column })).hazards.map(({ kind }) => kind);

  it("carries none for a default that isn't volatile", () => {
    expect(kinds({ ...text, default: { expression: "'x'::text" } })).toStrictEqual([]);
  });

  it("carries a rewrite for an identity", () => {
    expect(
      kinds({ type: "integer", notNull: true, identity: { generated: "always" } }),
    ).toStrictEqual(["rewrite", "access_exclusive_lock"]);
  });
});
