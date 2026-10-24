import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { introspect } from "../introspect/index.ts";
import { bareDiff as diff } from "./bare-sql.test-helper.ts";

const db = useTestDatabase();

type Kind = "primary key" | "unique";

/** A `public.t` table of one NOT NULL text column `a`, with constraint `t_key` of the given kind. */
function table(kind: Kind): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "t");
  builder.column("public", "t", "a", { type: "text", notNull: true });
  if (kind === "primary key") builder.primaryKey("public", "t", "t_key", { columns: ["a"] });
  else builder.unique("public", "t", "t_key", { column: "a" });
  return builder.build();
}

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public");
});

describe("a key that changes kind at the same constraint name", () => {
  it("drops a unique constraint, then adds a primary key", () => {
    expect(diff(table("unique"), table("primary key")).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_key";`,
      `alter table "public"."t" add constraint "t_key" primary key ("a");\n`,
    ]);
  });

  it("drops a primary key, then adds a unique constraint", () => {
    expect(diff(table("primary key"), table("unique")).split("\n\n")).toStrictEqual([
      `alter table "public"."t" drop constraint "t_key";`,
      `alter table "public"."t" add constraint "t_key" unique ("a");\n`,
    ]);
  });

  it("round-trips on Postgres from unique to primary key and back", async () => {
    await db.driver.execute(diff(await introspect(db.driver), table("unique")));

    await db.driver.execute(diff(await introspect(db.driver), table("primary key")));
    expect(await introspect(db.driver)).toStrictEqual(table("primary key"));

    await db.driver.execute(diff(await introspect(db.driver), table("unique")));
    expect(await introspect(db.driver)).toStrictEqual(table("unique"));
    expect(diff(await introspect(db.driver), table("unique"))).toBe("");
  });
});
