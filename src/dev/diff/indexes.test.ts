import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type GeneratedPayload, type IndexPayload } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";
import { diff as diffWithHazards } from "./diff.ts";
import { key, plain, table, withIndex } from "./indexes.test-helper.ts";

const db = useTestDatabase();

/** Columns `a` and `s` under an index over both, where `s` takes each generation given. */
const withS = (generated: readonly GeneratedPayload[]) =>
  withIndex(generated, "t_a_s_idx", plain("a", "s"));

/** Columns `a` and `s` under an index on `a` that INCLUDEs `s`, which takes each generation given. */
const includingS = (generated: readonly GeneratedPayload[]) =>
  withIndex(generated, "ix", { ...plain("a"), include: ["s"] });

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("an index", () => {
  it("creates with its keys in order and leaves out what Postgres defaults", () => {
    expect(diff(table({}), table({ t_c_a_idx: plain("c", "a") }))).toBe(
      `create index "t_c_a_idx" on "public"."t" ("c", "a");\n`,
    );
  });

  it("creates a unique index with its method, orders, INCLUDE, and NULLS NOT DISTINCT", () => {
    const wanted: IndexPayload = {
      unique: true,
      method: "hash",
      keys: [key("a", true), key("b", true, false), key("c", false, true)],
      include: ["b", "a"],
      where: undefined,
      nullsNotDistinct: true,
    };

    expect(diff(table({}), table({ ix: wanted }))).toBe(
      `create unique index "ix" on "public"."t" using hash ("a" desc, "b" desc nulls last, "c" nulls first) include ("b", "a") nulls not distinct;\n`,
    );
  });

  it("drops by name in its schema", () => {
    expect(diff(table({ t_a_idx: plain("a") }), table({}))).toBe(
      `drop index "public"."t_a_idx";\n`,
    );
  });

  it("emits nothing for a table drop, which drops its indexes", () => {
    const empty = catalogBuilder();
    empty.schema("public");

    expect(diff(table({ t_a_idx: plain("a") }), empty.build())).toBe(`drop table "public"."t";\n`);
  });

  it("rebuilds when a key, an order, the method, uniqueness, INCLUDE, or the setting changes", () => {
    const from = table({ ix: plain("a", "b") });
    const rebuilt = (payload: IndexPayload) => diff(from, table({ ix: payload })).split("\n\n")[0];
    const drop = `drop index "public"."ix";`;

    expect(rebuilt(plain("a", "c"))).toBe(drop);
    expect(rebuilt(plain("b", "a"))).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), keys: [key("a", true), key("b")] })).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), keys: [key("a", false, true), key("b")] })).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), method: "hash" })).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), unique: true })).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), include: ["c"] })).toBe(drop);
    expect(rebuilt({ ...plain("a", "b"), nullsNotDistinct: true })).toBe(drop);
    expect(diff(from, table({ ix: plain("a", "b") }))).toBe("");
  });

  it("drops and adds back around a column it spans that Postgres can only rebuild", () => {
    const stored = { expression: "(a * 2)", storage: "stored" } as const;

    expect(diff(withS([]), withS([stored])).split("\n\n")).toStrictEqual([
      `drop index "public"."t_a_s_idx";`,
      `alter table "public"."t" drop column "s";`,
      `alter table "public"."t" add column "s" integer generated always as ((a * 2)) stored;`,
      `create index "t_a_s_idx" on "public"."t" ("a", "s");\n`,
    ]);
  });

  it("drops and adds back around a column it only INCLUDEs", () => {
    const stored = { expression: "(a * 2)", storage: "stored" } as const;

    expect(diff(includingS([]), includingS([stored])).split("\n\n")[0]).toBe(
      `drop index "public"."ix";`,
    );
  });

  it("is created after the column it names and dropped before the column goes", () => {
    const withoutB = catalogBuilder();
    withoutB.schema("public");
    withoutB.table("public", "t");
    withoutB.column("public", "t", "a", { type: "text", notNull: false });
    const bare = withoutB.build();
    const withB = table({ t_b_idx: plain("b") });

    expect(diff(bare, withB).split("\n\n").at(-1)).toBe(
      `create index "t_b_idx" on "public"."t" ("b");\n`,
    );
    expect(diff(withB, bare).split("\n\n")[0]).toBe(`drop index "public"."t_b_idx";`);
  });

  it("carries the share_lock Hazard on an existing table only, and none for a drop", () => {
    const { hazards, sql } = diffWithHazards(table({}), table({ ix: plain("a") }));

    expect(hazards).toStrictEqual([
      { kind: "share_lock", statement: `create index "ix" on "public"."t" ("a");` },
    ]);
    expect(sql).toBe(`-- hazard: share_lock\ncreate index "ix" on "public"."t" ("a");\n`);
    const empty = catalogBuilder();
    empty.schema("public");
    expect(diffWithHazards(empty.build(), table({ ix: plain("a") })).hazards).toStrictEqual([]);
    expect(diffWithHazards(table({ ix: plain("a") }), table({})).hazards).toStrictEqual([]);
  });

  it("carries the share_lock Hazard on a rebuilt index, and never CONCURRENTLY", () => {
    const { sql } = diffWithHazards(table({ ix: plain("a") }), table({ ix: plain("b") }));

    expect(sql).toBe(
      `drop index "public"."ix";\n\n-- hazard: share_lock\ncreate index "ix" on "public"."t" ("b");\n`,
    );
    expect(sql).not.toContain("concurrently");
  });
});

describe("against Postgres", () => {
  const options: Readonly<Record<string, IndexPayload>> = {
    t_a_idx: plain("a"),
    t_hash: { ...plain("b"), method: "hash" },
    t_unique: { ...plain("a", "b"), unique: true, include: ["c"] },
    t_order: {
      ...plain("a", "b", "c"),
      keys: [key("a", true), key("b", true, false), key("c", false, true)],
    },
    t_nnd: { ...plain("c"), unique: true, nullsNotDistinct: true },
  };

  it("creates every option and introspects back with no remaining diff", async () => {
    const wanted = table({ ...options });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const actual = await introspect(db.driver);
    expect(actual).toStrictEqual(wanted);
    expect(diff(actual, wanted)).toBe("");
  });

  it("rebuilds an index whose payload changed, and drops one the target lacks", async () => {
    await db.driver.execute(
      diff(await introspect(db.driver), table({ ix: plain("a"), gone: plain("b") })),
    );
    const wanted = table({ ix: { ...plain("a", "b"), unique: true } });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    expect(await introspect(db.driver)).toStrictEqual(wanted);
  });

  it("restores an index on a column Postgres can only rebuild", async () => {
    await db.driver.execute(`
      create table t (a integer, s integer);
      create index t_a_s_idx on t (a, s);`);
    const wanted = withS([{ expression: "(a * 3)", storage: "stored" }]);

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const after = await introspect(db.driver);
    expect(after).toStrictEqual(wanted);
    expect(diff(after, wanted)).toBe("");
  });
});
