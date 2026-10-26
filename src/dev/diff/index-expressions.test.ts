import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import type { IndexPayload } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";
import { plain, table } from "./indexes.test-helper.ts";

const db = useTestDatabase();

const ascending = { descending: false, nullsFirst: false };

/** An index on `lower(b)` then the extra keys, over the rows `where` holds for. */
const lowered = (where?: string, ...rest: IndexPayload["keys"]): IndexPayload => ({
  unique: false,
  method: "btree",
  keys: [{ expression: "lower(b)", ...ascending }, ...rest],
  include: [],
  where,
  nullsNotDistinct: false,
});

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("an index with an expression key or a predicate", () => {
  it("creates an expression key in its own parentheses, beside a plain key and with its order", () => {
    const wanted = lowered(undefined, { column: "c", descending: true, nullsFirst: false });
    const sum = { expression: "a || b", descending: true, nullsFirst: false };

    expect(diff(table({}), table({ ix: wanted, iy: { ...wanted, keys: [sum] } }))).toBe(
      `create index "ix" on "public"."t" ((lower(b)), "c" desc nulls last);\n\ncreate index "iy" on "public"."t" ((a || b) desc nulls last);\n`,
    );
  });

  it("creates a partial index with its predicate last", () => {
    const wanted = { ...lowered("b IS NULL"), unique: true, include: ["c"] };

    expect(diff(table({}), table({ ix: wanted }))).toBe(
      `create unique index "ix" on "public"."t" ((lower(b))) include ("c") where b IS NULL;\n`,
    );
  });

  it("rebuilds when an expression key or the predicate changes, and only then", () => {
    const from = table({ ix: lowered("c IS NULL") });
    const rebuilt = (payload: IndexPayload) => diff(from, table({ ix: payload })).split("\n\n")[0];
    const drop = `drop index "public"."ix";`;
    const upper = { expression: "upper(b)", ...ascending };

    expect(rebuilt(lowered("c IS NOT NULL"))).toBe(drop);
    expect(rebuilt(lowered(undefined))).toBe(drop);
    expect(rebuilt({ ...lowered("c IS NULL"), keys: [upper] })).toBe(drop);
    expect(rebuilt({ ...lowered("c IS NULL"), keys: [{ column: "b", ...ascending }] })).toBe(drop);
    expect(diff(from, table({ ix: lowered("c IS NULL") }))).toBe("");
  });

  it("creates in Postgres and introspects back with no remaining diff", async () => {
    const wanted = table({
      t_expr: lowered("a IS NOT NULL", { column: "c", descending: true, nullsFirst: true }),
      t_partial: { ...plain("b"), unique: true, where: "c IS NOT NULL" },
    });

    await db.driver.execute(diff(await introspect(db.driver), wanted));

    const actual = await introspect(db.driver);
    expect(actual).toStrictEqual(wanted);
    expect(diff(actual, wanted)).toBe("");
  });
});
