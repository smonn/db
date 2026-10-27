import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate, type GenerateOptions, type GenerateResult } from "./generate.ts";
import { generateOptions } from "./generate-options.test-helper.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

/** Generates `definition` against one Committed migration running `committed`. */
async function generateFrom(
  committed: string,
  definition: GenerateOptions["definition"],
): Promise<GenerateResult> {
  const migration = await writeMigration("000001-create.sql", undefined, committed);
  return generate(
    generateOptions(db, memoryFileSystem(filesIn("db/migrations", [migration])), definition),
  );
}

const HINT =
  "Generate never uses CASCADE or alters an Unmodeled object. Hand edit the Current migration to drop or change each one before the statement it blocks.";

describe("the scan for Unmodeled blockers", () => {
  it("names every blocker of every drop and retype in one run, before verification", async () => {
    const committed = `
      create table public.users (id integer not null, email text);
      create view public.emails as select email from public.users;
      create view public.emails_again as select * from public.emails;
      create table public.orders (id integer not null, total numeric);
      create function public.noop() returns trigger language plpgsql as 'begin return new; end';
      create trigger audit before update of total on public.orders
        for each row execute function public.noop();
      create policy positive on public.orders using (total > 0);`;

    await expect(
      generateFrom(
        committed,
        defineDatabase({
          public: {
            users: defineTable((c) => ({ id: c.integer().notNull() })),
            orders: defineTable((c) => ({ id: c.integer().notNull(), total: c.integer() })),
          },
        }),
      ),
    ).rejects.toThrow(
      new Error(`Unmodeled objects block what the Current migration drops or retypes:
  table column public.users.email, which it drops:
    view public.emails
    view public.emails_again
  table column public.orders.total, which it retypes:
    policy positive on public.orders
    trigger audit on public.orders
${HINT}`),
    );
  });

  it("names a foreign key that introspect skips as Unmodeled", async () => {
    const committed = `
      create table public.users (id integer not null, email text unique);
      create table public.orders (id integer not null, user_email text);
      alter table public.orders add constraint orders_email_fk
        foreign key (user_email) references public.users (email) not enforced;`;

    await expect(
      generateFrom(
        committed,
        defineDatabase({
          public: {
            users: defineTable((c) => ({ id: c.integer().notNull(), email: c.text() })),
            orders: defineTable((c) => ({ id: c.integer().notNull(), user_email: c.text() })),
          },
        }),
      ),
    ).rejects.toThrow(
      `  table constraint users_email_key on public.users, which it drops:\n    table constraint orders_email_fk on public.orders\n`,
    );
  });

  it("skips a dependent the plan drops itself, and verifies as before", async () => {
    const committed = `
      create table public.users (id integer primary key);
      create table public.orders (id integer not null, user_id integer references public.users (id));`;

    const result = await generateFrom(
      committed,
      defineDatabase({
        public: {
          orders: defineTable((c) => ({ id: c.integer().notNull(), user_id: c.integer() })),
        },
      }),
    );

    expect(result.sql?.trimEnd().split("\n\n")).toStrictEqual([
      'alter table "public"."orders" drop constraint "orders_user_id_fkey";',
      '-- hazard: data_loss\ndrop table "public"."users";',
    ]);
  });

  it("retypes a column whose generated dependent the plan drops the expression of", async () => {
    const committed = `
      create table public.users (id integer not null, name text,
        upper_name text generated always as (upper(name)) stored);`;

    const result = await generateFrom(
      committed,
      defineDatabase({
        public: {
          users: defineTable((c) => ({
            id: c.integer().notNull(),
            name: c.varchar(40),
            upper_name: c.text(),
          })),
        },
      }),
    );

    expect(result.sql).toContain(
      'alter table "public"."users" alter column "upper_name" drop expression;',
    );
    expect(result.sql).toContain('alter table "public"."users" alter column "name" type');
  });

  it("scans the Shadow with the declared renames run", async () => {
    const committed = `
      create table public.users (id integer not null, name text not null);
      create view public.names as select name from public.users;`;

    await expect(
      generateFrom(
        committed,
        defineDatabase({
          public: {
            users: defineTable((c) => ({
              id: c.integer().notNull(),
              full_name: c.varchar(40).notNull().renamedFrom("name"),
            })),
          },
        }),
      ),
    ).rejects.toThrow(
      "  table column public.users.full_name, which it retypes:\n    view public.names\n",
    );
  });
});
