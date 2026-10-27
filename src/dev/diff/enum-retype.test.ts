import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff } from "./bare-sql.test-helper.ts";
import { diff } from "./diff.ts";

const db = useTestDatabase();

/** Enums `mood` and `feeling`, and a `users` table whose column `c` has `type`. */
function catalog(type: string): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.enumType("public", "mood", { labels: ["a", "b"] });
  builder.enumType("public", "feeling", { labels: ["a", "c"] });
  builder.table("public", "users");
  builder.column("public", "users", "c", { type, notNull: false });
  return builder.build();
}

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

/** Builds a database holding `from`, inserts `row`, and runs the diff to `to` against it. */
async function migrate(from: string, to: string, row: string): Promise<string> {
  await db.driver.execute(bareDiff(await introspect(db.driver), catalog(from)));
  await db.driver.execute(`insert into users values (${row})`);
  const { sql } = diff(await introspect(db.driver), catalog(to));
  await db.driver.execute(sql);
  return sql;
}

describe("a retype to an enum", () => {
  it.each([
    ["text", "public.mood", `'a'`],
    ["public.mood", "public.feeling", `'a'`],
    ["text[]", "public.mood[]", `'{a,b}'`],
    ["public.mood[]", "public.feeling[]", `'{a,a}'`],
  ])("casts %s to %s through text, so Postgres accepts it", async (from, to, row) => {
    const sql = await migrate(from, to, row);

    expect(sql).toContain(`alter column "c" type ${to} using "c"::text::${to};`);
    expect(diff(await introspect(db.driver), catalog(to)).sql).toBe("");
  });

  it("keeps the rewrite hazard", async () => {
    await db.driver.execute(bareDiff(await introspect(db.driver), catalog("text")));

    const { hazards } = diff(await introspect(db.driver), catalog("public.mood"));

    expect(hazards.map(({ kind }) => kind)).toStrictEqual(["rewrite", "access_exclusive_lock"]);
  });

  it("leaves a retype away from an enum without a USING", async () => {
    const sql = await migrate("public.mood", "text", `'a'`);

    expect(sql).not.toContain("using");
  });

  it.each([
    ["integer", "public.mood"],
    ["text", "public.mood[]"],
    ["public.mood[]", "public.mood"],
    ["text[]", "text"],
  ])("writes no USING for %s to %s, which needs a hand edit", (from, to) => {
    expect(diff(catalog(from), catalog(to)).sql).not.toContain("using");
  });
});
