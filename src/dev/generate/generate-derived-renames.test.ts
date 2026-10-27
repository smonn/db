import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate, type GenerateResult } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

async function generateFrom(
  committed: string,
  definition: Parameters<typeof generate>[0]["definition"],
): Promise<GenerateResult> {
  const files = filesIn("db/migrations", [
    await writeMigration("000001-create.sql", undefined, committed),
  ]);
  return generate(generateOptions(db, memoryFileSystem(files), definition));
}

const ORGS = "create table public.orgs (id integer primary key);";

const SHOP = `${ORGS}
create table public.users (
  id integer generated always as identity primary key,
  email text not null unique,
  org_id integer references public.orgs (id),
  tag text
);
create index users_tag_idx on public.users (tag);`;

function orgs() {
  return defineTable((c) => ({ id: c.integer().primaryKey() }));
}

function renamedPeople(org: ReturnType<typeof orgs>) {
  return defineTable(
    (c) => ({
      id: c.integer().identity("always").primaryKey(),
      email: c.text().notNull().unique(),
      org_id: c.integer().references(() => org.columns.id),
      tag: c.text().index(),
    }),
    () => ({ renamedFrom: "users" }),
  );
}

describe("derived names after a table rename", () => {
  it("renames the key, unique, foreign key, index, and identity sequence it derives names from", async () => {
    const org = orgs();
    const result = await generateFrom(
      SHOP,
      defineDatabase({ public: { orgs: org, people: renamedPeople(org) } }),
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "public"."users" rename to "people";`,
      `alter table "public"."people" rename constraint "users_pkey" to "people_pkey";`,
      `alter table "public"."people" rename constraint "users_email_key" to "people_email_key";`,
      `alter table "public"."people" rename constraint "users_org_id_fkey" to "people_org_id_fkey";`,
      `alter index "public"."users_tag_idx" rename to "people_tag_idx";`,
      `alter sequence "public"."users_id_seq" rename to "people_id_seq";`,
    ]);
    expect(result.hazards.map(({ kind }) => kind)).toStrictEqual(["rename"]);
  });

  it("falls back to a drop and add when two candidates share a payload", async () => {
    const committed = `${ORGS}
create table public.users (id integer primary key, tag text);
create index a_idx on public.users (tag);
create index b_idx on public.users (tag);`;
    const users = defineTable(
      (c) => ({ id: c.integer().primaryKey(), tag: c.text() }),
      (t) => ({
        indexes: [
          { columns: [t.tag], name: "c_idx" },
          { columns: [t.tag], name: "d_idx" },
        ],
      }),
    );
    const result = await generateFrom(
      committed,
      defineDatabase({ public: { orgs: orgs(), users } }),
    );

    expect(result.sql).toContain(`drop index "public"."a_idx"`);
    expect(result.sql).toContain(`drop index "public"."b_idx"`);
    expect(result.sql).toContain(`create index "c_idx"`);
    expect(result.sql).not.toContain("rename");
  });
});

describe("derived names after a column rename", () => {
  it("renames the index, unique, and foreign key named after the column, with no drop", async () => {
    const committed = `${ORGS}
create table public.users (
  id integer generated always as identity primary key,
  org integer references public.orgs (id),
  handle text unique,
  tag text
);
create index users_tag_idx on public.users (tag);`;
    const org = orgs();
    const users = defineTable((c) => ({
      id: c.integer().identity("always").primaryKey(),
      org_id: c
        .integer()
        .references(() => org.columns.id)
        .renamedFrom("org"),
      handle_name: c.text().unique().renamedFrom("handle"),
      label: c.text().index().renamedFrom("tag"),
    }));
    const result = await generateFrom(committed, defineDatabase({ public: { orgs: org, users } }));

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "public"."users" rename column "org" to "org_id";`,
      `-- hazard: rename\nalter table "public"."users" rename column "handle" to "handle_name";`,
      `-- hazard: rename\nalter table "public"."users" rename column "tag" to "label";`,
      `alter table "public"."users" rename constraint "users_handle_key" to "users_handle_name_key";`,
      `alter table "public"."users" rename constraint "users_org_fkey" to "users_org_id_fkey";`,
      `alter index "public"."users_tag_idx" rename to "users_label_idx";`,
    ]);
    expect(result.sql).not.toContain("drop");
  });

  it("renames the identity sequence of a renamed identity column", async () => {
    const users = defineTable((c) => ({
      uid: c.integer().identity("always").primaryKey().renamedFrom("id"),
    }));
    const result = await generateFrom(
      "create table public.users (id integer generated always as identity primary key);",
      defineDatabase({ public: { users } }),
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      `-- hazard: rename\nalter table "public"."users" rename column "id" to "uid";`,
      `alter sequence "public"."users_id_seq" rename to "users_uid_seq";`,
    ]);
  });
});
