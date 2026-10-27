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
      /cannot drop table users because other objects depend on it:\n {2}view user_ids depends on table users\nGenerate never uses CASCADE.*Hand edit the Current migration/su,
    );
  });

  it("offers a USING clause or a default change when a type change can't be cast (42804)", async () => {
    await db.driver.execute("create table public.users (id text not null);");

    await expect(
      verifyInShadow(
        db.driver,
        "alter table public.users alter column id type integer;",
        definition(),
        tracking,
      ),
    ).rejects.toThrow(
      /column "id" cannot be cast automatically.*\nGenerate writes a plain ALTER COLUMN \.\.\. TYPE with no USING.*add a USING clause or change the column's default/su,
    );
  });

  it("keeps the hint true when a default that can't be cast raises 42804", async () => {
    await db.driver.execute("create table public.users (id text not null default '1');");

    const failure = verifyInShadow(
      db.driver,
      "alter table public.users alter column id type integer using id::integer;",
      definition(),
      tracking,
    );
    await expect(failure).rejects.toThrow(/default for column "id" cannot be cast automatically/u);
    await expect(failure).rejects.toThrow(/or change the column's default/u);
  });

  it("names the view and column when a type change alters a column a view uses (0A000)", async () => {
    await db.driver.execute(
      "create table public.users (id text not null); create view public.user_ids as select id from public.users;",
    );

    await expect(
      verifyInShadow(
        db.driver,
        "alter table public.users alter column id type varchar;",
        definition(),
        tracking,
      ),
    ).rejects.toThrow(
      /cannot alter type of a column used by a view or rule:\n.*view user_ids depends on column "id".*\nGenerate never uses CASCADE, so another object.*Hand edit the Current migration/su,
    );
  });

  it("names the rule when a rule uses the column (0A000)", async () => {
    await db.driver.execute(
      "create table public.users (id text not null); create rule log_users as on insert to public.users do also select new.id;",
    );

    await expect(
      verifyInShadow(
        db.driver,
        "alter table public.users alter column id type varchar;",
        definition(),
        tracking,
      ),
    ).rejects.toThrow(
      /used by a view or rule:\n {2}rule log_users on table users depends on column "id"/u,
    );
  });

  it("passes a 0A000 for a column used in a policy or trigger through unchanged", async () => {
    await db.driver.execute(
      `create table public.users (id text not null);
       create policy own on public.users using (id <> '');
       create function public.noop() returns trigger language plpgsql as 'begin return new; end';
       create table public.audited (id text not null);
       create trigger audit before update of id on public.audited for each row execute function public.noop();`,
    );

    for (const table of ["users", "audited"]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- one failure per table.
      await expect(
        verifyInShadow(
          db.driver,
          `alter table public.${table} alter column id type varchar;`,
          definition(),
          tracking,
        ),
      ).rejects.toThrow(/^cannot alter type of a column used in a (?:policy|trigger) definition$/u);
    }
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
