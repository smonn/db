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

  it("names the Unmodeled object that blocks a drop (2BP01)", async () => {
    await db.driver.execute(
      "create table public.users (id text not null); create view public.user_ids as select id from public.users;",
    );

    await expect(
      verifyInShadow(db.driver, "drop table public.users;", definition(), tracking),
    ).rejects.toThrow(
      /cannot drop table users because other objects depend on it.*\n {2}view user_ids depends on table users\n.*by hand/su,
    );
  });

  it("names the column and points to the hand edit when a type change needs USING (42804)", async () => {
    await db.driver.execute("create table public.users (id text not null);");

    await expect(
      verifyInShadow(
        db.driver,
        "alter table public.users alter column id type integer;",
        definition(),
        tracking,
      ),
    ).rejects.toThrow(
      /column "id" cannot be cast automatically.*Edit the Current migration by hand/su,
    );
  });

  it("passes other SQL errors through", async () => {
    await expect(
      verifyInShadow(db.driver, "select * from public.nope;", definition(), tracking),
    ).rejects.toThrow(/relation "public.nope" does not exist/u);
  });

  it("names a fact missing from the Shadow", async () => {
    await expect(verifyInShadow(db.driver, "select 1;", definition(), tracking)).rejects.toThrow(
      `table "public"."users" is missing from the Shadow database
  column "public"."users"."id" is missing from the Shadow database`,
    );
  });
});
