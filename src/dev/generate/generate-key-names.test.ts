import { beforeEach, describe, expect, it } from "vitest";
import { useTestDatabase } from "../../adapters/postgres-js/test-database.test-helper.ts";
import { defineDatabase, defineTable } from "../../runtime/definition/index.ts";
import { writeMigration } from "../../runtime/internal/index.ts";
import { generate } from "./generate.ts";
import { filesIn, memoryFileSystem } from "./memory-file-system.test-helper.ts";

const db = useTestDatabase();

beforeEach(async () => {
  await db.driver.execute(
    "drop schema if exists smonn_db cascade; drop schema public cascade; create schema public;",
  );
});

const generateFrom = (
  definition: Parameters<typeof generate>[0]["definition"],
  fileSystem = memoryFileSystem(),
) =>
  generate({
    driver: db.driver,
    connect: db.connect,
    fileSystem,
    definition,
    migrations: "db/migrations",
  });

describe("explicit key names", () => {
  const definition = defineDatabase({
    public: {
      accounts: defineTable((c) => ({
        id: c.integer().primaryKey({ name: "pk_accounts" }),
        email: c.text().unique({ name: "uq_accounts_email" }),
      })),
      memberships: defineTable(
        (c) => ({ account_id: c.integer(), team_id: c.integer() }),
        (t) => ({ primaryKey: { name: "pk_memberships", columns: [t.account_id, t.team_id] } }),
      ),
    },
  });

  it("creates each key by its name and verifies the Shadow database matches", async () => {
    const result = await generateFrom(definition);

    expect(result.sql).toContain(`"pk_accounts" primary key ("id")`);
    expect(result.sql).toContain(`"uq_accounts_email" unique ("email")`);
    expect(result.sql).toContain(`"pk_memberships" primary key ("account_id", "team_id")`);
  });

  it("finds no difference from a Committed migration that names its keys the same", async () => {
    const fileSystem = memoryFileSystem({
      ...filesIn("db/migrations", [
        await writeMigration(
          "000001-create-tables.sql",
          undefined,
          `create table public.accounts (
  id integer constraint pk_accounts primary key,
  email text constraint uq_accounts_email unique
);
create table public.memberships (
  account_id integer,
  team_id integer,
  constraint pk_memberships primary key (account_id, team_id)
);
`,
        ),
      ]),
    });

    const result = await generateFrom(definition, fileSystem);

    expect(result).toStrictEqual({
      path: "db/migrations/current.sql",
      sql: undefined,
      reset: true,
      hazards: [],
    });
  });
});

describe("derived key names that collide", () => {
  it("fail before the Shadow database, naming both keys", async () => {
    const definition = defineDatabase({
      public: {
        orders: defineTable((c) => ({ item_id: c.text().unique() })),
        orders_item: defineTable((c) => ({ id: c.text().unique() })),
      },
    });

    await expect(generateFrom(definition)).rejects.toThrow(
      'the unique constraint on "public"."orders" ("item_id") and the unique constraint on "public"."orders_item" ("id") both take the constraint name "orders_item_id_key"',
    );
  });
});
