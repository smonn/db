import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type Rename } from "../catalog/index.ts";
import { diff } from "./diff.ts";

type Checks = Readonly<Record<string, string>>;

function types(options: { readonly labels?: string[]; readonly checks?: Checks }): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  builder.enumType("app", "mood", { labels: options.labels ?? ["a"] });
  builder.domain("app", "posint", {
    base: "integer",
    notNull: false,
    default: null,
    defaultVolatile: false,
  });
  for (const [name, expression] of Object.entries(options.checks ?? {})) {
    builder.domainCheck("app", "posint", name, { expression });
  }
  return builder.build();
}

/** Domains `a` and `b`, with the check `positive` on `checked`. */
function checkedIn(checked: string): Catalog {
  const builder = catalogBuilder();
  builder.schema("app");
  for (const domain of ["a", "b"]) {
    builder.domain("app", domain, {
      base: "integer",
      notNull: false,
      default: null,
      defaultVolatile: false,
    });
  }
  builder.domainCheck("app", checked, "positive", { expression: "VALUE > 0" });
  return builder.build();
}

const renameEnum: Rename = { kind: "enum", schema: "app", name: "mood", was: "old_mood" };
const renameLabel: Rename = {
  kind: "enum label",
  schema: "app",
  enum: "mood",
  name: "great",
  was: "good",
};
const renameDomain: Rename = { kind: "domain", schema: "app", name: "posint", was: "old_posint" };

describe("diff with type renames", () => {
  it("renames an enum, a label, and a domain, each flagged as a rename", () => {
    const catalog = types({ labels: ["great"] });
    const { sql, hazards } = diff(catalog, catalog, [renameEnum, renameLabel, renameDomain]);

    expect(sql.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter type "app"."old_mood" rename to "mood";`,
      `-- hazard: rename\nalter type "app"."mood" rename value 'good' to 'great';`,
      `-- hazard: rename\nalter domain "app"."old_posint" rename to "posint";`,
    ]);
    expect(hazards.map(({ kind }) => kind)).toStrictEqual(["rename", "rename", "rename"]);
  });

  it("escapes a quote in a label", () => {
    const catalog = types({ labels: ["it's"] });
    const label: Rename = {
      kind: "enum label",
      schema: "app",
      enum: "mood",
      name: "it's",
      was: "x",
    };

    expect(diff(catalog, catalog, [label]).sql).toContain(`rename value 'x' to 'it''s';`);
  });

  it("runs the renames before the changes that follow them", () => {
    const { sql } = diff(types({ labels: ["great"] }), types({ labels: ["great", "ok"] }), [
      renameLabel,
    ]);

    expect(sql.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter type "app"."mood" rename value 'good' to 'great';`,
      `alter type "app"."mood" add value 'ok' after 'great';`,
    ]);
  });
});

describe("domain check renames", () => {
  it("renames a check whose expression matches the one dropped, with no Hazard", () => {
    const { sql, hazards } = diff(
      types({ checks: { above_zero: "VALUE > 0" } }),
      types({ checks: { positive: "VALUE > 0" } }),
    );

    expect(sql).toBe(`alter domain "app"."posint" rename constraint "above_zero" to "positive";\n`);
    expect(hazards).toStrictEqual([]);
  });

  it("drops and adds when the expression changes too", () => {
    const { sql } = diff(
      types({ checks: { above_zero: "VALUE > 0" } }),
      types({ checks: { positive: "VALUE > 1" } }),
    );

    expect(sql).toContain(`drop constraint "above_zero"`);
    expect(sql).not.toContain("rename");
  });

  it("drops and adds when several checks share the expression", () => {
    const { sql } = diff(
      types({ checks: { a: "VALUE > 0", b: "VALUE > 0" } }),
      types({ checks: { c: "VALUE > 0", d: "VALUE > 0" } }),
    );

    expect(sql).toContain("drop constraint");
    expect(sql).not.toContain("rename");
  });

  it("drops and adds when one dropped check matches several added ones", () => {
    const { sql } = diff(
      types({ checks: { a: "VALUE > 0" } }),
      types({ checks: { c: "VALUE > 0", d: "VALUE > 0" } }),
    );

    expect(sql).toContain(`drop constraint "a"`);
    expect(sql).not.toContain("rename");
  });

  it("drops and adds when the expression moves to another domain", () => {
    const { sql } = diff(checkedIn("a"), checkedIn("b"));

    expect(sql).toContain(`drop constraint "positive"`);
    expect(sql).toContain(`add constraint "positive"`);
    expect(sql).not.toContain("rename");
  });

  it("keeps a check that stays while another renames", () => {
    const { sql } = diff(
      types({ checks: { keep: "VALUE < 9", old: "VALUE > 0" } }),
      types({ checks: { keep: "VALUE < 9", fresh: "VALUE > 0" } }),
    );

    expect(sql).toBe(`alter domain "app"."posint" rename constraint "old" to "fresh";\n`);
  });
});

const hintsOf = (from: string[], to: string[]): readonly string[] =>
  diff(types({ labels: from }), types({ labels: to })).hints;

describe("the label rename hint", () => {
  it("names the entry when a label is removed and one added at its position", () => {
    expect(hintsOf(["a", "good", "z"], ["a", "great", "z"])).toStrictEqual([
      'enum "app"."mood" may rename the label "good" to "great": add renamedLabels: { "great": "good" } to its options',
    ]);
  });

  it("stays quiet when the position differs, or several labels change", () => {
    expect(hintsOf(["a", "good"], ["great", "a"])).toStrictEqual([]);
    expect(hintsOf(["a", "b"], ["c", "d"])).toStrictEqual([]);
    expect(hintsOf(["a", "b"], ["a"])).toStrictEqual([]);
    expect(hintsOf(["a"], ["a", "b"])).toStrictEqual([]);
  });
});
