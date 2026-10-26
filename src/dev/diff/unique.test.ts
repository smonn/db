import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  catalogBuilder,
  type Catalog,
  type GeneratedPayload,
  type UniquePayload,
} from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";
import { diff as diffWithHazards } from "./diff.ts";

const db = useTestDatabase();

/** A `public.t` table of NOT NULL text columns `a`, `b`, and `c`, with the named unique constraints. */
function table(uniques: Readonly<Record<string, UniquePayload>>): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  for (const name of ["a", "b", "c"]) {
    builder.column("public", "t", name, { type: "text", notNull: true });
  }
  for (const [name, payload] of Object.entries(uniques)) {
    builder.unique("public", "t", name, payload);
  }
  return builder.build();
}

/** Columns `a` and `s` under a unique over both, where `s` takes each generation given. */
function withS(generated: readonly GeneratedPayload[]): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  builder.column("public", "t", "a", { type: "integer", notNull: false });
  builder.column("public", "t", "s", { type: "integer", notNull: false });
  for (const payload of generated) builder.columnGenerated("public", "t", "s", payload);
  builder.unique("public", "t", "t_a_s_key", { columns: ["a", "s"], nullsNotDistinct: false });
  return builder.build();
}

const ab = { columns: ["a", "b"], nullsNotDistinct: false } as const;

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("a multi-column unique constraint", () => {
  it("adds with ALTER TABLE in the order of its columns", () => {
    const sql = diff(
      table({}),
      table({ t_c_a_key: { columns: ["c", "a"], nullsNotDistinct: false } }),
    );

    expect(sql).toBe(`alter table "public"."t" add constraint "t_c_a_key" unique ("c", "a");\n`);
  });

  it("adds NULLS NOT DISTINCT when the fact says so", () => {
    const sql = diff(table({}), table({ t_a_b_key: { ...ab, nullsNotDistinct: true } }));

    expect(sql).toBe(
      `alter table "public"."t" add constraint "t_a_b_key" unique nulls not distinct ("a", "b");\n`,
    );
  });

  it("drops by name", () => {
    expect(diff(table({ t_a_b_key: ab }), table({}))).toBe(
      `alter table "public"."t" drop constraint "t_a_b_key";\n`,
    );
  });

  it("rebuilds when the column list, its order, or nullsNotDistinct changes", () => {
    const from = table({ t_u: ab });
    const rebuilt = (payload: UniquePayload) =>
      diff(from, table({ t_u: payload })).split("\n\n")[0];

    expect(rebuilt({ columns: ["a", "c"], nullsNotDistinct: false })).toBe(
      `alter table "public"."t" drop constraint "t_u";`,
    );
    expect(rebuilt({ columns: ["b", "a"], nullsNotDistinct: false })).toBe(
      `alter table "public"."t" drop constraint "t_u";`,
    );
    expect(rebuilt({ columns: ["a", "b"], nullsNotDistinct: true })).toBe(
      `alter table "public"."t" drop constraint "t_u";`,
    );
    expect(diff(from, table({ t_u: ab }))).toBe("");
  });

  it("drops and adds back around a column it spans that Postgres can only rebuild", () => {
    const stored = { expression: "(a * 2)", storage: "stored" } as const;

    expect(diff(withS([]), withS([stored])).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_a_s_key";`,
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) stored;`,
      `alter table "public"."t" add constraint "t_a_s_key" unique ("a", "s");\n`,
    ]);
  });

  it("carries the index-build lock Hazard on an existing table only", () => {
    const { hazards } = diffWithHazards(table({}), table({ t_a_b_key: ab }));

    expect(hazards.map(({ kind }) => kind)).toStrictEqual(["access_exclusive_lock"]);
    const empty = catalogBuilder();
    empty.schema("public");
    expect(diffWithHazards(empty.build(), table({ t_a_b_key: ab })).hazards).toStrictEqual([]);
  });
});

describe("against Postgres", () => {
  it("creates multi-column uniques and introspects back with no remaining diff", async () => {
    const wanted = table({
      t_a_b_key: ab,
      t_c_b_key: { columns: ["c", "b"], nullsNotDistinct: true },
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const actual = await introspect(db.driver);
    expect(actual).toStrictEqual(wanted);
    expect(diff(actual, wanted)).toBe("");
  });

  it("rebuilds a unique constraint whose column list changed", async () => {
    await db.driver.execute(diff(await introspect(db.driver), table({ t_u: ab })));
    const wanted = table({ t_u: { columns: ["b", "c"], nullsNotDistinct: false } });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });
});
