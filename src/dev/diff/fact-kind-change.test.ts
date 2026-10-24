import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type Fact } from "../catalog/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

/** A `public.t` table of one NOT NULL text column `a`, with a unique constraint `t_key` on it. */
function table(): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  builder.column("public", "t", "a", { type: "text", notNull: true });
  builder.unique("public", "t", "t_key", { column: "a" });
  return builder.build();
}

/**
 * `catalog` with the facts that match `from` relabeled as `kind`, payload untouched. No catalog
 * can hold two kinds of equal payload yet, so a test forges one.
 */
function relabeled(catalog: Catalog, from: Fact["kind"], kind: string): Catalog {
  return new Map(
    [...catalog].map(([key, fact]) => [
      key,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Forges a kind the builder can't produce.
      fact.kind === from ? ({ ...fact, kind } as unknown as Fact) : fact,
    ]),
  );
}

describe("a fact that changes kind at the same catalog key", () => {
  it("drops the old kind, then adds the new one, even when the payloads are equal", () => {
    const from = relabeled(table(), "unique", "primary key");

    expect(diff(from, table()).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_key";`,
      `alter table "public"."t" add constraint "t_key" unique ("a");\n`,
    ]);
  });

  it("throws for a kind it has no action for, naming the kind", () => {
    const forged = relabeled(table(), "unique", "foreign key");

    expect(() => diff(table(), forged)).toThrow('Unhandled fact kind "foreign key"');
    expect(() => diff(forged, table())).toThrow('Unhandled fact kind "foreign key"');
    expect(() => diff(forged, forged)).toThrow('Unhandled fact kind "foreign key"');
  });
});
