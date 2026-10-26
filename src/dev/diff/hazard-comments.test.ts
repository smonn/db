import { describe, expect, it } from "vitest";
import { catalogBuilder, type Catalog, type CatalogBuilder } from "../catalog/index.ts";
import { diff } from "./diff.ts";
import type { HazardKind } from "./hazards.ts";

type Column = {
  readonly type?: string;
  readonly notNull?: boolean;
  readonly default?: { readonly expression: string; readonly volatile: boolean };
  readonly identity?: "always" | "by default";
};

type Keys = { readonly primary?: readonly string[]; readonly unique?: string };

function addAttributes(builder: CatalogBuilder, name: string, column: Column): void {
  if (column.identity !== undefined) {
    builder.columnIdentity("public", "t", name, { generated: column.identity });
  }
  if (column.default !== undefined) builder.columnDefault("public", "t", name, column.default);
}

function table(columns: Readonly<Record<string, Column>>, keys: Keys = {}): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const [name, column] of Object.entries(columns)) {
    builder.column("public", "t", name, {
      type: column.type ?? "text",
      notNull: column.notNull ?? false,
    });
    addAttributes(builder, name, column);
  }
  if (keys.primary !== undefined) {
    builder.primaryKey("public", "t", "t_pkey", { columns: keys.primary });
  }
  if (keys.unique !== undefined)
    builder.unique("public", "t", "t_u_key", { columns: [keys.unique], nullsNotDistinct: false });
  return builder.build();
}

const empty = catalogBuilder().build();

function kinds(from: Catalog, to: Catalog): HazardKind[] {
  return diff(from, to).hazards.map((hazard) => hazard.kind);
}

const REWRITE: HazardKind[] = ["rewrite", "access_exclusive_lock"];

describe("data_loss", () => {
  it("flags a dropped column and a dropped table", () => {
    expect(kinds(table({ a: {}, b: {} }), table({ a: {} }))).toStrictEqual(["data_loss"]);
    expect(kinds(table({ a: {} }), empty)).toStrictEqual(["data_loss"]);
  });

  it("flags a renamed column, which drops and adds", () => {
    expect(kinds(table({ old: {} }), table({ fresh: {} }))).toStrictEqual(["data_loss"]);
  });

  it("flags a conversion that rounds", () => {
    const from = table({ a: { type: "numeric(10,2)" } });
    const to = table({ a: { type: "integer" } });

    expect(kinds(from, to)).toStrictEqual(["data_loss", ...REWRITE]);
  });

  it("doesn't flag dropping a default, an identity, a NOT NULL, or a key", () => {
    const from = table(
      {
        a: { default: { expression: "1", volatile: false }, notNull: true },
        b: { identity: "always", notNull: true },
        c: { notNull: true },
      },
      { primary: ["c"], unique: "a" },
    );
    const to = table({ a: {}, b: {}, c: {} });

    expect(kinds(from, to)).toStrictEqual([]);
  });
});

describe("dropping a schema", () => {
  it("puts data_loss on the drop table, not on the drop schema, of a schema that holds a table", () => {
    const { sql, hazards } = diff(table({ a: {} }), empty);

    expect(sql).toBe(`-- hazard: data_loss\ndrop table "public"."t";\n\ndrop schema "public";\n`);
    expect(hazards).toStrictEqual([{ kind: "data_loss", statement: `drop table "public"."t";` }]);
  });

  it("flags nothing for an empty schema", () => {
    const builder = catalogBuilder();
    builder.schema("public");
    const { sql, hazards } = diff(builder.build(), empty);

    expect(sql).toBe(`drop schema "public";\n`);
    expect(hazards).toStrictEqual([]);
  });
});

describe("rewrite", () => {
  it("flags a type change that rewrites, with the lock it holds", () => {
    expect(
      kinds(table({ a: { type: "integer" } }), table({ a: { type: "bigint" } })),
    ).toStrictEqual(REWRITE);
  });

  it("passes a type change Postgres makes in place", () => {
    const from = table({ a: { type: "character varying(5)" } });
    const to = table({ a: { type: "character varying(10)" } });

    expect(kinds(from, to)).toStrictEqual([]);
  });

  it("reads the type before the change from the source catalog, not the target", () => {
    const widen = kinds(
      table({ a: { type: "character varying(5)" } }),
      table({ a: { type: "text" } }),
    );
    const narrow = kinds(
      table({ a: { type: "text" } }),
      table({ a: { type: "character varying(5)" } }),
    );

    expect(widen).toStrictEqual([]);
    expect(narrow).toStrictEqual(REWRITE);
  });

  it("flags a new column whose default is volatile, or that is an identity", () => {
    const from = table({});
    const volatile = { expression: "random()", volatile: true };

    expect(
      kinds(from, table({ a: { type: "double precision", default: volatile } })),
    ).toStrictEqual(REWRITE);
    expect(kinds(from, table({ a: { type: "integer", identity: "always" } }))).toStrictEqual(
      REWRITE,
    );
  });

  it("passes a new column with no default or a non-volatile one", () => {
    const from = table({});
    const stable = { expression: "now()", volatile: false };

    expect(kinds(from, table({ a: {} }))).toStrictEqual([]);
    expect(kinds(from, table({ a: { default: stable } }))).toStrictEqual([]);
  });

  it("passes a volatile default on a column of a new table, which has no rows", () => {
    const to = table({
      a: { type: "uuid", default: { expression: "gen_random_uuid()", volatile: true } },
    });

    expect(kinds(empty, to)).toStrictEqual([]);
  });

  it("passes setting or changing a default, since existing rows keep their values", () => {
    const from = table({ a: {} });
    const to = table({ a: { default: { expression: "random()::text", volatile: true } } });

    expect(kinds(from, to)).toStrictEqual([]);
  });
});

describe("access_exclusive_lock", () => {
  it("flags SET NOT NULL, which reads every row", () => {
    expect(kinds(table({ a: {} }), table({ a: { notNull: true } }))).toStrictEqual([
      "access_exclusive_lock",
    ]);
  });

  it("passes DROP NOT NULL, which only changes the catalog", () => {
    expect(kinds(table({ a: { notNull: true } }), table({ a: {} }))).toStrictEqual([]);
  });

  it("flags a key added to an existing table, which builds an index", () => {
    const from = table({ a: { notNull: true } });

    expect(kinds(from, table({ a: { notNull: true } }, { primary: ["a"] }))).toStrictEqual([
      "access_exclusive_lock",
    ]);
    expect(kinds(from, table({ a: { notNull: true } }, { unique: "a" }))).toStrictEqual([
      "access_exclusive_lock",
    ]);
  });

  it("flags a key rebuilt on an existing table once, for the add", () => {
    const from = table({ a: { notNull: true }, b: { notNull: true } }, { primary: ["a"] });
    const to = table({ a: { notNull: true }, b: { notNull: true } }, { primary: ["b"] });

    expect(kinds(from, to)).toStrictEqual(["access_exclusive_lock"]);
  });

  it("passes a key on a table created in the same migration, which is empty", () => {
    const to = table({ a: { notNull: true } }, { primary: ["a"], unique: "a" });

    expect(kinds(empty, to)).toStrictEqual([]);
  });

  it("passes adding an identity, and setting a default", () => {
    const from = table({ a: { type: "integer", notNull: true }, b: {} });
    const to = table({
      a: { type: "integer", notNull: true, identity: "always" },
      b: { default: { expression: "'x'::text", volatile: false } },
    });

    expect(kinds(from, to)).toStrictEqual([]);
  });
});

describe("hazard comments", () => {
  it("writes one comment per kind above its statement and returns the same statement", () => {
    const { sql, hazards } = diff(
      table({ a: { type: "integer" } }),
      table({ a: { type: "bigint", notNull: true } }),
    );

    const retype = `alter table "public"."t" alter column "a" type bigint;`;
    const notNull = `alter table "public"."t" alter column "a" set not null;`;
    expect(sql).toBe(
      `-- hazard: rewrite\n-- hazard: access_exclusive_lock\n${retype}\n\n` +
        `-- hazard: access_exclusive_lock\n${notNull}\n`,
    );
    expect(hazards).toStrictEqual([
      { kind: "rewrite", statement: retype },
      { kind: "access_exclusive_lock", statement: retype },
      { kind: "access_exclusive_lock", statement: notNull },
    ]);
  });

  it("writes none for a diff without Hazards", () => {
    expect(diff(table({}), table({ a: {} }))).toStrictEqual({
      sql: `alter table "public"."t" add column "a" text;\n`,
      hazards: [],
      hints: [],
    });
  });
});
