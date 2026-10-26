import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import {
  defineDatabase,
  defineTable,
  type ForeignKeyOptions,
  type Target,
} from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

const CURRENT = "db/migrations/current.sql";

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db, auth cascade; drop schema public cascade; create schema public;",
  );
});

async function committed(sql: string) {
  return memoryFileSystem({
    ...filesIn("db/migrations", [await writeMigration("000001-create-tables.sql", undefined, sql)]),
  });
}

function run(fileSystem: ReturnType<typeof memoryFileSystem>, definition: Definition) {
  return generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });
}

type Definition = Parameters<typeof generate>[0]["definition"];

/** `users (id)` and `orders (id, user_id)`, where `user_id` points at `users` with the options. */
function shop(options?: ForeignKeyOptions, pointing = true) {
  const users = defineTable((c) => ({ id: c.integer().primaryKey() }));
  const orders = defineTable((c) => ({
    id: c.integer().primaryKey(),
    user_id: pointing ? c.integer().references(() => users.columns.id, options) : c.integer(),
  }));
  return defineDatabase({ public: { users, orders } });
}

const TABLES = `create table public.users (id integer primary key);
create table public.orders (id integer primary key, user_id integer);
`;

describe("generating foreign keys", () => {
  it("creates tables that point at each other, and verifies the Shadow database matches", async () => {
    const accounts = defineTable((c) => ({
      id: c.integer().primaryKey(),
      owner_id: c.integer().references((): Target<number> => people.columns.id),
    }));
    const people = defineTable((c) => ({
      id: c.integer().primaryKey(),
      account_id: c
        .integer()
        .references(() => accounts.columns.id, { onDelete: "cascade", deferrable: "deferred" }),
    }));

    const result = await run(memoryFileSystem(), defineDatabase({ public: { accounts, people } }));

    expect(result.sql).toBe(`create table "public"."accounts" (
  "id" integer not null,
  "owner_id" integer
);

create table "public"."people" (
  "id" integer not null,
  "account_id" integer
);

alter table "public"."accounts" add constraint "accounts_pkey" primary key ("id");

alter table "public"."people" add constraint "people_pkey" primary key ("id");

alter table "public"."accounts" add constraint "accounts_owner_id_fkey" foreign key ("owner_id") references "public"."people" ("id");

alter table "public"."people" add constraint "people_account_id_fkey" foreign key ("account_id") references "public"."accounts" ("id") on delete cascade deferrable initially deferred;
`);
    expect(result.hazards).toStrictEqual([]);
  });

  it("finds no difference from a Committed migration that adds it with Postgres's name", async () => {
    const fileSystem = await committed(`create table public.users (id integer primary key);
create table public.orders (id integer primary key, user_id integer references public.users (id));
`);

    expect(await run(fileSystem, shop())).toStrictEqual({
      path: CURRENT,
      sql: undefined,
      reset: true,
      hazards: [],
    });
  });

  it("adds one to existing tables with the lock Hazard, and verifies the Shadow database", async () => {
    const result = await run(await committed(TABLES), shop({ onDelete: "set null" }));

    const statement = `alter table "public"."orders" add constraint "orders_user_id_fkey" foreign key ("user_id") references "public"."users" ("id") on delete set null;`;
    expect(result.sql).toBe(`-- hazard: share_row_exclusive_lock\n${statement}\n`);
    expect(result.hazards).toStrictEqual([{ kind: "share_row_exclusive_lock", statement }]);
  });

  it("drops one that the Definition stops declaring", async () => {
    const fileSystem = await committed(`create table public.users (id integer primary key);
create table public.orders (id integer primary key, user_id integer references public.users (id));
`);

    const result = await run(fileSystem, shop(undefined, false));

    expect(result.sql).toBe(
      `alter table "public"."orders" drop constraint "orders_user_id_fkey";\n`,
    );
  });

  it("drops it and adds it back when an action changes", async () => {
    const fileSystem = await committed(`create table public.users (id integer primary key);
create table public.orders (
  id integer primary key,
  user_id integer references public.users (id) on delete cascade
);
`);

    const result = await run(fileSystem, shop({ onDelete: "restrict", onUpdate: "cascade" }));

    expect(result.sql?.split("\n\n")).toStrictEqual([
      `alter table "public"."orders" drop constraint "orders_user_id_fkey";`,
      `-- hazard: share_row_exclusive_lock\nalter table "public"."orders" add constraint "orders_user_id_fkey" foreign key ("user_id") references "public"."users" ("id") on delete restrict on update cascade;\n`,
    ]);
  });

  it("drops each foreign key before any of the tables, whichever drops first", async () => {
    const fileSystem = await committed(`create table public.users (id integer primary key);
create table public.orders (id integer primary key, user_id integer references public.users (id));
create table public.audit (id integer primary key, user_id integer references public.users (id));
`);

    const result = await run(fileSystem, defineDatabase({ public: {} }));

    const statements = String(result.sql)
      .split("\n")
      .filter((line) => /^(alter|drop) /u.test(line));
    expect(statements).toStrictEqual([
      `alter table "public"."audit" drop constraint "audit_user_id_fkey";`,
      `alter table "public"."orders" drop constraint "orders_user_id_fkey";`,
      `drop table "public"."audit";`,
      `drop table "public"."orders";`,
      `drop table "public"."users";`,
    ]);
  });

  it("drops a foreign key before the primary key it needs, in the same migration", async () => {
    const fileSystem = await committed(`create table public.users (id integer primary key);
create table public.orders (id integer primary key, user_id integer references public.users (id));
`);
    const users = defineTable((c) => ({ id: c.integer().notNull() }));
    const orders = defineTable((c) => ({ id: c.integer().primaryKey(), user_id: c.integer() }));

    const result = await run(fileSystem, defineDatabase({ public: { users, orders } }));

    expect(result.sql?.split("\n\n")).toStrictEqual([
      `alter table "public"."orders" drop constraint "orders_user_id_fkey";`,
      `alter table "public"."users" drop constraint "users_pkey";\n`,
    ]);
  });

  it("points at a table in another schema, and at a unique column", async () => {
    const people = defineTable((c) => ({ id: c.integer().primaryKey(), email: c.text().unique() }));
    const orders = defineTable((c) => ({
      email: c.text().references(() => people.columns.email, { name: "orders_buyer" }),
    }));

    const result = await run(
      memoryFileSystem(),
      defineDatabase({ auth: { people }, public: { orders } }),
    );

    expect(result.sql).toContain(
      `alter table "public"."orders" add constraint "orders_buyer" foreign key ("email") references "auth"."people" ("email");`,
    );
  });
});
