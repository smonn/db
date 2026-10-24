import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type GeneratedPayload } from "../catalog/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { table } from "./column-attributes.test-helper.ts";
import { diff } from "./diff.ts";

const stored = (expression: string): GeneratedPayload => ({ expression, storage: "stored" });
const virtual = (expression: string): GeneratedPayload => ({ expression, storage: "virtual" });

const int = { type: "integer" };

/** Without its own hazard comments, the statements of a diff, split on blank lines. */
function statements(from: Catalog, to: Catalog): string[] {
  return bareDiff(from, to).trim().split("\n\n");
}

describe("create table and add column", () => {
  it("renders a generation expression inline, stored or virtual", () => {
    const to = table({
      a: int,
      s: { ...int, generated: stored("(a * 2)") },
      v: { ...int, notNull: true, generated: virtual("(a * 3)") },
    });
    const from = catalogBuilder();
    from.schema("public");

    expect(bareDiff(from.build(), to)).toBe(`create table "public"."t" (
  "a" integer,
  "s" integer generated always as ((a * 2)) stored,
  "v" integer not null generated always as ((a * 3)) virtual
);
`);
  });

  it("adds a generated column to an existing table with no separate alter", () => {
    const from = table({ a: int });
    const to = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });

    expect(bareDiff(from, to)).toBe(
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) stored;\n`,
    );
  });
});

describe("in place", () => {
  it("changes an expression with SET EXPRESSION", () => {
    const from = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    const to = table({ a: int, s: { ...int, generated: stored("(a * 3)") } });

    expect(bareDiff(from, to)).toBe(
      `alter table "public"."t" alter column "s" set expression as ((a * 3));\n`,
    );
  });

  it("changes a virtual expression the same way", () => {
    const from = table({ a: int, v: { ...int, generated: virtual("(a * 2)") } });
    const to = table({ a: int, v: { ...int, generated: virtual("(a * 3)") } });

    expect(bareDiff(from, to)).toBe(
      `alter table "public"."t" alter column "v" set expression as ((a * 3));\n`,
    );
  });

  it("emits nothing for an unchanged expression", () => {
    const both = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    expect(diff(both, both).sql).toBe("");
  });

  it("drops the expression of a stored column, keeping its values", () => {
    const from = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    const to = table({ a: int, s: int });

    expect(bareDiff(from, to)).toBe(`alter table "public"."t" alter column "s" drop expression;\n`);
  });

  it("drops the expression before it sets a default on the same column", () => {
    const from = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    const to = table({ a: int, s: { ...int, default: { expression: "1" } } });

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" alter column "s" drop expression;`,
      `alter table "public"."t" alter column "s" set default (1);`,
    ]);
  });
});

describe("rebuilt columns", () => {
  it("drops and adds back a plain column that becomes generated", () => {
    const from = table({ a: int, s: int });
    const to = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) stored;`,
    ]);
  });

  it("drops what the old column held instead of altering it", () => {
    const from = table({
      a: int,
      s: { ...int, notNull: true, default: { expression: "1" } },
    });
    const to = table({ a: int, s: { ...int, generated: virtual("(a * 2)") } });

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) virtual;`,
    ]);
  });

  it("drops and adds back a virtual column that becomes plain, which has no DROP EXPRESSION", () => {
    const from = table({ a: int, v: { ...int, generated: virtual("(a * 2)") } });
    const to = table({ a: int, v: int });

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" drop column "v";`,
      `alter table "public"."t" add column "v" integer;`,
    ]);
  });

  it("drops and adds back a column that switches between stored and virtual", () => {
    const from = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    const to = table({ a: int, s: { ...int, generated: virtual("(a * 2)") } });

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) virtual;`,
    ]);
  });

  it("adds back a key on the column, which the drop took with it", () => {
    const keys = { primary: ["a", "s"], unique: { name: "t_s_key", column: "s" } };
    const from = table({ a: int, s: int }, keys);
    const to = table({ a: int, s: { ...int, generated: stored("(a * 2)") } }, keys);

    expect(statements(from, to)).toStrictEqual([
      `alter table "public"."t" drop constraint "t_s_key";`,
      `alter table "public"."t" drop constraint "t_pkey";`,
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) stored;`,
      `alter table "public"."t" add constraint "t_pkey" primary key ("a", "s");`,
      `alter table "public"."t" add constraint "t_s_key" unique ("s");`,
    ]);
  });

  it("leaves a key on another column alone", () => {
    const keys = { primary: ["a"] };
    const from = table({ a: int, s: int }, keys);
    const to = table({ a: int, s: { ...int, generated: stored("(a * 2)") } }, keys);

    expect(statements(from, to).join("\n")).not.toContain("constraint");
  });
});

const REWRITE = ["rewrite", "access_exclusive_lock"];

function kinds(from: Catalog, to: Catalog): string[] {
  return diff(from, to).hazards.map((hazard) => hazard.kind);
}

/** The hazards of changing the expression of a generated column of the given storage. */
function expressionChange(make: (expression: string) => GeneratedPayload): string[] {
  return kinds(
    table({ a: int, g: { ...int, generated: make("(a * 2)") } }),
    table({ a: int, g: { ...int, generated: make("(a * 3)") } }),
  );
}

describe("hazards", () => {
  it("flags adding a stored column as a rewrite, and a virtual one as safe", () => {
    const from = table({ a: int });
    expect(
      kinds(from, table({ a: int, s: { ...int, generated: stored("(a * 2)") } })),
    ).toStrictEqual(REWRITE);
    expect(
      kinds(from, table({ a: int, v: { ...int, generated: virtual("(a * 2)") } })),
    ).toStrictEqual([]);
  });

  it("flags a new expression on a stored column as a rewrite, and on a virtual one as safe", () => {
    expect(expressionChange(stored)).toStrictEqual(REWRITE);
    expect(expressionChange(virtual)).toStrictEqual([]);
  });

  it("flags no hazard for dropping the expression of a stored column", () => {
    const from = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });
    expect(kinds(from, table({ a: int, s: int }))).toStrictEqual([]);
  });

  it("flags data loss for a plain column that becomes generated, since it drops the column", () => {
    const from = table({ a: int, s: int });
    const to = table({ a: int, s: { ...int, generated: stored("(a * 2)") } });

    expect(kinds(from, to)).toStrictEqual(["data_loss", ...REWRITE]);
  });
});
