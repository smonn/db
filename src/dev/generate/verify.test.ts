import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { DEFAULT_TRACKING_SCHEMA, trackingSchema } from "../../runtime/internal/index.ts";
import { catalogBuilder, type Catalog } from "../catalog/index.ts";
import { verifyInShadow } from "./verify.ts";

const db = useTestDatabase();
const tracking = trackingSchema(DEFAULT_TRACKING_SCHEMA);

function definition(): Catalog {
  const builder = catalogBuilder();
  builder.schema("public");
  builder.table("public", "users");
  builder.column("public", "users", "id", { type: "text", notNull: true });
  return builder.build();
}

beforeEach(async () => {
  await db.driver.execute("drop schema public cascade; create schema public;");
});

describe("verifyInShadow", () => {
  it("applies the SQL and passes when the Shadow then matches the Definition", async () => {
    await verifyInShadow(
      db.driver,
      "create table public.users (id text not null);",
      definition(),
      tracking,
    );

    expect(
      (await db.driver.query("select from information_schema.tables where table_name = 'users'"))
        .rows,
    ).toHaveLength(1);
  });

  it("names every fact that differs, is extra, or is missing", async () => {
    await expect(
      verifyInShadow(
        db.driver,
        `create table public."users.id" (id integer); create table public.users (id integer not null);`,
        definition(),
        tracking,
      ),
    ).rejects.toThrow(
      `the Current migration leaves the Shadow database unlike the Definition database:
  column "public"."users"."id" is {"type":"integer","notNull":true} in the Shadow database and {"type":"text","notNull":true} in the Definition database
  table "public"."users.id" is only in the Shadow database
  column "public"."users.id"."id" is only in the Shadow database`,
    );
  });

  it("names a fact missing from the Shadow", async () => {
    await expect(verifyInShadow(db.driver, "select 1;", definition(), tracking)).rejects.toThrow(
      `table "public"."users" is missing from the Shadow database
  column "public"."users"."id" is missing from the Shadow database`,
    );
  });
});
